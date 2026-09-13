const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const FreeSourcesScraper = require('./free-sources-scraper');
const multer = require('multer');
const { extractText, parseResumeText } = require('./resume-parser');
const { extractCandidateWithAI, isAIConfigured } = require('./resume-ai');

// Resume uploads are held in memory (never written to disk) and capped at 5 MB.
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ====== DATABASE CONNECTION ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Additive schema updates so existing databases pick up columns the frontend
// panels use. Each statement is idempotent (ADD COLUMN IF NOT EXISTS).
async function ensureSchema() {
  const statements = [
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS salary_range VARCHAR(100)",
    "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS notes TEXT",
    "ALTER TABLE placements ADD COLUMN IF NOT EXISTS candidate_id INTEGER REFERENCES candidates(id)",
    "ALTER TABLE placements ADD COLUMN IF NOT EXISTS job_order_id INTEGER REFERENCES job_orders(id)",
    "ALTER TABLE placements ADD COLUMN IF NOT EXISTS placement_status VARCHAR(50) DEFAULT 'active'",
  ];
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('⚠️ Schema update failed:', sql, '-', err.message);
    }
  }
  console.log('✅ Schema check complete');
}

pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Database connected successfully at:', result.rows[0].now);
    ensureSchema();
  }
});

// ====== GENERIC ROW HELPERS ======
// Build INSERT/UPDATE statements from an allowlist of real columns, so extra
// fields sent by different frontends are ignored instead of causing errors.
// Empty strings become NULL so numeric and date columns accept blank inputs.
function pickColumns(body, allowed) {
  const cols = [];
  const vals = [];
  for (const col of allowed) {
    if (body && Object.prototype.hasOwnProperty.call(body, col)) {
      cols.push(col);
      const v = body[col];
      // Arrays (e.g. a skills list from the app) go into TEXT columns as
      // comma-separated text, not as a Postgres array literal like "{a,b}".
      vals.push(v === '' ? null : Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).join(', ') : v);
    }
  }
  return { cols, vals };
}

async function insertRow(table, allowed, body) {
  const { cols, vals } = pickColumns(body, allowed);
  if (!cols.length) throw Object.assign(new Error('No valid fields provided'), { status: 400 });
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const result = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  return result.rows[0];
}

async function updateRow(table, allowed, id, body) {
  const { cols, vals } = pickColumns(body, allowed);
  if (!cols.length) throw Object.assign(new Error('No valid fields provided'), { status: 400 });
  const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
  const result = await pool.query(
    `UPDATE ${table} SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`,
    [...vals, id]
  );
  return result.rows[0] || null;
}

async function deleteRow(table, id) {
  const result = await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  return result.rowCount > 0;
}

function sendDbError(res, err) {
  if (err.code === '23503' || /violates foreign key constraint/i.test(err.message || '')) {
    return res.status(409).json({ error: 'This record is linked to other records (for example submissions or placements) and cannot be deleted.' });
  }
  res.status(err.status || 500).json({ error: err.message });
}

const CANDIDATE_COLS  = ['name', 'email', 'phone', 'title', 'company', 'location', 'skills', 'source', 'status'];
const JOB_ORDER_COLS  = ['title', 'company', 'location', 'description', 'salary_min', 'salary_max', 'salary_range', 'status'];
const SUBMISSION_COLS = ['candidate_id', 'job_order_id', 'status', 'notes'];
const PLACEMENT_COLS  = ['submission_id', 'candidate_id', 'job_order_id', 'start_date', 'end_date', 'fee_amount', 'placement_status'];

// ====== MIDDLEWARE ======
app.use(helmet());
app.use(cors());
app.use(express.json());

