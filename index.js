const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const nodeFetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ====== DATABASE CONNECTION ======
// Use DATABASE_URL from Render environment
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Database connected successfully at:', result.rows[0].now);
  }
});

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

    const initSQL = `
      -- VelocityCRM Database Schema Initialization
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        org_id INTEGER,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(20),
        company VARCHAR(255),
        title VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        industry VARCHAR(100),
        size VARCHAR(50),
        website VARCHAR(255),
        billing_contact VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS candidates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(20),
        title VARCHAR(255),
        company VARCHAR(255),
        location VARCHAR(255),
        skills TEXT,
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS job_orders (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255),
        company VARCHAR(255),
        location VARCHAR(255),
        description TEXT,
        salary_min DECIMAL(10,2),
        salary_max DECIMAL(10,2),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER REFERENCES candidates(id),
        job_order_id INTEGER REFERENCES job_orders(id),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS placements (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id),
        start_date DATE,
        end_date DATE,
        fee_amount DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS contracts (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id),
        type VARCHAR(50),
        status VARCHAR(50),
        value DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (org_id, email, password_hash, name)
      VALUES (1, 'admin@peekenterprises.com', '$2b$10$YRLQ1f5PEFrJgey4ZYYmWe/1LZD0Q.xCIwsxEY0d3QwAwQBXx6QpG', 'Admin User')
      ON CONFLICT (email) DO NOTHING;

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);
      CREATE INDEX IF NOT EXISTS idx_job_orders_status ON job_orders(status);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    `;

    // Run initialization
    await pool.query(initSQL);
    console.log('✅ Tables and indexes created successfully!');

    // Verify tables
    const tablesResult = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const tables = tablesResult.rows.map(r => r.table_name);

    // Verify admin user
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

    // Query database for user
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Compare password with bcrypt hash
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ====== CRUD ROUTES ======

// CONTACTS
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
    const { name, email, phone, title, company, location, skills, source } = req.body;
    const result = await pool.query(
      'INSERT INTO candidates (name, email, phone, title, company, location, skills, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [name, email, phone, title, company, location, skills, source]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { title, company, location, description, salary_min, salary_max, status } = req.body;
    const result = await pool.query(
      'INSERT INTO job_orders (title, company, location, description, salary_min, salary_max, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [title, company, location, description, salary_min, salary_max, status]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { candidate_id, job_order_id, status } = req.body;
    const result = await pool.query(
      'INSERT INTO submissions (candidate_id, job_order_id, status) VALUES ($1, $2, $3) RETURNING *',
      [candidate_id, job_order_id, status]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { submission_id, start_date, end_date, fee_amount } = req.body;
    const result = await pool.query(
      'INSERT INTO placements (submission_id, start_date, end_date, fee_amount) VALUES ($1, $2, $3, $4) RETURNING *',
      [submission_id, start_date, end_date, fee_amount]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ====== FREE SOURCES ENDPOINT (PLACEHOLDER) ======
app.post('/api/candidates/search/free-sources', authenticateToken, async (req, res) => {
  try {
    const { query, sources } = req.body;
    
    // Placeholder response - ready for scraper integration
    const candidates = {
      jobvertise: [],
      craigslist: [],
      wellfound: [],
      postjobfree: [],
      total: 0
    };

    res.json({
      query,
      sources: sources || ['jobvertise', 'craigslist', 'wellfound', 'postjobfree'],
      candidates,
      message: 'Free sources endpoint ready for integration'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== APOLLO SEARCH ENDPOINT (PLACEHOLDER) ======
app.post('/api/candidates/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.body;
    
    // Placeholder response - ready for Apollo integration
    res.json({
      query,
      candidates: [],
      message: 'Apollo search endpoint ready for integration'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  console.log('🔍 Free Sources: Ready for integration');
  console.log('🛠️ Database Setup: GET /api/setup/init-db\n');
});
