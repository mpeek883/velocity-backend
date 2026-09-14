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
const { getApolloClient, isApolloConfigured, ApolloError } = require('./apollo-client');
const { sendEmail, isEmailConfigured, emailTransportName, textToHtml, FROM_EMAIL } = require('./email');
const { runAssistantChat, isAIConfigured: isAssistantConfigured } = require('./assistant');
const { buildCandidateProfile, markdownToHtml, isProfileAIConfigured } = require('./candidate-profile');
const leadScanner = require('./lead-scanner');
const leadWorkflow = require('./lead-workflow');
const contactsSync = require('./contacts-sync');
const leadAssignment = require('./lead-assignment');
const matching = require('./matching');

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

// Columns the app relies on for tables that may already exist in an older
// shape (the previous server created leads/opportunities/contacts/accounts
// with different columns). Applied as ADD COLUMN IF NOT EXISTS after the
// CREATE TABLE IF NOT EXISTS, so both fresh and legacy databases end up
// with every column the routes use.
const REQUIRED_COLUMNS = {
  leads: {
    name: 'VARCHAR(255)', title: 'VARCHAR(255)', company: 'VARCHAR(255)', company_address: 'TEXT', company_website: 'VARCHAR(255)',
    email: 'VARCHAR(255)', phone: 'VARCHAR(50)', linkedin: 'VARCHAR(255)', source: 'VARCHAR(100)', status: "VARCHAR(50) DEFAULT 'new'",
    territory: 'VARCHAR(100)', score: 'INTEGER', job_title: 'VARCHAR(255)', job_location: 'VARCHAR(255)', job_description: 'TEXT',
    rate_or_salary: 'VARCHAR(100)', notes: 'TEXT', mailbox: 'VARCHAR(255)', message_id: 'VARCHAR(512)', email_subject: 'VARCHAR(500)',
    email_received_at: 'TIMESTAMP', workflow_status: "VARCHAR(50) DEFAULT 'new'", end_client: 'VARCHAR(255)', employment_type: 'VARCHAR(50)',
    work_arrangement: 'VARCHAR(50)', missing_info: 'TEXT', reviewed_at: 'TIMESTAMP', replied_at: 'TIMESTAMP', last_inbound_at: 'TIMESTAMP',
    follow_up_due_at: 'TIMESTAMP', opportunity_id: 'TEXT', account_id: 'TEXT', origin: "VARCHAR(20) DEFAULT 'manual'",
    lead_no: 'INTEGER', assigned_to: 'TEXT', assigned_at: 'TIMESTAMP',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  opportunities: {
    name: 'VARCHAR(255)', account: 'VARCHAR(255)', account_id: 'TEXT', contact: 'VARCHAR(255)', contact_email: 'VARCHAR(255)', value: 'NUMERIC(12,2)',
    stage: "VARCHAR(50) DEFAULT 'Prospecting'", probability: 'INTEGER DEFAULT 20', close_date: 'DATE', type: "VARCHAR(50) DEFAULT 'New Business'",
    competitor: 'VARCHAR(255)', notes: 'TEXT', forecast_category: 'VARCHAR(50)', win_loss_reason: 'TEXT', job_title: 'VARCHAR(255)', job_description: 'TEXT',
    client_name: 'VARCHAR(255)', rate: 'VARCHAR(100)', work_location: 'VARCHAR(255)', work_arrangement: 'VARCHAR(50)', lead_id: 'TEXT',
    opportunity_no: 'INTEGER',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  accounts: { name: 'VARCHAR(255)', industry: 'VARCHAR(100)', size: 'VARCHAR(50)', website: 'VARCHAR(255)', billing_contact: 'VARCHAR(255)', account_no: 'INTEGER', created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
  contacts: {
    name: 'VARCHAR(255)', email: 'VARCHAR(255)', phone: 'VARCHAR(50)', company: 'VARCHAR(255)', title: 'VARCHAR(255)',
    contact_type: 'VARCHAR(20)', skills: 'TEXT', candidate_id: 'TEXT', lead_id: 'TEXT', account_id: 'TEXT', source: 'VARCHAR(100)', status: "VARCHAR(50) DEFAULT 'active'", score: 'INTEGER', notes: 'TEXT',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  users: { name: 'VARCHAR(255)', role: 'VARCHAR(50)', is_active: 'BOOLEAN DEFAULT TRUE', takes_leads: 'BOOLEAN DEFAULT TRUE', last_assigned_at: 'TIMESTAMP' },
};

// Human-visible record numbers (L-000012 / O-000004 / A-000009) so a lead, its
// opportunity, and the account can be referenced and cross-checked by eye.
const RECORD_NUMBERS = { leads: 'lead_no', opportunities: 'opportunity_no', accounts: 'account_no' };
async function assignRecordNumber(table, id) {
  const col = RECORD_NUMBERS[table];
  if (!col) return null;
  const q = await pool.query(
    `UPDATE ${table} SET ${col}=(SELECT COALESCE(MAX(${col}),0)+1 FROM ${table}) WHERE id::text=$1 AND ${col} IS NULL RETURNING *`, [String(id)]);
  return q.rows[0] || null;
}
async function backfillRecordNumbers() {
  for (const [table, col] of Object.entries(RECORD_NUMBERS)) {
    try {
      const rows = await pool.query(`SELECT id FROM ${table} WHERE ${col} IS NULL ORDER BY created_at, id`);
      for (const r of rows.rows) await assignRecordNumber(table, r.id);
    } catch (err) {
      console.error(`⚠️ Record numbering for ${table} failed:`, err.message);
    }
  }
}

async function logSchemaSummary() {
  try {
    const q = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position`,
      [['leads', 'opportunities', 'accounts', 'contacts', 'candidates', 'lead_emails', 'candidate_profiles', 'users', 'candidate_matches']]);
    const byTable = {};
    for (const r of q.rows) (byTable[r.table_name] = byTable[r.table_name] || []).push(`${r.column_name}:${r.data_type.replace('character varying', 'varchar').replace('timestamp without time zone', 'timestamp')}`);
    for (const [t, cols] of Object.entries(byTable)) console.log(`🗂️ ${t}: ${cols.join(', ')}`);
  } catch (err) {
    console.error('⚠️ Schema summary failed:', err.message);
  }
}

// Link columns must accept ids from either side whether the referenced table
// uses SERIAL integers (fresh databases) or UUIDs (the legacy Production
// tables). Any link column that is not already text is converted in place
// (values kept via ::text), dropping a same-named foreign key if one exists.
const LINK_COLUMNS = [
  ['leads', 'opportunity_id'], ['leads', 'account_id'], ['leads', 'assigned_to'],
  ['opportunities', 'lead_id'], ['opportunities', 'account_id'],
  ['contacts', 'candidate_id'], ['contacts', 'lead_id'], ['contacts', 'account_id'],
  ['lead_emails', 'lead_id'], ['email_scan_log', 'lead_id'],
  ['candidate_matches', 'target_id'], ['candidate_matches', 'candidate_id'],
];
async function reconcileLinkColumns() {
  const tables = [...new Set(LINK_COLUMNS.map(([t]) => t))];
  let q;
  try {
    q = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN (${tables.map((_, i) => `$${i + 1}`).join(', ')})`, tables);
  } catch (err) {
    console.error('⚠️ Link column check skipped:', err.message);
    return;
  }
  const types = new Map(q.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
  for (const [table, col] of LINK_COLUMNS) {
    const t = types.get(`${table}.${col}`);
    if (!t || t === 'text' || t === 'character varying') continue;
    try {
      // Drop any foreign key on this column first (its name may vary).
      try {
        const fks = await pool.query(
          `SELECT con.conname FROM pg_constraint con
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
            WHERE con.contype = 'f' AND con.conrelid = $1::regclass AND a.attname = $2`, [table, col]);
        for (const fk of fks.rows) await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${fk.conname}`);
      } catch { /* no catalog access (test db): fall through to the type change */ }
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE TEXT USING ${col}::text`);
      console.log(`🔗 ${table}.${col}: ${t} -> text`);
    } catch (err) {
      console.error(`⚠️ Could not convert ${table}.${col} (${t}) to text:`, err.message.split(String.fromCharCode(10))[0]);
    }
  }
}

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
    // Apollo job posting integration (Phase 4)
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS source VARCHAR(50)",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS url TEXT",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS apollo_job_id VARCHAR(64)",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS apollo_org_id VARCHAR(64)",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP",
    "ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP",
    // Candidate detail the Add Candidate form collects (feeds client profiles)
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin VARCHAR(255)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years INTEGER",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS work_auth VARCHAR(50)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS availability VARCHAR(50)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS availability_date DATE",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS desired_rate NUMERIC(10,2)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS desired_salary NUMERIC(12,2)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS resume_text TEXT",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS notes TEXT",
    // Leads (the app's Leads screen) + recruiter email scanning
    `CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      title VARCHAR(255),
      company VARCHAR(255),
      company_address TEXT,
      company_website VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      linkedin VARCHAR(255),
      source VARCHAR(100),
      status VARCHAR(50) DEFAULT 'new',
      territory VARCHAR(100),
      score INTEGER,
      job_title VARCHAR(255),
      job_location VARCHAR(255),
      job_description TEXT,
      rate_or_salary VARCHAR(100),
      notes TEXT,
      mailbox VARCHAR(255),
      message_id VARCHAR(512),
      email_subject VARCHAR(500),
      email_received_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      org_id INTEGER,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      industry VARCHAR(100),
      size VARCHAR(50),
      website VARCHAR(255),
      billing_contact VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      company VARCHAR(255),
      title VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // lead_id is TEXT so it works whether leads.id is SERIAL (fresh) or UUID (legacy).
    `CREATE TABLE IF NOT EXISTS lead_emails (
      id SERIAL PRIMARY KEY,
      lead_id TEXT,
      direction VARCHAR(10),
      kind VARCHAR(30),
      subject VARCHAR(500),
      body TEXT,
      message_id VARCHAR(512),
      from_email VARCHAR(255),
      to_email VARCHAR(255),
      analysis TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS opportunities (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      account VARCHAR(255),
      contact VARCHAR(255),
      contact_email VARCHAR(255),
      value NUMERIC(12,2),
      stage VARCHAR(50) DEFAULT 'Prospecting',
      probability INTEGER DEFAULT 20,
      close_date DATE,
      type VARCHAR(50) DEFAULT 'New Business',
      competitor VARCHAR(255),
      notes TEXT,
      forecast_category VARCHAR(50),
      win_loss_reason TEXT,
      job_title VARCHAR(255),
      job_description TEXT,
      client_name VARCHAR(255),
      rate VARCHAR(100),
      work_location VARCHAR(255),
      work_arrangement VARCHAR(50),
      lead_id TEXT,
      account_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS candidate_matches (
      id SERIAL PRIMARY KEY,
      target_kind VARCHAR(20),
      target_id TEXT,
      candidate_id TEXT,
      rank INTEGER,
      score INTEGER,
      deterministic_score INTEGER,
      ai_score INTEGER,
      breakdown TEXT,
      rationale TEXT,
      strengths TEXT,
      gaps TEXT,
      model VARCHAR(100),
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS email_scan_log (
      id SERIAL PRIMARY KEY,
      mailbox VARCHAR(255),
      message_id VARCHAR(512) UNIQUE,
      subject VARCHAR(500),
      from_email VARCHAR(255),
      received_at TIMESTAMP,
      classification VARCHAR(50),
      reason TEXT,
      lead_id TEXT,
      scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // Client-facing candidate profiles generated per submission
    `CREATE TABLE IF NOT EXISTS candidate_profiles (
      id SERIAL PRIMARY KEY,
      submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
      candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
      job_order_id INTEGER REFERENCES job_orders(id) ON DELETE SET NULL,
      redacted BOOLEAN NOT NULL DEFAULT TRUE,
      label VARCHAR(100),
      content TEXT,
      markdown TEXT,
      model VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // Legacy-safe: make sure every column the routes use exists on leads,
    // opportunities, accounts, contacts, users (no-ops on fresh databases).
    ...Object.entries(REQUIRED_COLUMNS).flatMap(([table, cols]) =>
      Object.entries(cols).map(([col, type]) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`)),
    "UPDATE leads SET origin='system' WHERE origin IS NULL AND message_id IS NOT NULL",
    "UPDATE leads SET origin='manual' WHERE origin IS NULL",
    "UPDATE contacts SET contact_type='Company' WHERE contact_type IS NULL",
  ];
  let failures = 0;
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      failures += 1;
      console.error('⚠️ Schema update failed:', sql.replace(/\s+/g, ' ').slice(0, 160), '-', err.message);
    }
  }
  console.log(failures ? `⚠️ Schema check complete with ${failures} failure(s)` : '✅ Schema check complete');
  await reconcileLinkColumns();
  await backfillRecordNumbers();
  try {
    const b = await contactsSync.backfillContacts(pool);
    if (b.candidates || b.leads) console.log('👥 Contacts synced:', JSON.stringify(b));
  } catch (err) {
    console.error('⚠️ Contacts backfill failed:', err.message);
  }
  await logSchemaSummary();
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

const CANDIDATE_COLS  = ['name', 'email', 'phone', 'title', 'company', 'location', 'skills', 'source', 'status',
                         'linkedin', 'experience_years', 'work_auth', 'availability', 'availability_date', 'desired_rate', 'desired_salary', 'resume_text', 'notes'];
const JOB_ORDER_COLS  = ['title', 'company', 'location', 'description', 'salary_min', 'salary_max', 'salary_range', 'status',
                         'source', 'url', 'apollo_job_id', 'apollo_org_id', 'posted_at', 'last_seen_at', 'last_synced_at'];
const SUBMISSION_COLS = ['candidate_id', 'job_order_id', 'status', 'notes'];
const LEAD_COLS       = ['name', 'title', 'company', 'company_address', 'company_website', 'email', 'phone', 'linkedin', 'source', 'status', 'territory', 'score',
                         'job_title', 'job_location', 'job_description', 'rate_or_salary', 'notes',
                         'end_client', 'employment_type', 'work_arrangement', 'workflow_status'];
const OPP_COLS        = ['name', 'account', 'contact', 'contact_email', 'value', 'stage', 'probability', 'close_date', 'type', 'competitor', 'notes', 'forecast_category', 'win_loss_reason',
                         'job_title', 'job_description', 'client_name', 'rate', 'work_location', 'work_arrangement', 'lead_id'];
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
        linkedin VARCHAR(255),
        experience_years INTEGER,
        work_auth VARCHAR(50),
        availability VARCHAR(50),
        availability_date DATE,
        desired_rate NUMERIC(10,2),
        desired_salary NUMERIC(12,2),
        resume_text TEXT,
        notes TEXT,
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
        source VARCHAR(50),
        url TEXT,
        apollo_job_id VARCHAR(64),
        apollo_org_id VARCHAR(64),
        posted_at TIMESTAMP,
        last_seen_at TIMESTAMP,
        last_synced_at TIMESTAMP,
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

const CONTACT_COLS = ['name', 'email', 'phone', 'company', 'title', 'contact_type', 'skills', 'status', 'notes', 'source', 'score'];
app.post('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const body = { contact_type: 'Company', ...(req.body || {}) };
    if (Array.isArray(body.skills)) body.skills = contactsSync.skillsToText(body.skills);
    res.status(201).json(await insertRow('contacts', CONTACT_COLS, body));
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (Array.isArray(body.skills)) body.skills = contactsSync.skillsToText(body.skills);
    const row = await updateRow('contacts', CONTACT_COLS, req.params.id, body);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});
// Re-sync every candidate and lead into Contacts on demand.
app.post('/api/contacts/sync', authenticateToken, async (req, res) => {
  try { res.json(await contactsSync.backfillContacts(pool)); } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(201).json((await assignRecordNumber('accounts', result.rows[0].id)) || result.rows[0]);
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
    const row = await insertRow('candidates', CANDIDATE_COLS, req.body);
    contactsSync.syncContactFromCandidate(pool, row).catch((e) => console.error('⚠️ Contact sync (candidate) failed:', e.message));
    res.status(201).json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/candidates/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('candidates', CANDIDATE_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Candidate not found' });
    contactsSync.syncContactFromCandidate(pool, row).catch((e) => console.error('⚠️ Contact sync (candidate) failed:', e.message));
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

// ====== APOLLO.IO JOB DATA (Phase 4) ======
// Task 1: client (apollo-client.js). Task 2: company search, postings, import.
// Task 3: sync that refreshes imported postings and closes vanished ones.
const apolloSyncState = { last_run_at: null, last_result: null, running: false };
const APOLLO_SYNC_INTERVAL_MIN = parseInt(process.env.APOLLO_SYNC_INTERVAL_MIN || '240', 10);

function sendApolloError(res, err) {
  if (err instanceof ApolloError) return res.status(err.status).json({ error: err.message, code: err.code, retry_after: err.retryAfter });
  return res.status(500).json({ error: err.message });
}

app.get('/api/apollo/status', authenticateToken, async (req, res) => {
  try {
    const counts = await pool.query(
      "SELECT COALESCE(SUM(CASE WHEN source='apollo' THEN 1 ELSE 0 END),0) AS imported, COALESCE(SUM(CASE WHEN source='apollo' AND status<>'closed' THEN 1 ELSE 0 END),0) AS open FROM job_orders"
    );
    res.json({
      configured: isApolloConfigured(),
      sync_interval_minutes: APOLLO_SYNC_INTERVAL_MIN,
      last_sync: apolloSyncState.last_run_at,
      last_result: apolloSyncState.last_result,
      running: apolloSyncState.running,
      imported_job_orders: parseInt(counts.rows[0].imported, 10),
      open_apollo_job_orders: parseInt(counts.rows[0].open, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apollo/companies', authenticateToken, async (req, res) => {
  try {
    const result = await getApolloClient().searchOrganizations(req.query.q, { page: parseInt(req.query.page || '1', 10), perPage: 10 });
    res.json(result);
  } catch (err) {
    sendApolloError(res, err);
  }
});

app.get('/api/apollo/companies/:id/jobs', authenticateToken, async (req, res) => {
  try {
    const { postings } = await getApolloClient().getJobPostings(req.params.id, { page: parseInt(req.query.page || '1', 10), perPage: 100 });
    const ids = postings.map((p) => p.id).filter(Boolean);
    let imported = new Set();
    if (ids.length) {
      const existing = await pool.query('SELECT apollo_job_id, id, status FROM job_orders WHERE apollo_job_id = ANY($1)', [ids]);
      imported = new Map(existing.rows.map((r) => [r.apollo_job_id, { id: r.id, status: r.status }]));
    }
    res.json({ postings: postings.map((p) => ({ ...p, imported: imported.get ? imported.get(p.id) || null : null })) });
  } catch (err) {
    sendApolloError(res, err);
  }
});

app.post('/api/apollo/import-jobs', authenticateToken, async (req, res) => {
  try {
    const { organization_id, organization_name, postings } = req.body || {};
    if (!organization_id || !Array.isArray(postings) || !postings.length) {
      return res.status(400).json({ error: 'organization_id and a non-empty postings array are required' });
    }
    const created = [];
    const skipped = [];
    for (const p of postings) {
      if (!p || !p.id || !p.title) { skipped.push({ id: p && p.id, reason: 'missing id or title' }); continue; }
      const dup = await pool.query('SELECT id FROM job_orders WHERE apollo_job_id=$1', [String(p.id)]);
      if (dup.rows.length) { skipped.push({ id: p.id, reason: 'already imported', job_order_id: dup.rows[0].id }); continue; }
      const row = await insertRow('job_orders', JOB_ORDER_COLS, {
        title: p.title,
        company: organization_name || p.company || '',
        location: p.location || [p.city, p.state, p.country].filter(Boolean).join(', '),
        description: p.url ? `Imported from Apollo. Original posting: ${p.url}` : 'Imported from Apollo.',
        status: 'open',
        source: 'apollo',
        url: p.url || null,
        apollo_job_id: String(p.id),
        apollo_org_id: String(organization_id),
        posted_at: p.posted_at || null,
        last_seen_at: p.last_seen_at || null,
        last_synced_at: new Date().toISOString(),
      });
      created.push(row);
    }
    res.status(201).json({ created, skipped });
  } catch (err) {
    sendDbError(res, err);
  }
});

// Task 3: refresh every imported, still-open job order against Apollo.
// Costs one Apollo credit per company checked. Postings that Apollo no longer
// lists are marked closed. Safe to run repeatedly; no-op when nothing to check.
async function syncApolloJobOrders(client = getApolloClient()) {
  if (apolloSyncState.running) return { skipped: true, reason: 'sync already running' };
  apolloSyncState.running = true;
  const summary = { orgs_checked: 0, refreshed: 0, closed: 0, errors: [], started_at: new Date().toISOString() };
  try {
    const open = await pool.query("SELECT id, apollo_job_id, apollo_org_id FROM job_orders WHERE source='apollo' AND apollo_org_id IS NOT NULL AND status<>'closed'");
    const byOrg = new Map();
    for (const r of open.rows) {
      if (!byOrg.has(r.apollo_org_id)) byOrg.set(r.apollo_org_id, []);
      byOrg.get(r.apollo_org_id).push(r);
    }
    for (const [orgId, rows] of byOrg) {
      try {
        const { postings } = await client.getJobPostings(orgId, { perPage: 500 });
        summary.orgs_checked += 1;
        const live = new Map(postings.map((p) => [String(p.id), p]));
        const now = new Date().toISOString();
        for (const r of rows) {
          const p = live.get(String(r.apollo_job_id));
          if (p) {
            await pool.query('UPDATE job_orders SET last_seen_at=$1, url=COALESCE($2,url), last_synced_at=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4',
              [p.last_seen_at || now, p.url || null, now, r.id]);
            summary.refreshed += 1;
          } else {
            await pool.query("UPDATE job_orders SET status='closed', last_synced_at=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [now, r.id]);
            summary.closed += 1;
          }
        }
      } catch (err) {
        summary.errors.push({ organization_id: orgId, error: err.message });
        if (err instanceof ApolloError && (err.code === 'APOLLO_RATE_LIMIT' || err.code === 'APOLLO_NO_CREDITS' || err.code === 'APOLLO_AUTH')) break;
      }
    }
  } catch (err) {
    summary.errors.push({ error: err.message });
  } finally {
    summary.finished_at = new Date().toISOString();
    apolloSyncState.running = false;
    apolloSyncState.last_run_at = summary.finished_at;
    apolloSyncState.last_result = summary;
  }
  return summary;
}

app.post('/api/apollo/sync', authenticateToken, async (req, res) => {
  try {
    if (!isApolloConfigured()) return res.status(503).json({ error: 'Apollo is not configured (APOLLO_API_KEY missing)', code: 'APOLLO_NOT_CONFIGURED' });
    res.json(await syncApolloJobOrders());
  } catch (err) {
    sendApolloError(res, err);
  }
});

function startApolloSyncScheduler() {
  if (!isApolloConfigured() || !(APOLLO_SYNC_INTERVAL_MIN > 0) || process.env.NODE_ENV === 'test') return;
  const ms = APOLLO_SYNC_INTERVAL_MIN * 60 * 1000;
  const timer = setInterval(() => {
    syncApolloJobOrders().then((s) => console.log('🔄 Apollo sync:', JSON.stringify(s))).catch((e) => console.error('⚠️ Apollo sync failed:', e.message));
  }, ms);
  if (timer.unref) timer.unref();
  console.log(`🔄 Apollo job sync scheduled every ${APOLLO_SYNC_INTERVAL_MIN} min`);
}

// Authenticated schema report (tables + columns) for diagnostics.
app.get('/api/admin/schema', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
    const tables = {};
    for (const r of q.rows) (tables[r.table_name] = tables[r.table_name] || []).push({ column: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', default: r.column_default });
    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== LEADS + RECRUITER EMAIL SCANNING ======
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// After a lead is created (manually or by the scanner): number it, assign it
// fairly, and mirror the recruiter into Contacts.
async function afterLeadCreated(row, { assignTo } = {}) {
  let lead = row;
  try { lead = (await assignRecordNumber('leads', lead.id)) || lead; } catch (e) { console.error('⚠️ Lead numbering failed:', e.message); }
  try { const a = await leadAssignment.assignLead(pool, lead, assignTo || null); if (a.lead) lead = a.lead; } catch (e) { console.error('⚠️ Lead assignment failed:', e.message); }
  try { await contactsSync.syncContactFromLead(pool, lead); } catch (e) { console.error('⚠️ Contact sync (lead) failed:', e.message); }
  return lead;
}
leadScanner.onLeadCreated = (row) => afterLeadCreated(row);
leadScanner.onLeadUpdated = (row) => contactsSync.syncContactFromLead(pool, row).catch(() => {});
leadWorkflow.onLeadUpdated = (row) => contactsSync.syncContactFromLead(pool, row).catch(() => {});

app.post('/api/leads', authenticateToken, async (req, res) => {
  try {
    const { assigned_to, ...body } = req.body || {};
    const row = await insertRow('leads', LEAD_COLS, body);
    res.status(201).json(await afterLeadCreated(row, { assignTo: assigned_to }));
  } catch (err) { sendDbError(res, err); }
});
app.put('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { assigned_to, ...body } = req.body || {};
    let row = Object.keys(body).length ? await updateRow('leads', LEAD_COLS, req.params.id, body) : await loadLead(req.params.id);
    if (!row) return res.status(404).json({ error: 'Lead not found' });
    if (assigned_to !== undefined && String(assigned_to || '') !== String(row.assigned_to || '')) {
      row = assigned_to ? (await leadAssignment.assignLead(pool, row, assigned_to)).lead
        : (await pool.query('UPDATE leads SET assigned_to=NULL, assigned_at=NULL WHERE id::text=$1 RETURNING *', [String(row.id)])).rows[0];
    }
    contactsSync.syncContactFromLead(pool, row).catch(() => {});
    res.json(row);
  } catch (err) { sendDbError(res, err); }
});

// Team + assignment
app.get('/api/users', authenticateToken, async (req, res) => {
  try { res.json(await leadAssignment.listTeam(pool)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const allowed = ['name', 'role', 'is_active', 'takes_leads'];
    const fields = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No valid fields' });
    const cols = Object.keys(fields);
    const q = await pool.query(`UPDATE users SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')} WHERE id::text=$${cols.length + 1} RETURNING id, email, name, role, is_active, takes_leads, last_assigned_at`, [...cols.map((c) => fields[c]), String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/leads/:id/assign', authenticateToken, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const r = await leadAssignment.assignLead(pool, lead, (req.body && req.body.user_id) || null);
    res.json({ lead: r.lead, assigned_to_user: r.user, reason: r.reason || null });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
app.post('/api/leads/assign-unassigned', authenticateToken, async (req, res) => {
  try { res.json(await leadAssignment.assignUnassigned(pool)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('leads', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Lead not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { sendDbError(res, err); }
});

const leadScanState = { running: false, last_run_at: null, last_result: null };
const LEAD_SCAN_INTERVAL_MIN = parseInt(process.env.LEAD_SCAN_INTERVAL_MIN || '60', 10);

app.get('/api/leads/scan/status', authenticateToken, async (req, res) => {
  try {
    const counts = await pool.query("SELECT COUNT(*) AS scanned, SUM(CASE WHEN classification='recruiter_lead' THEN 1 ELSE 0 END) AS leads FROM email_scan_log");
    res.json({
      mailboxes: leadScanner.publicMailboxes(),
      ai_configured: leadScanner.isLeadAIConfigured(),
      scan_interval_minutes: LEAD_SCAN_INTERVAL_MIN,
      running: leadScanState.running,
      last_run_at: leadScanState.last_run_at,
      last_result: leadScanState.last_result,
      messages_scanned_total: parseInt(counts.rows[0].scanned, 10) || 0,
      recruiter_leads_total: parseInt(counts.rows[0].leads, 10) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function runLeadScan(opts = {}) {
  if (leadScanState.running) return { skipped: true, reason: 'scan already running' };
  leadScanState.running = true;
  try {
    const result = await leadScanner.scanMailboxes({ pool, ...opts });
    leadScanState.last_run_at = result.finished_at;
    leadScanState.last_result = result;
    return result;
  } finally {
    leadScanState.running = false;
  }
}

app.post('/api/leads/scan', authenticateToken, async (req, res) => {
  try {
    if (!leadScanner.isLeadAIConfigured()) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)', code: 'AI_NOT_CONFIGURED' });
    const boxes = leadScanner.listMailboxes();
    if (!boxes.length) return res.status(503).json({ error: 'No mailboxes configured. Set GRAPH_SCAN_MAILBOXES and/or GMAIL_USER+GMAIL_APP_PASSWORD, VERIZON_USER+VERIZON_APP_PASSWORD, or IMAP_MAILBOXES.', code: 'NO_MAILBOXES' });
    const { days, max, mailbox } = req.body || {};
    const selected = mailbox ? boxes.filter((b) => b.address.toLowerCase() === String(mailbox).toLowerCase()) : boxes;
    if (!selected.length) return res.status(404).json({ error: `Mailbox ${mailbox} is not configured` });
    res.json(await runLeadScan({ mailboxes: selected, days, max }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Reply workflow: review -> AI draft -> send -> replies / follow-ups ----
async function loadLead(id) {
  const q = await pool.query('SELECT * FROM leads WHERE id=$1', [id]);
  return q.rows[0] || null;
}

app.post('/api/leads/:id/review', authenticateToken, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const draft = await leadWorkflow.draftOfferReply(lead);
    const updated = await leadWorkflow.setLead(pool, lead.id, {
      workflow_status: ['new', 'reviewed'].includes(lead.workflow_status || 'new') ? 'reviewed' : lead.workflow_status,
      reviewed_at: lead.reviewed_at || new Date(),
      missing_info: JSON.stringify(draft.missing.map((m) => m.key)),
    });
    res.json({ lead: updated, draft: { subject: draft.subject, body: draft.body, model: draft.model }, missing: draft.missing });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

app.post('/api/leads/:id/reply', authenticateToken, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const { subject, body } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
    const missing = leadWorkflow.missingInfo(lead);
    const result = await leadWorkflow.sendLeadEmail(pool, lead, {
      kind: 'offer_reply', subject, body,
      status: missing.length ? 'awaiting_info' : 'replied',
      extra: { missing_info: JSON.stringify(missing.map((m) => m.key)) },
    });
    res.json({ ok: true, transport: result.transport, lead: result.lead, missing });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

app.post('/api/leads/:id/close-out', authenticateToken, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const mail = leadWorkflow.closeOutEmail(lead);
    const result = await leadWorkflow.sendLeadEmail(pool, lead, { kind: 'close_out', ...mail, status: (req.body && req.body.status) || 'declined' });
    res.json({ ok: true, transport: result.transport, lead: result.lead });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

app.get('/api/leads/:id/emails', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM lead_emails WHERE lead_id=$1 ORDER BY created_at, id', [req.params.id]);
    res.json(q.rows.map((r) => ({ ...r, analysis: r.analysis ? JSON.parse(r.analysis) : null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate/record an inbound reply without scanning (used for testing and for
// pasting a reply that arrived elsewhere).
app.post('/api/leads/:id/inbound', authenticateToken, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const { subject, text, message_id } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });
    const outcome = await leadWorkflow.handleInboundReply(pool, lead, { subject: subject || `Re: ${lead.email_subject || ''}`, text, message_id: message_id || null, from_email: lead.email });
    res.json(outcome);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

app.post('/api/leads/workflow/run', authenticateToken, async (req, res) => {
  try {
    res.json(await leadWorkflow.processFollowUps(pool, { now: (req.body && req.body.now) ? new Date(req.body.now) : new Date() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OPPORTUNITIES (the app's Opportunities screen; also created by the workflow)
app.get('/api/opportunities', authenticateToken, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM opportunities ORDER BY created_at DESC')).rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/opportunities', authenticateToken, async (req, res) => {
  try {
    const row = await insertRow('opportunities', OPP_COLS, req.body);
    res.status(201).json((await assignRecordNumber('opportunities', row.id)) || row);
  } catch (err) { sendDbError(res, err); }
});

// ---- AI candidate matching ----
async function runMatch(targetKind, id, body = {}) {
  let target;
  if (targetKind === 'opportunity') {
    const q = await pool.query('SELECT * FROM opportunities WHERE id::text=$1', [String(id)]);
    if (!q.rows.length) return null;
    target = matching.targetFromOpportunity(q.rows[0]);
  } else {
    const q = await pool.query('SELECT * FROM job_orders WHERE id::text=$1', [String(id)]);
    if (!q.rows.length) return null;
    target = matching.targetFromJobOrder(q.rows[0]);
  }
  const results = await matching.rankCandidates({ pool, target, limit: body.limit || 10, aiTop: body.ai_top ?? 5, useAI: body.use_ai !== false });
  await matching.storeMatches(pool, target, results);
  return { target: { kind: target.kind, id: target.id, title: target.title }, matches: results, ai_used: results.some((r) => r.ai_score != null), computed_at: new Date().toISOString() };
}
async function readMatches(targetKind, id) {
  const q = await pool.query('SELECT * FROM candidate_matches WHERE target_kind=$1 AND target_id=$2 ORDER BY rank', [targetKind, String(id)]);
  if (!q.rows.length) return null;
  const ids = q.rows.map((r) => r.candidate_id);
  const cands = await pool.query('SELECT id, name, title, location, skills, availability FROM candidates WHERE id::text = ANY($1)', [ids]);
  const byId = new Map(cands.rows.map((c) => [String(c.id), c]));
  return {
    computed_at: q.rows[0].computed_at,
    matches: q.rows.map((r) => ({
      candidate_id: r.candidate_id, candidate_name: (byId.get(r.candidate_id) || {}).name, candidate_title: (byId.get(r.candidate_id) || {}).title,
      candidate_location: (byId.get(r.candidate_id) || {}).location, candidate_skills: (byId.get(r.candidate_id) || {}).skills,
      rank: r.rank, score: r.score, deterministic_score: r.deterministic_score, ai_score: r.ai_score,
      breakdown: r.breakdown ? JSON.parse(r.breakdown) : null,
      ai: r.rationale || r.strengths || r.gaps ? { rationale: r.rationale, strengths: r.strengths ? JSON.parse(r.strengths) : [], gaps: r.gaps ? JSON.parse(r.gaps) : [], model: r.model } : null,
    })),
  };
}
for (const [kind, base] of [['opportunity', '/api/opportunities'], ['job_order', '/api/job-orders']]) {
  app.post(`${base}/:id/match`, authenticateToken, async (req, res) => {
    try {
      const out = await runMatch(kind, req.params.id, req.body || {});
      if (!out) return res.status(404).json({ error: 'Not found' });
      res.json(out);
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });
  app.get(`${base}/:id/matches`, authenticateToken, async (req, res) => {
    try {
      const out = await readMatches(kind, req.params.id);
      if (!out) return res.status(404).json({ error: 'No matches computed yet' });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
app.put('/api/opportunities/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('opportunities', OPP_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(row);
  } catch (err) { sendDbError(res, err); }
});
app.delete('/api/opportunities/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await deleteRow('opportunities', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Opportunity not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { sendDbError(res, err); }
});

function startLeadScanScheduler() {
  if (!(LEAD_SCAN_INTERVAL_MIN > 0) || process.env.NODE_ENV === 'test' || !leadScanner.isLeadAIConfigured()) return;
  const hasMailboxes = leadScanner.listMailboxes().length > 0;
  const timer = setInterval(async () => {
    try {
      if (hasMailboxes) {
        const s = await runLeadScan();
        console.log('📬 Lead scan:', JSON.stringify({ created: s.leads_created, updated: s.leads_updated, replies: s.replies_handled || 0, scanned: s.messages_scanned, errors: (s.mailboxes || []).flatMap((m) => m.errors).length }));
      }
      const f = await leadWorkflow.processFollowUps(pool);
      if (f.checked) console.log('📬 Lead follow-ups:', JSON.stringify(f));
    } catch (e) {
      console.error('⚠️ Lead scan/follow-up failed:', e.message);
    }
  }, LEAD_SCAN_INTERVAL_MIN * 60 * 1000);
  if (timer.unref) timer.unref();
  console.log(`📬 Lead workflow scheduled every ${LEAD_SCAN_INTERVAL_MIN} min${hasMailboxes ? ` (scanning ${leadScanner.listMailboxes().map((b) => b.address).join(', ')})` : ' (follow-ups only; no mailboxes configured)'}`);
}

// ====== EMAIL AUTOMATION (Phase 5, Task 4) ======
// Backs the app's Email Templates (candidate outreach), Smart Paste / Email
// Scanner extraction (via the AI chat route), NDA send, and interview reminders.

function sendMailError(res, err) {
  res.status(err.status || 502).json({ error: err.message, code: err.code });
}

app.get('/api/email/status', authenticateToken, (req, res) => {
  res.json({ configured: isEmailConfigured(), transport: emailTransportName(), from: FROM_EMAIL });
});

// Generic send: { to, subject, body (plain text) | html }
app.post('/api/email/send', authenticateToken, async (req, res) => {
  try {
    const { to, subject, body, html } = req.body || {};
    const result = await sendEmail({ to, subject, html, text: body });
    res.json({ ok: true, ...result });
  } catch (err) {
    sendMailError(res, err);
  }
});

// NDA / cover-note send used by the app's candidate email modal and NDA workflow.
// Sends the cover note and records a contract row so the send is tracked.
app.post('/api/nda/send', authenticateToken, async (req, res) => {
  try {
    const { deal_name, deal_value, client_company, client_signatory, signer_email, cover_note, subject, record_contract = true } = req.body || {};
    if (!signer_email) return res.status(400).json({ error: 'Signer email required' });
    const signerFirst = (client_signatory || '').split(' ')[0] || 'Team';
    const emailBody = cover_note || `Dear ${signerFirst},\n\nPlease find attached a Mutual NDA from Peek IT Services for your review in connection with ${deal_name || 'our engagement'}.\n\nBest regards,\nPeek IT Services`;
    const result = await sendEmail({
      to: signer_email,
      subject: subject || `Mutual NDA for Review - ${deal_name || client_company || 'Peek IT Services'}`,
      html: textToHtml(emailBody),
      text: emailBody,
    });
    let contract = null;
    if (record_contract) {
      const value = parseFloat(String(deal_value || '').replace(/[^0-9.]/g, '')) || null;
      const ins = await pool.query(
        'INSERT INTO contracts (type, status, value) VALUES ($1, $2, $3) RETURNING *',
        ['nda-mutual', 'Under Review', value]
      );
      contract = ins.rows[0];
    }
    res.json({ ok: true, ...result, contract });
  } catch (err) {
    sendMailError(res, err);
  }
});

// Interview reminder to a submitted candidate.
app.post('/api/submissions/:id/remind', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT s.id, s.status, c.name AS candidate_name, c.email AS candidate_email, j.title AS job_title, j.company AS company
       FROM submissions s
       LEFT JOIN candidates c ON c.id = s.candidate_id
       LEFT JOIN job_orders j ON j.id = s.job_order_id
       WHERE s.id = $1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Submission not found' });
    const s = q.rows[0];
    const { to, message } = req.body || {};
    const recipient = to || s.candidate_email;
    if (!recipient) return res.status(400).json({ error: 'Candidate has no email address; pass "to" explicitly' });
    const first = (s.candidate_name || 'there').split(' ')[0];
    const text = `Hi ${first},\n\n${message || `This is a reminder about your upcoming interview for the ${s.job_title || 'open'} role${s.company ? ` at ${s.company}` : ''}. Please reach out if you have any questions.`}\n\nBest regards,\nPeek IT Services`;
    const result = await sendEmail({
      to: recipient,
      subject: `Interview Reminder - ${s.job_title || 'Your submission'}${s.company ? ` at ${s.company}` : ''} | Peek IT`,
      text,
    });
    res.json({ ok: true, ...result, to: recipient });
  } catch (err) {
    sendMailError(res, err);
  }
});

// ====== CLIENT-FACING CANDIDATE PROFILES (per submission) ======
// Redacted by default: identifying details never reach the model and are
// scrubbed from the output. Pass { redacted: false } for a named version.

async function loadSubmissionContext(id) {
  const s = await pool.query('SELECT * FROM submissions WHERE id=$1', [id]);
  if (!s.rows.length) return null;
  const sub = s.rows[0];
  const c = sub.candidate_id ? await pool.query('SELECT * FROM candidates WHERE id=$1', [sub.candidate_id]) : { rows: [] };
  const j = sub.job_order_id ? await pool.query('SELECT * FROM job_orders WHERE id=$1', [sub.job_order_id]) : { rows: [] };
  return { submission_id: sub.id, submission_status: sub.status, candidate: c.rows[0] || null, job_order: j.rows[0] || null };
}

app.get('/api/submissions/:id/profile', authenticateToken, async (req, res) => {
  try {
    const redacted = String(req.query.redacted ?? 'true') !== 'false';
    const q = await pool.query(
      'SELECT * FROM candidate_profiles WHERE submission_id=$1 AND redacted=$2 ORDER BY created_at DESC, id DESC LIMIT 1',
      [req.params.id, redacted]);
    if (!q.rows.length) return res.status(404).json({ error: 'No profile generated yet', redacted });
    const row = q.rows[0];
    res.json({ ...row, content: row.content ? JSON.parse(row.content) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submissions/:id/profile', authenticateToken, async (req, res) => {
  try {
    if (!isProfileAIConfigured()) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)', code: 'AI_NOT_CONFIGURED' });
    const redacted = (req.body && req.body.redacted === false) ? false : true;
    const ctx = await loadSubmissionContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Submission not found' });
    if (!ctx.candidate) return res.status(400).json({ error: 'Submission has no candidate' });

    const result = await buildCandidateProfile({ candidate: ctx.candidate, jobOrder: ctx.job_order, redacted });
    const ins = await pool.query(
      `INSERT INTO candidate_profiles (submission_id, candidate_id, job_order_id, redacted, label, content, markdown, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.submission_id, ctx.candidate.id, ctx.job_order ? ctx.job_order.id : null, redacted, result.label, JSON.stringify(result.profile), result.markdown, result.model]);
    const row = ins.rows[0];
    res.status(201).json({ ...row, content: result.profile });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

// Email the latest profile (redacted unless told otherwise) to a client contact.
app.post('/api/submissions/:id/profile/email', authenticateToken, async (req, res) => {
  try {
    const { to, subject, message, redacted: redactedFlag } = req.body || {};
    const redacted = redactedFlag === false ? false : true;
    if (!to) return res.status(400).json({ error: 'Recipient email ("to") is required' });
    const q = await pool.query(
      'SELECT * FROM candidate_profiles WHERE submission_id=$1 AND redacted=$2 ORDER BY created_at DESC, id DESC LIMIT 1',
      [req.params.id, redacted]);
    if (!q.rows.length) return res.status(404).json({ error: 'No profile generated yet; generate it first' });
    const p = q.rows[0];
    const intro = message ? `<p>${textToHtml(message)}</p><hr/>` : '';
    const result = await sendEmail({
      to,
      subject: subject || `Candidate Profile: ${p.label}`,
      html: `${intro}${markdownToHtml(p.markdown)}`,
      text: `${message ? message + '\n\n---\n\n' : ''}${p.markdown}`,
    });
    res.json({ ok: true, ...result, profile_id: p.id, redacted });
  } catch (err) {
    sendMailError(res, err);
  }
});

// AI assistant + Smart Paste extraction: { message, module, userRole, history } -> { response }
app.post('/api/ai/chat', authenticateToken, async (req, res) => {
  try {
    if (!isAssistantConfigured()) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)', code: 'AI_NOT_CONFIGURED' });
    const result = await runAssistantChat(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'AI request failed', code: err.code });
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
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    ai: isAssistantConfigured(),
    email: emailTransportName(),
    apollo: isApolloConfigured(),
  });
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
  startApolloSyncScheduler();
  startLeadScanScheduler();
});

module.exports = { app, syncApolloJobOrders };