// ====== JWT AUTHENTICATION MIDDLEWARE ======
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ====== SETUP ROUTES (NO AUTH REQUIRED) ======
app.get('/api/setup/init-db', async (req, res) => {
  try {
    console.log('🚀 Starting database initialization...');

    const dropSQL = `
      DROP TABLE IF EXISTS placements CASCADE;
      DROP TABLE IF EXISTS submissions CASCADE;
      DROP TABLE IF EXISTS contracts CASCADE;
      DROP TABLE IF EXISTS job_orders CASCADE;
      DROP TABLE IF EXISTS candidates CASCADE;
      DROP TABLE IF EXISTS accounts CASCADE;
      DROP TABLE IF EXISTS contacts CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `;
    await pool.query(dropSQL);
    console.log('✅ Old tables dropped');

    const createSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        org_id INTEGER,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(20),
        company VARCHAR(255),
        title VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        industry VARCHAR(100),
        size VARCHAR(50),
        website VARCHAR(255),
        billing_contact VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE candidates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(20),
        title VARCHAR(255),
        company VARCHAR(255),
        location VARCHAR(255),
        skills TEXT,
        source VARCHAR(100),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE job_orders (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255),
        company VARCHAR(255),
        location VARCHAR(255),
        description TEXT,
        salary_min DECIMAL(10,2),
        salary_max DECIMAL(10,2),
        salary_range VARCHAR(100),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE submissions (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER REFERENCES candidates(id),
        job_order_id INTEGER REFERENCES job_orders(id),
        status VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE placements (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id),
        candidate_id INTEGER REFERENCES candidates(id),
        job_order_id INTEGER REFERENCES job_orders(id),
        start_date DATE,
        end_date DATE,
        fee_amount DECIMAL(10,2),
        placement_status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE contracts (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id),
        type VARCHAR(50),
        status VARCHAR(50),
        value DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_users_email ON users(email);
      CREATE INDEX idx_candidates_email ON candidates(email);
      CREATE INDEX idx_job_orders_status ON job_orders(status);
      CREATE INDEX idx_submissions_status ON submissions(status);
    `;
    await pool.query(createSQL);
    console.log('✅ Tables created successfully!');

    await pool.query(
      `INSERT INTO users (org_id, email, password_hash, name) 
       VALUES ($1, $2, $3, $4)`,
      [1, 'admin@peekenterprises.com', '$2b$10$YRLQ1f5PEFrJgey4ZYYmWe/1LZD0Q.xCIwsxEY0d3QwAwQBXx6QpG', 'Admin User']
    );
    console.log('✅ Admin user created');

    const tablesResult = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const tables = tablesResult.rows.map(r => r.table_name);

    const userResult = await pool.query(
      "SELECT id, email, name FROM users WHERE email = 'admin@peekenterprises.com'"
    );

    res.json({
      status: 'success',
      message: 'Database initialized successfully',
      tables_created: tables,
      admin_user: userResult.rows[0] || null,
      credentials: {
        email: 'admin@peekenterprises.com',
        password: 'R0ll3r1!'
      }
    });
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    res.status(500).json({ 
      status: 'error',
      error: err.message 
    });
  }
});

// ====== AUTH ROUTES ======
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ====== CRUD ROUTES ======
app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company, title } = req.body;
    const result = await pool.query(
      'INSERT INTO contacts (name, email, phone, company, title) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, email, phone, company, title]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, company, title } = req.body;
    const result = await pool.query(
      'UPDATE contacts SET name=$1, email=$2, phone=$3, company=$4, title=$5 WHERE id=$6 RETURNING *',
      [name, email, phone, company, title, id]
    );
    res.json(result.rows[0] || { error: 'Not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM contacts WHERE id=$1', [id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ACCOUNTS
app.get('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const { name, industry, size, website, billing_contact } = req.body;
    const result = await pool.query(
      'INSERT INTO accounts (name, industry, size, website, billing_contact) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, industry, size, website, billing_contact]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CANDIDATES
app.get('/api/candidates', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM candidates ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/candidates', authenticateToken, async (req, res) => {
  try {
    res.status(201).json(await insertRow('candidates', CANDIDATE_COLS, req.body));
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/candidates/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('candidates', CANDIDATE_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Candidate not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.delete('/api/candidates/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('candidates', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    sendDbError(res, err);
  }
});

// Parse an uploaded resume (PDF, DOCX, or TXT) and return candidate fields
// for pre-filling the Add Candidate form. Multipart field name: "resume".
app.post('/api/candidates/parse-resume', authenticateToken, (req, res) => {
  resumeUpload.single('resume')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'Resume file is too large (max 5 MB).'
        : uploadErr.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No resume file uploaded. Send it as multipart field "resume".' });
    }
    try {
      const text = await extractText(req.file.buffer, req.file.originalname);
      if (!text.trim()) {
        return res.status(422).json({ error: 'Could not read any text from that file. If it is a scanned PDF, please use a text-based PDF or DOCX.' });
      }
      // Prefer AI extraction (handles any resume layout); fall back to the
      // rule-based parser when no API key is configured or the call fails.
      let fields;
      if (isAIConfigured()) {
        try {
          fields = await extractCandidateWithAI(text);
        } catch (aiErr) {
          console.error('⚠️ AI resume extraction failed, using rule-based parser:', aiErr.message);
          fields = { ...parseResumeText(text), parser: 'rules', ai_error: aiErr.message };
        }
      } else {
        fields = { ...parseResumeText(text), parser: 'rules' };
      }
      res.json({ ...fields, filename: req.file.originalname, text_length: text.length });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to parse resume' });
    }
  });
});

// JOB ORDERS
app.get('/api/job-orders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM job_orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/job-orders', authenticateToken, async (req, res) => {
  try {
    res.status(201).json(await insertRow('job_orders', JOB_ORDER_COLS, req.body));
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/job-orders/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('job_orders', JOB_ORDER_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Job order not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.delete('/api/job-orders/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('job_orders', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Job order not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    sendDbError(res, err);
  }
});

// SUBMISSIONS
app.get('/api/submissions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submissions', authenticateToken, async (req, res) => {
  try {
    res.status(201).json(await insertRow('submissions', SUBMISSION_COLS, req.body));
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/submissions/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('submissions', SUBMISSION_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.delete('/api/submissions/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('submissions', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Submission not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    sendDbError(res, err);
  }
});

// PLACEMENTS
app.get('/api/placements', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM placements ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/placements', authenticateToken, async (req, res) => {
  try {
    res.status(201).json(await insertRow('placements', PLACEMENT_COLS, req.body));
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/placements/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('placements', PLACEMENT_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Placement not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.delete('/api/placements/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('placements', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Placement not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    sendDbError(res, err);
  }
});

// CONTRACTS
app.get('/api/contracts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contracts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contracts', authenticateToken, async (req, res) => {
  try {
    const { account_id, type, status, value } = req.body;
    const result = await pool.query(
      'INSERT INTO contracts (account_id, type, status, value) VALUES ($1, $2, $3, $4) RETURNING *',
      [account_id, type, status, value]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== FREE SOURCES CANDIDATE SCRAPING ======
const scraper = new FreeSourcesScraper();

app.post('/api/candidates/search/free-sources', authenticateToken, async (req, res) => {
  try {
    const { query, sources } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    console.log(`\n🔍 Free Sources Search: "${query}"`);
    const results = await scraper.searchCandidates(query, sources);

    const candidatesList = [];
    Object.entries(results.sources).forEach(([source, candidates]) => {
      candidatesList.push(...candidates);
    });

    res.json({
      success: true,
      query: results.query,
      totalFound: results.totalCandidates,
      breakdown: results.breakdown,
      candidates: candidatesList,
      sources: Object.keys(results.sources),
      scrapedAt: results.timestamp
    });
  } catch (err) {
    console.error('❌ Free sources search error:', err);
    res.status(500).json({ 
      error: 'Free sources search failed',
      message: err.message 
    });
  }
});

app.get('/api/candidates/search/free-sources/status', (req, res) => {
  res.json({
    status: 'ready',
    availableSources: ['jobvertise', 'craigslist', 'wellfound', 'postjobfree'],
    endpoint: 'POST /api/candidates/search/free-sources',
    example: {
      query: 'javascript developer',
      sources: ['jobvertise', 'craigslist', 'wellfound', 'postjobfree']
    }
  });
});

// ====== DASHBOARD ENDPOINT ======
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const contacts = await pool.query('SELECT COUNT(*) FROM contacts');
    const candidates = await pool.query('SELECT COUNT(*) FROM candidates');
    const jobOrders = await pool.query('SELECT COUNT(*) FROM job_orders');
    const placements = await pool.query('SELECT COUNT(*) FROM placements');

    res.json({
      contacts: parseInt(contacts.rows[0].count),
      candidates: parseInt(candidates.rows[0].count),
      jobOrders: parseInt(jobOrders.rows[0].count),
      placements: parseInt(placements.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== HEALTH CHECK ======
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'VelocityCRM Backend API is running' });
});

// ====== ERROR HANDLERS ======
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`\n🚀 VelocityCRM Backend API listening on port ${PORT}`);
  console.log('📍 Environment:', process.env.NODE_ENV || 'development');
  console.log('🔐 Authentication: JWT enabled');
  console.log('🔍 Free Sources Scraping: ENABLED ✨');
  console.log('   - Jobvertise, Craigslist, Wellfound, PostJobFree');
  console.log('🛠️ Database Setup: GET /api/setup/init-db\n');
});
