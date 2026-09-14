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
const mailOAuth = require('./mail-oauth');
const leadAssignment = require('./lead-assignment');
const matching = require('./matching');
const sourcing = require('./sourcing');
const workAuth = require('./work-auth');
const { Events } = require('./events');
const automation = require('./automation');
const roles = require('./roles');
let auto = null; // assigned when the automation routes are installed (below the core routes)

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
    lead_no: 'INTEGER', assigned_to: 'TEXT', assigned_at: 'TIMESTAMP', email_from: 'VARCHAR(255)', email_body: 'TEXT',
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
  accounts: {
    name: 'VARCHAR(255)', industry: 'VARCHAR(100)', size: 'VARCHAR(50)', website: 'VARCHAR(255)', billing_contact: 'VARCHAR(255)', account_no: 'INTEGER',
    revenue: 'VARCHAR(50)', employees: 'VARCHAR(50)', tier: 'VARCHAR(50)', city: 'VARCHAR(100)', state: 'VARCHAR(50)', description: 'TEXT',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  contacts: {
    name: 'VARCHAR(255)', email: 'VARCHAR(255)', phone: 'VARCHAR(50)', company: 'VARCHAR(255)', title: 'VARCHAR(255)',
    contact_type: 'VARCHAR(20)', skills: 'TEXT', candidate_id: 'TEXT', lead_id: 'TEXT', account_id: 'TEXT', source: 'VARCHAR(100)', status: "VARCHAR(50) DEFAULT 'active'", score: 'INTEGER', notes: 'TEXT',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  users: { name: 'VARCHAR(255)', role: 'VARCHAR(50)', is_active: 'BOOLEAN DEFAULT TRUE', takes_leads: 'BOOLEAN DEFAULT TRUE', last_assigned_at: 'TIMESTAMP' },
  job_orders: { opportunity_id: 'TEXT', account_id: 'TEXT', priority: 'VARCHAR(20)', target_fill_date: 'DATE', required_skills: 'TEXT' },
  submissions: { created_by: 'TEXT' },
  placements: { created_by: 'TEXT', initial_end_date: 'DATE' },
  activities: {
    type: 'VARCHAR(50)', title: 'VARCHAR(255)', contact: 'VARCHAR(255)', account: 'VARCHAR(255)', due_at: 'TIMESTAMP', status: "VARCHAR(50) DEFAULT 'pending'", duration: 'VARCHAR(50)', notes: 'TEXT',
    lead_id: 'TEXT', opportunity_id: 'TEXT', account_id: 'TEXT', contact_id: 'TEXT', candidate_id: 'TEXT', created_by: 'TEXT', completed_at: 'TIMESTAMP',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  },
  mail_connections: { host: 'VARCHAR(255)', port: 'INTEGER', username: 'VARCHAR(255)', secret: 'TEXT' },
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
  ['job_orders', 'opportunity_id'], ['job_orders', 'account_id'], ['activities', 'lead_id'], ['activities', 'opportunity_id'], ['activities', 'account_id'], ['activities', 'contact_id'], ['activities', 'candidate_id'],
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

// Columns that turned out too narrow for real data (model output, long
// phone strings). Widened in place; harmless where already wide enough.
const WIDEN_COLUMNS = [
  ['leads', 'employment_type', 'VARCHAR(255)'], ['leads', 'work_arrangement', 'VARCHAR(255)'], ['leads', 'rate_or_salary', 'VARCHAR(255)'], ['leads', 'phone', 'VARCHAR(100)'],
  ['opportunities', 'work_arrangement', 'VARCHAR(255)'], ['opportunities', 'rate', 'VARCHAR(255)'],
  ['candidates', 'phone', 'VARCHAR(100)'], ['contacts', 'phone', 'VARCHAR(100)'],
];
async function widenColumns() {
  for (const [table, col, type] of WIDEN_COLUMNS) {
    try { await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${type}`); }
    catch (err) { if (!/failed to parse|not supported/i.test(err.message)) console.error(`⚠️ Could not widen ${table}.${col}:`, err.message.split(String.fromCharCode(10))[0]); }
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
    `CREATE TABLE IF NOT EXISTS mail_connections (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(20) NOT NULL,
      address VARCHAR(255) NOT NULL,
      refresh_token TEXT,
      access_token TEXT,
      expires_at TIMESTAMP,
      scopes TEXT,
      connected_by TEXT,
      status VARCHAR(20) DEFAULT 'connected',
      last_error TEXT,
      last_scanned_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider, address)
    )`,
    `CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50),
      title VARCHAR(255),
      contact VARCHAR(255),
      account VARCHAR(255),
      due_at TIMESTAMP,
      status VARCHAR(50) DEFAULT 'pending',
      duration VARCHAR(50),
      notes TEXT,
      lead_id TEXT,
      opportunity_id TEXT,
      account_id TEXT,
      contact_id TEXT,
      candidate_id TEXT,
      created_by TEXT,
      completed_at TIMESTAMP,
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
    // The first user of a database is the admin until roles are assigned.
    "UPDATE users SET role='admin' WHERE role IS NULL AND id = (SELECT MIN(id) FROM users)",
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
  await widenColumns();
  await backfillRecordNumbers();
  try {
    const b = await contactsSync.backfillContacts(pool);
    if (b.candidates || b.leads) console.log('👥 Contacts synced:', JSON.stringify(b));
  } catch (err) {
    console.error('⚠️ Contacts backfill failed:', err.message);
  }
  await logSchemaSummary();
  try { await auto.ensureSchema(); console.log('✅ Automation schema ready'); } catch (err) { console.error('⚠️ Automation schema failed:', err.message); }
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

// ---- Duplicate prevention ----
// Before a manual create, look for an existing record that is clearly the
// same thing (same email; same name + company/phone; same account or job
// title still open). A match answers 409 DUPLICATE with the existing record
// unless the caller sends allow_duplicate: true.
const norm = (v) => String(v || '').trim().toLowerCase();
async function checkDuplicate(table, b) {
  if (!b || b.allow_duplicate) return null;
  const email = norm(b.email), name = norm(b.name), company = norm(b.company), digits = String(b.phone || '').replace(/\D/g, '');
  const site = (v) => norm(v).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  let rows = [], test = () => null;
  if (table === 'contacts' || table === 'leads' || table === 'candidates') {
    if (!email && !name) return null;
    rows = (await pool.query(`SELECT * FROM ${table} WHERE LOWER(COALESCE(email,''))=$1 OR LOWER(COALESCE(name,''))=$2`, [email || '-', name || '-'])).rows;
    test = (r) => {
      // A lead is the same request only when the recruiter AND the role match;
      // the same recruiter with a different role is a separate lead.
      if (email && norm(r.email) === email) {
        if (table !== 'leads') return 'same email';
        if (leadScanner.sameRole(r, { job_title: b.job_title, email_subject: b.email_subject })) return 'same email and role';
        return null;
      }
      if (name && norm(r.name) === name) {
        if (company && norm(r.company) === company) return 'same name and company';
        if (digits && String(r.phone || '').replace(/\D/g, '') === digits) return 'same name and phone';
      }
      return null;
    };
  } else if (table === 'accounts') {
    const w = site(b.website); if (!name && !w) return null;
    rows = (await pool.query('SELECT * FROM accounts')).rows;
    test = (r) => (name && norm(r.name) === name) ? 'same company name' : (w && site(r.website) === w) ? 'same website' : null;
  } else if (table === 'opportunities') {
    const account = norm(b.account); if (!name) return null;
    rows = (await pool.query('SELECT * FROM opportunities WHERE LOWER(COALESCE(name,\'\'))=$1', [name])).rows;
    test = (r) => norm(r.account) === account && !['closed won', 'closed lost'].includes(norm(r.stage)) ? 'same deal name and account, still open' : null;
  } else if (table === 'job_orders') {
    const title = norm(b.title), comp = norm(b.company); if (!title) return null;
    rows = (await pool.query('SELECT * FROM job_orders WHERE LOWER(COALESCE(title,\'\'))=$1', [title])).rows;
    test = (r) => norm(r.company) === comp && !['closed', 'filled', 'cancelled'].includes(norm(r.status)) ? 'same title and company, still open' : null;
  }
  for (const r of rows) { const reason = test(r); if (reason) return { existing: r, reason }; }
  return null;
}
function sendDuplicate(res, table, dup) {
  const label = { contacts: 'contact', accounts: 'account', leads: 'lead', candidates: 'candidate', opportunities: 'opportunity', job_orders: 'job order' }[table] || 'record';
  const e = dup.existing;
  res.status(409).json({
    code: 'DUPLICATE',
    error: `Looks like a duplicate ${label}: "${e.name || e.title}" already exists (${dup.reason}). Edit the existing record instead.`,
    existing: { id: e.id, name: e.name || e.title, email: e.email, company: e.company || e.account || null },
  });
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
const JOB_ORDER_COLS  = ['title', 'company', 'location', 'description', 'salary_min', 'salary_max', 'salary_range', 'status', 'opportunity_id', 'account_id', 'priority', 'target_fill_date', 'required_skills', 'intake_status', 'source_of_truth', 'lead_id', 'created_by',
                         'source', 'url', 'apollo_job_id', 'apollo_org_id', 'posted_at', 'last_seen_at', 'last_synced_at'];
const SUBMISSION_COLS = ['candidate_id', 'job_order_id', 'status', 'notes', 'created_by'];
const LEAD_COLS       = ['name', 'title', 'company', 'company_address', 'company_website', 'email', 'phone', 'linkedin', 'source', 'status', 'territory', 'score',
                         'job_title', 'job_location', 'job_description', 'rate_or_salary', 'notes',
                         'end_client', 'employment_type', 'work_arrangement', 'workflow_status', 'email_subject', 'email_from', 'email_body', 'email_received_at'];
const OPP_COLS        = ['name', 'account', 'contact', 'contact_email', 'value', 'stage', 'probability', 'close_date', 'type', 'competitor', 'notes', 'forecast_category', 'win_loss_reason',
                         'job_title', 'job_description', 'client_name', 'rate', 'work_location', 'work_arrangement', 'lead_id', 'account_id'];
const PLACEMENT_COLS  = ['submission_id', 'candidate_id', 'job_order_id', 'start_date', 'end_date', 'fee_amount', 'placement_status', 'created_by', 'initial_end_date', 'bill_rate', 'bill_rate_type', 'client_approver_email', 'consultant_email', 'timesheet_cycle'];
const ACTIVITY_COLS   = ['type', 'title', 'contact', 'account', 'due_at', 'status', 'duration', 'notes', 'lead_id', 'opportunity_id', 'account_id', 'contact_id', 'candidate_id'];

// ====== MIDDLEWARE ======
app.use(helmet());
app.use(cors());
app.use(express.json());
// Role enforcement: viewers are read-only on every write route (see roles.js).
const roleGuard = roles.enforce({ pool, jwt, secret: () => JWT_SECRET });
app.use(roleGuard);

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

    if (user.is_active === false) return res.status(403).json({ error: 'This account is deactivated' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role || (user.id === 1 ? 'admin' : 'recruiter') } });
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
    const dup = await checkDuplicate('contacts', body); if (dup) return sendDuplicate(res, 'contacts', dup);
    const row = await insertRow('contacts', CONTACT_COLS, body);
    auto.dedupeReview('contacts', row);
    res.status(201).json(row);
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

const ACCOUNT_COLS = ['name', 'industry', 'size', 'website', 'billing_contact', 'revenue', 'employees', 'tier', 'city', 'state', 'description'];
app.post('/api/accounts', authenticateToken, async (req, res) => {
  try {
    if (!req.body || !req.body.name) return res.status(400).json({ error: 'name is required' });
    const dup = await checkDuplicate('accounts', req.body); if (dup) return sendDuplicate(res, 'accounts', dup);
    const row = await insertRow('accounts', ACCOUNT_COLS, req.body);
    auto.dedupeReview('accounts', row);
    res.status(201).json((await assignRecordNumber('accounts', row.id)) || row);
  } catch (err) {
    sendDbError(res, err);
  }
});
app.put('/api/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const row = await updateRow('accounts', ACCOUNT_COLS, req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'Account not found' });
    res.json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});
app.delete('/api/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('DELETE FROM accounts WHERE id::text=$1 RETURNING id', [String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'Account not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    sendDbError(res, err);
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
    const dup = await checkDuplicate('candidates', req.body); if (dup) return sendDuplicate(res, 'candidates', dup);
    const row = await insertRow('candidates', CANDIDATE_COLS, req.body);
    contactsSync.syncContactFromCandidate(pool, row).catch((e) => console.error('⚠️ Contact sync (candidate) failed:', e.message));
    auto.dedupeReview('candidates', row);
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
    const rows = result.rows;
    // Attach the O-number of the opportunity each job order came from.
    const ids = [...new Set(rows.map((r) => r.opportunity_id).filter(Boolean).map(String))];
    if (ids.length) {
      const opps = await pool.query('SELECT id, opportunity_no, name FROM opportunities WHERE id::text = ANY($1)', [ids]);
      const byId = new Map(opps.rows.map((o) => [String(o.id), o]));
      for (const r of rows) { const o = byId.get(String(r.opportunity_id)); if (o) { r.opportunity_no = o.opportunity_no; r.opportunity_name = o.name; } }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/job-orders', authenticateToken, async (req, res) => {
  try {
    const dup = await checkDuplicate('job_orders', req.body); if (dup) return sendDuplicate(res, 'job_orders', dup);
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
// Scoped lists: roles.js sets req.scopeOwner for recruiters and sales so they only see their own records.
const scopedList = (table) => async (req, res) => {
  try {
    const s = req.scopeOwner;
    const result = s ? await pool.query(`SELECT * FROM ${table} WHERE ${s.column}::text=$1 ORDER BY created_at DESC`, [s.user_id]) : await pool.query(`SELECT * FROM ${table} ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const result = req.scopeOwner ? await pool.query('SELECT * FROM leads WHERE assigned_to::text=$1 ORDER BY created_at DESC', [req.scopeOwner.user_id]) : await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
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
  auto.events.record({ type: 'lead.created', entity_type: 'lead', entity_id: lead.id, actor: lead.origin === 'system' ? 'lead-scanner' : 'user', payload: { lead_no: lead.lead_no, source: lead.source, assigned_to: lead.assigned_to } });
  auto.dedupeReview('leads', lead);
  return lead;
}
leadScanner.onLeadCreated = (row) => afterLeadCreated(row);
leadWorkflow.onReadyToAuthorize = (row) => auto.onLeadReadyToAuthorize(row);
leadScanner.onLeadUpdated = (row) => contactsSync.syncContactFromLead(pool, row).catch(() => {});
leadWorkflow.onLeadUpdated = (row) => contactsSync.syncContactFromLead(pool, row).catch(() => {});

app.post('/api/leads', authenticateToken, async (req, res) => {
  try {
    const { assigned_to, ...body } = req.body || {};
    const dup = await checkDuplicate('leads', body); if (dup) return sendDuplicate(res, 'leads', dup);
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

// Team + assignment + user administration
const ROLES = ['admin', 'recruiter', 'sales', 'viewer'];
// Admin check: the caller's stored role must be admin. If no admin exists yet
// (fresh database), the first user is treated as admin.
async function requireAdmin(req, res, next) {
  try {
    const me = await pool.query('SELECT id, role FROM users WHERE id::text=$1', [String(req.user.id)]);
    const admins = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
    const isAdmin = me.rows.length && (me.rows[0].role === 'admin' || (Number(admins.rows[0].n) === 0));
    if (!isAdmin) return res.status(403).json({ error: 'Only an admin can manage users' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; for (const b of require('crypto').randomBytes(12)) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
app.get('/api/users', authenticateToken, async (req, res) => {
  try { res.json(await leadAssignment.listTeam(pool)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { email, name, role = 'recruiter', takes_leads = true, password } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(', ')}` });
    const dup = await pool.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (dup.rows.length) return res.status(409).json({ error: 'A user with that email already exists' });
    const plain = password && String(password).length >= 8 ? String(password) : tempPassword();
    const hash = await bcrypt.hash(plain, 10);
    const q = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, is_active, takes_leads) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id, email, name, role, is_active, takes_leads, created_at',
      [email.toLowerCase(), hash, name || email.split('@')[0], role, takes_leads !== false]);
    // The temporary password is returned exactly once so it can be handed to the new user.
    res.status(201).json({ ...q.rows[0], temporary_password: password ? undefined : plain });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const plain = req.body && req.body.password && String(req.body.password).length >= 8 ? String(req.body.password) : tempPassword();
    const hash = await bcrypt.hash(plain, 10);
    const q = await pool.query('UPDATE users SET password_hash=$1 WHERE id::text=$2 RETURNING id, email', [hash, String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ...q.rows[0], temporary_password: req.body && req.body.password ? undefined : plain });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'You cannot delete yourself' });
    // Their open leads go back to the pool so nothing is orphaned.
    await pool.query('UPDATE leads SET assigned_to=NULL, assigned_at=NULL WHERE assigned_to=$1', [String(req.params.id)]);
    const q = await pool.query('DELETE FROM users WHERE id::text=$1 RETURNING id, email', [String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Deleted', ...q.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('SELECT id, email, name, role, is_active, takes_leads FROM users WHERE id::text=$1', [String(req.user.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    const admins = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
    const u = q.rows[0]; if (!u.role && Number(admins.rows[0].n) === 0) u.role = 'admin';
    res.json({ ...u, roles: ROLES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const allowed = ['name', 'role', 'is_active', 'takes_leads'];
    const fields = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No valid fields' });
    if (fields.role !== undefined && !ROLES.includes(fields.role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(', ')}` });
    // Role and active-state changes are admin-only; anyone may toggle their own takes_leads / name.
    if ((fields.role !== undefined || fields.is_active !== undefined) || String(req.params.id) !== String(req.user.id)) {
      const me = await pool.query('SELECT role FROM users WHERE id::text=$1', [String(req.user.id)]);
      const admins = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
      const isAdmin = me.rows.length && (me.rows[0].role === 'admin' || Number(admins.rows[0].n) === 0);
      if (!isAdmin) return res.status(403).json({ error: 'Only an admin can change roles or other users' });
      if (fields.is_active === false && String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'You cannot deactivate yourself' });
    }
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
    const connected = await mailOAuth.connectedMailboxes(pool).catch(() => []);
    res.json({
      mailboxes: [...leadScanner.publicMailboxes(), ...connected.map((b) => ({ address: b.address, provider: b.provider, host: null, last_scanned_at: b.connection.last_scanned_at }))],
      ai_configured: leadScanner.isLeadAIConfigured(),
      scan_interval_minutes: LEAD_SCAN_INTERVAL_MIN,
      running: leadScanState.running,
      last_error: leadScanState.last_error || null,
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

// ---- Direct mailbox integrations (Gmail / Outlook via OAuth) ----
leadScanner.extraMailboxes = () => mailOAuth.connectedMailboxes(pool);
leadScanner.fetchConnectedMessages = (box, opts) => mailOAuth.fetchConnectedMessages(pool, box, opts);
app.get('/api/integrations', authenticateToken, async (req, res) => {
  try {
    res.json({ providers: mailOAuth.providerStatus(), connections: await mailOAuth.listConnections(pool), env_mailboxes: leadScanner.publicMailboxes() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/integrations/:provider/connect', authenticateToken, (req, res) => {
  try { res.json({ url: mailOAuth.buildAuthUrl(req.params.provider, req.user.id) }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// Public: the provider sends the browser here after consent; state proves who started it.
app.get('/api/integrations/:provider/callback', async (req, res) => {
  const back = (params) => res.redirect(`${mailOAuth.APP_URL}/?${new URLSearchParams(params)}`);
  try {
    if (req.query.error) return back({ connect_error: `${req.query.error}: ${req.query.error_description || ''}`.trim() });
    const conn = await mailOAuth.completeConnection(pool, { provider: req.params.provider, code: String(req.query.code || ''), state: String(req.query.state || '') });
    back({ connected: conn.address, provider: conn.provider });
  } catch (err) { back({ connect_error: err.message }); }
});
// Saved IMAP mailbox (Verizon/AOL, Gmail with an app password, any IMAP host).
// The app password is typed into the app by the user, tested against the
// server right away, and stored for the scanner. Never an account password.
app.post('/api/integrations/imap', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const address = String(b.address || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return res.status(400).json({ error: 'A valid mailbox address is required' });
    const host = String(b.host || mailOAuth.imapHostFor(address) || '').trim();
    if (!host) return res.status(400).json({ error: 'IMAP host is required (for example imap.aol.com)' });
    const port = Number(b.port) || 993;
    const username = String(b.username || address).trim();
    const secret = String(b.password || '');
    if (!secret) return res.status(400).json({ error: 'App password is required' });
    const box = { address, provider: 'imap', host, port, user: username, pass: secret };
    let sample = [];
    try { sample = await leadScanner.fetchImapMessages(box, { since: new Date(Date.now() - 7 * 86400000).toISOString(), max: 3 }); }
    catch (err) { return res.status(400).json({ error: `Could not sign in to ${host} as ${username}: ${err.message}. Use an app password, not the account password, and check IMAP is enabled.` }); }
    const q = await pool.query(
      `INSERT INTO mail_connections (provider, address, host, port, username, secret, status, connected_by, scopes)
       VALUES ('imap',$1,$2,$3,$4,$5,'connected',$6,'imap')
       ON CONFLICT (provider, address) DO UPDATE SET host=EXCLUDED.host, port=EXCLUDED.port, username=EXCLUDED.username, secret=EXCLUDED.secret, status='connected', last_error=NULL, updated_at=CURRENT_TIMESTAMP
       RETURNING id, provider, address, host, status`, [address, host, port, username, secret, String(req.user.id)]);
    res.status(201).json({ connection: q.rows[0], sample: sample.map((m) => ({ from: m.from_email, subject: m.subject, received_at: m.received_at })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/integrations/:id', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('DELETE FROM mail_connections WHERE id::text=$1 RETURNING id', [String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'Connection not found' });
    res.json({ message: 'Disconnected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/integrations/:id/test', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM mail_connections WHERE id::text=$1', [String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'Connection not found' });
    const [box] = (await mailOAuth.connectedMailboxes(pool)).filter((b) => String(b.connection.id) === String(req.params.id));
    if (!box) return res.status(409).json({ error: 'Connection needs to be reconnected' });
    const opts = { since: new Date(Date.now() - 7 * 86400000).toISOString(), max: 3 };
    let msgs;
    if (box.provider === 'imap') {
      try { msgs = await leadScanner.fetchImapMessages(box, opts); await pool.query("UPDATE mail_connections SET last_error=NULL, status='connected' WHERE id=$1", [box.connection.id]); }
      catch (err) { await pool.query('UPDATE mail_connections SET last_error=$1 WHERE id=$2', [err.message, box.connection.id]).catch(() => {}); throw err; }
    } else {
      msgs = await mailOAuth.fetchConnectedMessages(pool, box, opts);
    }
    res.json({ ok: true, address: box.address, sample: msgs.map((m) => ({ from: m.from_email, subject: m.subject, received_at: m.received_at })) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Re-attach conversations whose lead was deleted and recreated (for example
// after splitting a recruiter's roles into separate leads). Each orphaned
// email is moved to the recreated lead for the same recruiter, matching on
// the role/subject when possible, and the lead's workflow state is restored
// from the emails already sent.
app.post('/api/leads/repair-conversations', authenticateToken, async (req, res) => {
  try {
    const liveIds = new Set((await pool.query('SELECT id FROM leads')).rows.map((r) => String(r.id)));
    const orphans = (await pool.query('SELECT * FROM lead_emails ORDER BY created_at, id')).rows.filter((e) => !liveIds.has(String(e.lead_id)));
    const report = { orphaned_emails: orphans.length, reattached: 0, unmatched: 0, leads_restored: [] };
    const touched = new Map();
    for (const e of orphans) {
      const addr = String((e.direction === 'outbound' ? e.to_email : e.from_email) || '').toLowerCase();
      if (!addr) { report.unmatched += 1; continue; }
      const cands = (await pool.query('SELECT * FROM leads WHERE LOWER(email)=$1 ORDER BY created_at, id', [addr])).rows;
      if (!cands.length) { report.unmatched += 1; continue; }
      const target = cands.find((l) => leadScanner.sameRole(l, { job_title: '', email_subject: e.subject })) || cands.find((l) => leadScanner.sameRole(l, { job_title: e.subject, email_subject: '' })) || cands[cands.length - 1];
      await pool.query('UPDATE lead_emails SET lead_id=$1 WHERE id=$2', [String(target.id), e.id]);
      report.reattached += 1;
      const t = touched.get(String(target.id)) || { lead: target, emails: [] };
      t.emails.push(e); touched.set(String(target.id), t);
    }
    for (const { lead, emails } of touched.values()) {
      const all = (await pool.query('SELECT * FROM lead_emails WHERE lead_id=$1 ORDER BY created_at, id', [String(lead.id)])).rows;
      const offer = all.filter((x) => x.direction === 'outbound' && x.kind === 'offer_reply').pop();
      const closeOut = all.find((x) => x.kind === 'close_out');
      const inbound = all.filter((x) => x.direction === 'inbound' && x.kind !== 'outreach').pop();
      if (!offer || ['opportunity_created', 'ready_to_authorize', 'declined', 'closed_no_response', 'personal_interest'].includes(lead.workflow_status)) continue;
      const missing = leadWorkflow.missingInfo(lead);
      const status = closeOut ? 'closed_no_response' : (missing.length ? 'awaiting_info' : 'replied');
      const fields = { workflow_status: status, reviewed_at: lead.reviewed_at || offer.created_at, replied_at: offer.created_at, follow_up_due_at: closeOut ? null : leadWorkflow.addBusinessDays(new Date(inbound && inbound.created_at > offer.created_at ? inbound.created_at : offer.created_at), leadWorkflow.FOLLOW_UP_BUSINESS_DAYS), missing_info: JSON.stringify(missing.map((m) => m.key)), last_inbound_at: inbound ? inbound.created_at : lead.last_inbound_at };
      const cols = Object.keys(fields);
      await pool.query(`UPDATE leads SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id::text=$${cols.length + 1}`, [...cols.map((c) => fields[c]), String(lead.id)]);
      report.leads_restored.push({ id: lead.id, lead_no: lead.lead_no, name: lead.name, job_title: lead.job_title, workflow_status: status, emails_reattached: emails.length });
    }
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Forget scanned messages from one sender so the next scan re-reads them
// (used after deleting a lead that should be split per role).
app.post('/api/leads/scan/forget', authenticateToken, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const q = await pool.query('DELETE FROM email_scan_log WHERE LOWER(from_email)=$1 RETURNING id', [email]);
    res.json({ forgotten: q.rows.length, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/leads/scan', authenticateToken, async (req, res) => {
  try {
    if (!leadScanner.isLeadAIConfigured()) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)', code: 'AI_NOT_CONFIGURED' });
    const boxes = [...leadScanner.listMailboxes(), ...(await mailOAuth.connectedMailboxes(pool).catch(() => []))];
    if (!boxes.length) return res.status(503).json({ error: 'No mailboxes connected. Connect Gmail or Outlook under Settings > Integrations (or set GRAPH_SCAN_MAILBOXES / GMAIL_* / VERIZON_* on the API service).', code: 'NO_MAILBOXES' });
    const { days, max, mailbox } = req.body || {};
    const selected = mailbox ? boxes.filter((b) => b.address.toLowerCase() === String(mailbox).toLowerCase()) : boxes;
    if (!selected.length) return res.status(404).json({ error: `Mailbox ${mailbox} is not configured` });
    if (req.body && req.body.background) {
      if (leadScanState.running) return res.status(202).json({ started: false, running: true, message: 'A scan is already running' });
      leadScanState.last_error = null;
      runLeadScan({ mailboxes: selected, days, max }).catch((e) => { leadScanState.last_error = e.message; console.error('⚠️ Background lead scan failed:', e.message); });
      return res.status(202).json({ started: true, running: true, days: Number(days) || undefined, mailboxes: selected.map((b) => b.address) });
    }
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
    auto.audit('lead.reviewed', 'lead', lead.id, req, { missing: draft.missing.map((m) => m.key) });
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
    auto.audit('lead.replied', 'lead', lead.id, req, { transport: result.transport, status: result.lead && result.lead.workflow_status });
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
    auto.audit('lead.closed_out', 'lead', lead.id, req, { status: (req.body && req.body.status) || 'declined' });
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
    const dup = await checkDuplicate('opportunities', req.body); if (dup) return sendDuplicate(res, 'opportunities', dup);
    const row = await insertRow('opportunities', OPP_COLS, req.body);
    res.status(201).json((await assignRecordNumber('opportunities', row.id)) || row);
  } catch (err) { sendDbError(res, err); }
});

// ---- Candidate sourcing from free boards (driven by a job order) ----
app.post('/api/sourcing/search', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    let query = String(b.query || '').trim(), location = String(b.location || '').trim();
    if (b.job_order_id) {
      const q = await pool.query('SELECT * FROM job_orders WHERE id::text=$1', [String(b.job_order_id)]);
      if (q.rows.length) { query = query || q.rows[0].title || ''; location = location || q.rows[0].location || ''; }
    }
    if (!query) return res.status(400).json({ error: 'query (or job_order_id) is required' });
    const out = await sourcing.searchAll(query, { location, sources: Array.isArray(b.sources) && b.sources.length ? b.sources : undefined, limit: Number(b.limit) || 20, metro: b.metro, usOnly: b.us_only !== false });
    out.google_configured = sourcing.googleConfigured();
    res.json(out);
  } catch (err) { res.status(502).json({ error: err.message }); }
});
// Import a sourcing hit: read its text, extract candidate fields with the same
// AI parser as resume upload, and create the candidate (duplicates refused).
app.post('/api/sourcing/import', authenticateToken, async (req, res) => {
  try {
    const hit = (req.body && req.body.result) || {};
    const text = await sourcing.fetchResultText(hit);
    if (!text || text.length < 40) return res.status(400).json({ error: 'Not enough text on this result to build a candidate from' });
    let fields;
    if (isAIConfigured()) { try { fields = await extractCandidateWithAI(text); } catch (e) { fields = { ...parseResumeText(text), parser: 'rules' }; } }
    else fields = { ...parseResumeText(text), parser: 'rules' };
    const auth = workAuth.classifyWorkAuth(text);
    const body = {
      work_auth: fields.work_auth || (auth.status === 'authorized' ? 'US work authorized' : auth.status === 'not_authorized' ? 'Needs sponsorship' : ''),
      name: fields.name || hit.name || 'Unknown candidate', email: fields.email || hit.email || '', phone: fields.phone || '', title: fields.title || hit.title || '',
      company: fields.company || '', location: fields.location || hit.location || '', skills: fields.skills || [], experience_years: fields.experience_years ?? null,
      linkedin: fields.linkedin || (hit.resume_link && /linkedin/.test(hit.resume_link) ? hit.resume_link : ''), status: 'active', source: `Sourced: ${hit.source || 'board'}`,
      resume_text: text.slice(0, 20000), notes: `Imported from ${hit.link || hit.source || 'a sourcing search'}${hit.resume_link ? `
Resume link: ${hit.resume_link}` : ''}`,
    };
    if (Array.isArray(body.skills)) body.skills = body.skills.join(', ');
    const dup = await checkDuplicate('candidates', body); if (dup) return sendDuplicate(res, 'candidates', dup);
    const row = await insertRow('candidates', CANDIDATE_COLS, body);
    contactsSync.syncContactFromCandidate(pool, row).catch(() => {});
    res.status(201).json({ candidate: row, parser: fields.parser || 'ai' });
  } catch (err) { sendDbError(res, err); }
});

// ---- Opportunity -> Job Order hand-off ----
// The confirmed deal becomes the role to fill. Fields carry over and the job
// order keeps the opportunity's id (and O-number) so the chain is visible.
app.post('/api/opportunities/:id/job-order', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM opportunities WHERE id::text=$1', [String(req.params.id)]);
    if (!q.rows.length) return res.status(404).json({ error: 'Opportunity not found' });
    const o = q.rows[0];
    const existing = await pool.query('SELECT * FROM job_orders WHERE opportunity_id=$1 ORDER BY id LIMIT 1', [String(o.id)]);
    if (existing.rows.length && !(req.body && req.body.allow_duplicate)) return res.status(409).json({ code: 'DUPLICATE', error: `A job order already exists for this opportunity ("${existing.rows[0].title}").`, existing: existing.rows[0] });
    const b = req.body || {};
    const body = {
      title: b.title || o.job_title || o.name, company: b.company || o.client_name || o.account || '', location: b.location || o.work_location || o.work_arrangement || '',
      description: b.description || o.job_description || o.notes || '', salary_range: b.salary_range || o.rate || (o.value != null ? String(o.value) : ''),
      status: b.status || 'open', priority: b.priority || 'High', opportunity_id: String(o.id), account_id: o.account_id ? String(o.account_id) : null,
      source: 'Opportunity',
    };
    const row = await insertRow('job_orders', JOB_ORDER_COLS, body);
    if (String(o.stage || '').toLowerCase() === 'prospecting' || String(o.stage || '').toLowerCase() === 'qualification') {
      await pool.query("UPDATE opportunities SET stage='Proposal', updated_at=CURRENT_TIMESTAMP WHERE id::text=$1", [String(o.id)]).catch(() => {});
    }
    await pool.query('INSERT INTO activities (type, title, account, opportunity_id, account_id, status, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7)',
      ['Task', `Job order created: ${body.title}`, body.company, String(o.id), body.account_id, 'completed', String(req.user.id)]).catch(() => {});
    auto.audit('job_order.created', 'job_order', row.id, req, { from: 'opportunity', opportunity_id: String(o.id) });
    res.status(201).json({ ...row, opportunity_no: o.opportunity_no, opportunity_name: o.name });
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
  const results = await matching.rankCandidates({ pool, target, limit: body.limit || 10, aiTop: body.ai_top ?? 5, useAI: body.use_ai !== false, usOnly: body.us_only !== false, strictUS: body.strict_us_auth !== false });
  await matching.storeMatches(pool, target, results);
  return { target: { kind: target.kind, id: target.id, title: target.title }, matches: results, ai_used: results.some((r) => r.ai_score != null), computed_at: new Date().toISOString(), us_only: results.us_only, strict_us_auth: results.strict_us, excluded: results.excluded };
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
      const connected = await mailOAuth.connectedMailboxes(pool).catch(() => []);
      if (hasMailboxes || connected.length) {
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
  console.log(`📬 Lead workflow scheduled every ${LEAD_SCAN_INTERVAL_MIN} min${hasMailboxes ? ` (scanning ${leadScanner.listMailboxes().map((b) => b.address).join(', ')})` : ' (env mailboxes: none; connected mailboxes from Settings are scanned too)'}`);
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
    const emailBody = cover_note || `Dear ${signerFirst},\n\nPlease find attached a Mutual NDA from Peek Talent Solutions for your review in connection with ${deal_name || 'our engagement'}.\n\nBest regards,\nPeek Talent Solutions`;
    const result = await sendEmail({
      to: signer_email,
      subject: subject || `Mutual NDA for Review - ${deal_name || client_company || 'Peek Talent Solutions'}`,
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
    const text = `Hi ${first},\n\n${message || `This is a reminder about your upcoming interview for the ${s.job_title || 'open'} role${s.company ? ` at ${s.company}` : ''}. Please reach out if you have any questions.`}\n\nBest regards,\nPeek Talent Solutions`;
    const result = await sendEmail({
      to: recipient,
      subject: `Interview Reminder - ${s.job_title || 'Your submission'}${s.company ? ` at ${s.company}` : ''} | Peek Talent Solutions`,
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
app.get('/api/submissions', authenticateToken, scopedList('submissions'));

app.post('/api/submissions', authenticateToken, async (req, res) => {
  try {
    const body = { ...(req.body || {}), created_by: String(req.user.id) };
    const status = automation.normalizeSubmissionStatus(body.status);
    if (!status) return res.status(400).json({ error: `Unknown submission status "${body.status}"`, code: 'INVALID_STATUS', allowed: automation.STATUS_IDS });
    if (status === 'hired' && !body.override) return res.status(409).json({ error: 'Create the submission first, then record the placement to mark it hired.', code: 'USE_PLACEMENT' });
    body.status = status;
    const row = await insertRow('submissions', SUBMISSION_COLS, body);
    await pool.query('UPDATE submissions SET stage_changed_at=CURRENT_TIMESTAMP WHERE id=$1', [row.id]).catch(() => {});
    auto.audit('submission.created', 'submission', row.id, req, { candidate_id: row.candidate_id, job_order_id: row.job_order_id, status });
    res.status(201).json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

app.put('/api/submissions/:id', authenticateToken, async (req, res) => {
  try {
    const { status, override, override_reason, note, ...rest } = req.body || {};
    let row = Object.keys(rest).length ? await updateRow('submissions', SUBMISSION_COLS, req.params.id, rest) : (await pool.query('SELECT * FROM submissions WHERE id::text=$1', [String(req.params.id)])).rows[0];
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    if (status !== undefined) row = await auto.applySubmissionStatus(row, status, { req, note, override: !!override, reason: override_reason });
    res.json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
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
app.get('/api/placements', authenticateToken, scopedList('placements'));

app.post('/api/placements', authenticateToken, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    // A placement made from a submission fills in the candidate and job order
    // and marks the submission as hired, so the chain is recorded.
    let sub = null;
    if (body.submission_id) {
      const q = await pool.query('SELECT * FROM submissions WHERE id::text=$1', [String(body.submission_id)]);
      if (!q.rows.length) return res.status(404).json({ error: 'Submission not found' });
      sub = q.rows[0];
      if (!body.candidate_id) body.candidate_id = sub.candidate_id;
      if (!body.job_order_id) body.job_order_id = sub.job_order_id;
    }
    if (sub) { const gate = auto.placementGate(sub, body); if (gate) return res.status(gate.status).json(gate); }
    body.created_by = String(req.user.id);
    if (body.end_date && !body.initial_end_date) body.initial_end_date = body.end_date;
    const { override, override_reason, ...clean } = body;
    const row = await insertRow('placements', PLACEMENT_COLS, clean);
    auto.afterPlacement(row, sub, req).catch(() => {});
    if (sub) {
      await pool.query("UPDATE submissions SET status='hired', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [sub.id]).catch(() => {});
      await pool.query("UPDATE job_orders SET status='filled', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND COALESCE(status,'open') NOT IN ('filled','closed','cancelled')", [sub.job_order_id]).catch(() => {});
      await pool.query("UPDATE candidates SET status='placed', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [sub.candidate_id]).catch(() => {});
    }
    res.status(201).json(row);
  } catch (err) {
    sendDbError(res, err);
  }
});

// ---- Activities: calls, emails, meetings, tasks against a lead / deal / account ----
app.get('/api/activities', authenticateToken, async (req, res) => {
  try {
    const where = []; const params = [];
    for (const k of ['opportunity_id', 'lead_id', 'account_id', 'candidate_id']) if (req.query[k]) { params.push(String(req.query[k])); where.push(`${k}=$${params.length}`); }
    const q = await pool.query(`SELECT * FROM activities${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(due_at, created_at) DESC, id DESC`, params);
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/activities', authenticateToken, async (req, res) => {
  try {
    const b = { ...(req.body || {}) };
    if (!b.title) return res.status(400).json({ error: 'title is required' });
    // Fill the display names from the linked records when only ids were sent.
    if (b.opportunity_id && !b.account) { const o = await pool.query('SELECT account, contact, account_id FROM opportunities WHERE id::text=$1', [String(b.opportunity_id)]); if (o.rows[0]) { b.account = o.rows[0].account || ''; b.contact = b.contact || o.rows[0].contact || ''; b.account_id = b.account_id || o.rows[0].account_id; } }
    if (b.lead_id && !b.contact) { const l = await pool.query('SELECT name, company, account_id FROM leads WHERE id::text=$1', [String(b.lead_id)]); if (l.rows[0]) { b.contact = l.rows[0].name || ''; b.account = b.account || l.rows[0].company || ''; b.account_id = b.account_id || l.rows[0].account_id; } }
    if (b.due_at === '') b.due_at = null;
    const row = await insertRow('activities', [...ACTIVITY_COLS, 'created_by'], { ...b, created_by: String(req.user.id) });
    res.status(201).json(row);
  } catch (err) { sendDbError(res, err); }
});
app.put('/api/activities/:id', authenticateToken, async (req, res) => {
  try {
    const b = { ...(req.body || {}) };
    if (b.status === 'completed') b.completed_at = new Date();
    if (b.due_at === '') b.due_at = null;
    const row = await updateRow('activities', [...ACTIVITY_COLS, 'completed_at'], req.params.id, b);
    if (!row) return res.status(404).json({ error: 'Activity not found' });
    res.json(row);
  } catch (err) { sendDbError(res, err); }
});
app.delete('/api/activities/:id', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query('DELETE FROM activities WHERE id=$1 RETURNING id', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Activity not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { sendDbError(res, err); }
});

// ---- Reports: sales analytics and the staffing scoreboard (computed from the tables) ----
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const monthKey = (d) => { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
const lastMonths = (n) => { const out = []; const now = new Date(); for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); out.push({ key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) }); } return out; };
app.get('/api/analytics', authenticateToken, async (req, res) => {
  try {
    const [opps, leads, acts, users] = await Promise.all([
      pool.query('SELECT * FROM opportunities'), pool.query('SELECT * FROM leads'), pool.query('SELECT * FROM activities'), pool.query('SELECT id, name, email FROM users'),
    ]);
    const open = opps.rows.filter((o) => !['closed won', 'closed lost'].includes(String(o.stage || '').toLowerCase()));
    const won = opps.rows.filter((o) => String(o.stage || '').toLowerCase() === 'closed won');
    const lost = opps.rows.filter((o) => String(o.stage || '').toLowerCase() === 'closed lost');
    const year = new Date().getUTCFullYear();
    const byStage = {}; for (const o of opps.rows) { const k = o.stage || 'Unknown'; byStage[k] = byStage[k] || { stage: k, count: 0, value: 0 }; byStage[k].count += 1; byStage[k].value += num(o.value); }
    const activeLeads = leads.rows.filter((l) => !['unqualified'].includes(String(l.status || '').toLowerCase()) && !['declined', 'closed_no_response', 'opportunity_created'].includes(String(l.workflow_status || '')));
    const bySource = {}; for (const l of leads.rows) { const k = l.source || 'Unknown'; bySource[k] = (bySource[k] || 0) + 1; }
    const userName = new Map(users.rows.map((u) => [String(u.id), u.name || u.email]));
    const byOwner = {}; for (const l of leads.rows) { const k = l.assigned_to ? (userName.get(String(l.assigned_to)) || `User ${l.assigned_to}`) : 'Unassigned'; byOwner[k] = (byOwner[k] || 0) + 1; }
    const byWorkflow = {}; for (const l of leads.rows) { const k = l.workflow_status || 'new'; byWorkflow[k] = (byWorkflow[k] || 0) + 1; }
    const replied = leads.rows.filter((l) => l.replied_at && l.created_at);
    const avgHoursToReply = replied.length ? Math.round(replied.reduce((s, l) => s + (new Date(l.replied_at) - new Date(l.created_at)) / 36e5, 0) / replied.length * 10) / 10 : null;
    const converted = leads.rows.filter((l) => l.opportunity_id).length;
    const byType = {}; for (const a of acts.rows) { const k = a.type || 'Other'; byType[k] = (byType[k] || 0) + 1; }
    const months = lastMonths(6);
    const monthly = months.map((m) => ({ month: m.label, key: m.key, leads: leads.rows.filter((l) => l.created_at && monthKey(l.created_at) === m.key).length, opportunities: opps.rows.filter((o) => o.created_at && monthKey(o.created_at) === m.key).length, closed_won_value: won.filter((o) => (o.close_date || o.updated_at) && monthKey(o.close_date || o.updated_at) === m.key).reduce((s, o) => s + num(o.value), 0) }));
    res.json({
      pipeline: open.reduce((s, o) => s + num(o.value), 0),
      closedWon: won.filter((o) => new Date(o.close_date || o.updated_at || o.created_at).getUTCFullYear() === year).reduce((s, o) => s + num(o.value), 0),
      closedWonCount: won.length, closedLostCount: lost.length, openCount: open.length,
      winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
      activeLeads: activeLeads.length, totalLeads: leads.rows.length,
      activities: acts.rows.length, openActivities: acts.rows.filter((a) => a.status !== 'completed').length,
      byStage: Object.values(byStage), leadsBySource: Object.entries(bySource).map(([source, count]) => ({ source, count })), leadsByOwner: Object.entries(byOwner).map(([owner, count]) => ({ owner, count })),
      leadsByWorkflow: Object.entries(byWorkflow).map(([status, count]) => ({ status, count })), avgHoursToReply,
      conversion: { leads: leads.rows.length, opportunities: converted, rate: leads.rows.length ? Math.round((converted / leads.rows.length) * 100) : 0 },
      activitiesByType: Object.entries(byType).map(([type, count]) => ({ type, count })), monthly,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ---- Metrics: the standard staffing / recruiting KPIs, each with its definition ----
const days = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 86400000 : null);
const avg = (arr) => { const v = arr.filter((x) => x != null && !Number.isNaN(x)); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const INTERVIEW_STAGES = ['phone screen', 'screening', 'technical', 'interview', 'hiring manager', 'final round', 'offer', 'hired', 'placed', ...automation.INTERVIEW_OR_LATER];
const OFFER_STAGES = ['offer', 'hired', 'placed', ...automation.OFFER_OR_LATER];
const ACCEPTED_STAGES = ['hired', 'placed', ...automation.ACCEPTED_OR_LATER];
app.get('/api/metrics', authenticateToken, async (req, res) => {
  try {
    const [opps, leads, acts, users, cands, jobs, subs, places] = await Promise.all([
      pool.query('SELECT * FROM opportunities'), pool.query('SELECT * FROM leads'), pool.query('SELECT * FROM activities'), pool.query('SELECT id, name, email FROM users'),
      pool.query('SELECT * FROM candidates'), pool.query('SELECT * FROM job_orders'), pool.query('SELECT * FROM submissions'), pool.query('SELECT * FROM placements'),
    ]);
    const now = new Date();
    const uname = new Map(users.rows.map((u) => [String(u.id), u.name || u.email]));
    const who = (id) => (id ? uname.get(String(id)) || `User ${id}` : 'Unassigned');
    const stage = (st) => String(st || '').toLowerCase();
    const won = opps.rows.filter((o) => stage(o.stage) === 'closed won'), lost = opps.rows.filter((o) => stage(o.stage) === 'closed lost');
    const open = opps.rows.filter((o) => !['closed won', 'closed lost'].includes(stage(o.stage)));
    const fees = places.rows.reduce((s, p) => s + num(p.fee_amount), 0);
    const groupSum = (rows, keyFn, valFn) => { const m = {}; for (const r of rows) { const k = keyFn(r); m[k] = m[k] || { count: 0, value: 0 }; m[k].count += 1; m[k].value += valFn ? valFn(r) : 0; } return m; };
    const revenueByRecruiter = groupSum(places.rows, (p) => who(p.created_by), (p) => num(p.fee_amount));

    // Speed
    const jobById = new Map(jobs.rows.map((j) => [String(j.id), j]));
    const subById = new Map(subs.rows.map((x) => [String(x.id), x]));
    const firstSubByJob = {}; for (const x of subs.rows) { const k = String(x.job_order_id); if (!firstSubByJob[k] || new Date(x.created_at) < new Date(firstSubByJob[k])) firstSubByJob[k] = x.created_at; }
    const daysToFirstSubmission = avg(Object.entries(firstSubByJob).map(([jid, at]) => { const j = jobById.get(jid); return j ? days(j.created_at, at) : null; }));
    const daysToFill = avg(places.rows.map((p) => { const j = jobById.get(String(p.job_order_id)); return j ? days(j.created_at, p.start_date || p.created_at) : null; }));
    const daysToHire = avg(places.rows.map((p) => { const x = subById.get(String(p.submission_id)); return x ? days(x.created_at, p.created_at) : null; }));
    const replied = leads.rows.filter((l) => l.replied_at && l.created_at);
    const hoursToFirstResponse = avg(replied.map((l) => (new Date(l.replied_at) - new Date(l.created_at)) / 36e5));

    // Volume and quality
    const leadsPerSource = groupSum(leads.rows, (l) => l.source || 'Unknown');
    const interviewed = subs.rows.filter((x) => INTERVIEW_STAGES.includes(stage(x.status)));
    const offered = subs.rows.filter((x) => OFFER_STAGES.includes(stage(x.status)));
    const accepted = subs.rows.filter((x) => ACCEPTED_STAGES.includes(stage(x.status)));
    const jobsWithSubs = new Set(subs.rows.map((x) => String(x.job_order_id))).size;
    const placementsByRecruiter = groupSum(places.rows, (p) => who(p.created_by));

    // Sourcing
    const candsPerSource = groupSum(cands.rows, (c) => c.source || 'Unknown');
    const authorized = cands.rows.filter((c) => workAuth.screenUS({ workAuth: c.work_auth, location: c.location, text: `${c.resume_text || ''}\n${c.notes || ''}` }).status === 'authorized').length;

    // Retention
    const matured = places.rows.filter((p) => p.start_date && days(p.start_date, now) >= 90);
    const fellOff = places.rows.filter((p) => p.start_date && p.end_date && days(p.start_date, p.end_date) < 90 && ['terminated', 'fell_off', 'fell off', 'ended', 'cancelled'].includes(stage(p.placement_status)));
    const withEnd = places.rows.filter((p) => p.initial_end_date || p.end_date);
    const extended = withEnd.filter((p) => stage(p.placement_status) === 'extended' || (p.initial_end_date && p.end_date && new Date(p.end_date) > new Date(p.initial_end_date)));

    // Activity (last 4 weeks, per recruiter per week)
    const since = new Date(now.getTime() - 28 * 86400000);
    const recent = acts.rows.filter((a) => a.created_at && new Date(a.created_at) >= since);
    const perRec = {};
    for (const a of recent) { const k = who(a.created_by); perRec[k] = perRec[k] || { recruiter: k, calls: 0, emails: 0, meetings: 0, tasks: 0 }; const t = stage(a.type); if (t === 'call') perRec[k].calls += 1; else if (t === 'email') perRec[k].emails += 1; else if (t === 'meeting') perRec[k].meetings += 1; else perRec[k].tasks += 1; }
    const perWeek = Object.values(perRec).map((r) => ({ recruiter: r.recruiter, calls_per_week: Math.round(r.calls / 4 * 10) / 10, emails_per_week: Math.round(r.emails / 4 * 10) / 10, meetings_per_week: Math.round(r.meetings / 4 * 10) / 10, tasks_per_week: Math.round(r.tasks / 4 * 10) / 10 }));
    const overdueActivities = acts.rows.filter((a) => a.status !== 'completed' && a.due_at && new Date(a.due_at) < now);
    const overdueLeads = leads.rows.filter((l) => ['replied', 'awaiting_info'].includes(l.workflow_status) && l.follow_up_due_at && new Date(l.follow_up_due_at) < now);

    const m = (value, definition, extra) => ({ value, definition, ...(extra || {}) });
    res.json({
      generated_at: now.toISOString(),
      pipeline: {
        open_pipeline_value: m(open.reduce((s, o) => s + num(o.value), 0), 'Sum of value on opportunities not yet closed.', { count: open.length }),
        closed_won_value: m(won.reduce((s, o) => s + num(o.value), 0), 'Sum of value on opportunities marked Closed Won.', { count: won.length }),
        win_rate: m(pct(won.length, won.length + lost.length), 'Closed Won divided by all closed deals (won + lost), as a percentage.'),
        avg_deal_size: m(won.length ? Math.round(won.reduce((s, o) => s + num(o.value), 0) / won.length) : null, 'Closed-won value divided by the number of won deals.'),
        fees_per_placement: m(places.rows.length ? Math.round(fees / places.rows.length) : null, 'Total placement fees divided by the number of placements.', { total_fees: fees, placements: places.rows.length }),
        revenue_per_recruiter: m(Object.entries(revenueByRecruiter).map(([recruiter, v]) => ({ recruiter, fees: v.value, placements: v.count })).sort((a, b) => b.fees - a.fees), 'Placement fees grouped by the user who recorded the placement.'),
      },
      speed: {
        hours_to_first_response: m(hoursToFirstResponse, 'Average hours from a lead being created to the first reply sent.', { leads: replied.length }),
        days_to_first_submission: m(daysToFirstSubmission, 'Average days from a job order being created to its first submission.', { job_orders: Object.keys(firstSubByJob).length }),
        days_to_fill: m(daysToFill, 'Average days from a job order being created to the placement start date.', { placements: places.rows.length }),
        days_to_hire: m(daysToHire, 'Average days from a candidate being submitted to the placement being recorded.', { placements: places.rows.length }),
      },
      volume: {
        leads_per_source: m(Object.entries(leadsPerSource).map(([source, v]) => ({ source, count: v.count })).sort((a, b) => b.count - a.count), 'Leads grouped by source.'),
        lead_to_opportunity_rate: m(pct(leads.rows.filter((l) => l.opportunity_id).length, leads.rows.length), 'Leads that became an opportunity, as a percentage of all leads.', { leads: leads.rows.length, opportunities: leads.rows.filter((l) => l.opportunity_id).length }),
        submissions_per_job_order: m(jobsWithSubs ? Math.round(subs.rows.length / jobsWithSubs * 10) / 10 : null, 'Submissions divided by job orders that received at least one.', { submissions: subs.rows.length, job_orders: jobsWithSubs }),
        submission_to_interview_rate: m(pct(interviewed.length, subs.rows.length), 'Submissions that reached an interview stage (phone screen or later), as a percentage of all submissions.', { interviewed: interviewed.length, submissions: subs.rows.length }),
        interview_to_offer_rate: m(pct(offered.length, interviewed.length), 'Interviewed submissions that reached Offer or beyond, as a percentage.', { offered: offered.length, interviewed: interviewed.length }),
        offer_acceptance_rate: m(pct(accepted.length, offered.length), 'Offers that became Hired, as a percentage of offers.', { accepted: accepted.length, offered: offered.length }),
        placements_per_recruiter: m(Object.entries(placementsByRecruiter).map(([recruiter, v]) => ({ recruiter, placements: v.count })).sort((a, b) => b.placements - a.placements), 'Placements grouped by the user who recorded them.'),
      },
      sourcing: {
        candidates_per_source: m(Object.entries(candsPerSource).map(([source, v]) => ({ source, count: v.count })).sort((a, b) => b.count - a.count), 'Candidates grouped by where they came from (resume upload, sourced board, referral...).'),
        cost_per_hire: m(places.rows.length ? Math.round(num(process.env.SOURCING_SPEND_YTD) / places.rows.length) : 0, 'Sourcing spend divided by placements. Set SOURCING_SPEND_YTD on the API service if paid sources are used; the built-in boards are free.', { spend: num(process.env.SOURCING_SPEND_YTD) }),
        pct_candidates_us_authorized: m(pct(authorized, cands.rows.length), 'Candidates with an explicit US work authorization on file, as a percentage of all candidates.', { authorized, candidates: cands.rows.length }),
      },
      retention: {
        falloff_rate_90d: m(pct(fellOff.length, matured.length + fellOff.length), 'Placements that ended within 90 days of starting, as a percentage of placements old enough to judge.', { fell_off: fellOff.length, matured: matured.length }),
        extension_rate: m(pct(extended.length, withEnd.length), 'Contract placements whose end date was pushed past the original end date (or marked extended), as a percentage of placements with an end date.', { extended: extended.length, with_end_date: withEnd.length }),
      },
      activity: {
        per_recruiter_per_week: m(perWeek, 'Average weekly calls, emails, meetings and tasks per recruiter over the last four weeks.'),
        overdue_followups: m(overdueActivities.length + overdueLeads.length, 'Pending activities past their due date plus leads whose follow-up window has passed.', { activities: overdueActivities.length, leads: overdueLeads.length }),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/staffing/dashboard', authenticateToken, async (req, res) => {
  try {
    const [cands, jobs, subs, places] = await Promise.all([pool.query('SELECT * FROM candidates'), pool.query('SELECT * FROM job_orders'), pool.query('SELECT * FROM submissions'), pool.query('SELECT * FROM placements')]);
    const now = new Date(); const thisMonth = monthKey(now); const year = now.getUTCFullYear();
    const openJobs = jobs.rows.filter((j) => !['filled', 'closed', 'cancelled'].includes(String(j.status || 'open').toLowerCase()));
    const cap = (s) => { const t = String(s || 'active').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
    const candByStatus = {}; for (const c of cands.rows) { const k = cap(c.status); candByStatus[k] = (candByStatus[k] || 0) + 1; }
    const stageName = (s) => { const t = String(s || 'submitted').toLowerCase(); return ({ submitted: 'Submitted', identified: 'Identified', 'phone screen': 'Phone Screen', screening: 'Phone Screen', technical: 'Technical', interview: 'Hiring Manager', 'hiring manager': 'Hiring Manager', 'final round': 'Final Round', offer: 'Offer', hired: 'Placed', placed: 'Placed', rejected: 'Rejected', withdrew: 'Withdrew', withdrawn: 'Withdrew' })[t] || cap(t); };
    const subsByStage = {}; for (const s of subs.rows) { const k = stageName(s.status); subsByStage[k] = (subsByStage[k] || 0) + 1; }
    const placedThisMonth = places.rows.filter((p) => p.start_date && monthKey(p.start_date) === thisMonth);
    const jobById = new Map(jobs.rows.map((j) => [String(j.id), j]));
    const clients = {}; for (const j of openJobs) { const k = j.company || 'Unknown'; clients[k] = (clients[k] || 0) + 1; }
    const urgent = openJobs.filter((j) => ['critical', 'high'].includes(String(j.priority || '').toLowerCase()) || (j.target_fill_date && (new Date(j.target_fill_date) - now) < 14 * 86400000))
      .sort((a, b) => new Date(a.target_fill_date || '2099-01-01') - new Date(b.target_fill_date || '2099-01-01')).slice(0, 8)
      .map((j) => ({ id: j.id, title: j.title, account: j.company, priority: j.priority || 'High', target_fill_date: j.target_fill_date }));
    const skills = {}; for (const c of cands.rows) for (const sk of String(c.skills || '').split(',').map((x) => x.trim()).filter(Boolean)) skills[sk] = (skills[sk] || 0) + 1;
    res.json({
      openJobs: openJobs.length, totalJobs: jobs.rows.length, candidates: cands.rows.length,
      placementsThisMonth: { count: placedThisMonth.length, fees: placedThisMonth.reduce((s, p) => s + num(p.fee_amount), 0) },
      feeYTD: places.rows.filter((p) => p.start_date && new Date(p.start_date).getUTCFullYear() === year).reduce((s, p) => s + num(p.fee_amount), 0),
      placementsTotal: places.rows.length, activePlacements: places.rows.filter((p) => String(p.placement_status || 'active').toLowerCase() === 'active').length,
      submissionsByStage: Object.entries(subsByStage).map(([stage, count]) => ({ stage, count })), submissionsTotal: subs.rows.length,
      candidatesByStatus: Object.entries(candByStatus).map(([status, count]) => ({ status, count })),
      topClients: Object.entries(clients).map(([account, open_jobs]) => ({ account, open_jobs })).sort((a, b) => b.open_jobs - a.open_jobs).slice(0, 6),
      urgentJobs: urgent, topSkills: Object.entries(skills).map(([skill, count]) => ({ skill, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      funnel: { candidates: cands.rows.length, submissions: subs.rows.length, placements: places.rows.length, fill_rate: jobs.rows.length ? Math.round((jobs.rows.filter((j) => String(j.status || '').toLowerCase() === 'filled').length / jobs.rows.length) * 100) : 0 },
      jobs_with_deal: jobs.rows.filter((j) => j.opportunity_id).length, generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/placements/:id', authenticateToken, async (req, res) => {
  try {
    const prev = (await pool.query('SELECT * FROM placements WHERE id::text=$1', [String(req.params.id)])).rows[0];
    if (!prev) return res.status(404).json({ error: 'Placement not found' });
    const row = await updateRow('placements', PLACEMENT_COLS, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Placement not found' });
    auto.onPlacementUpdated(row, prev, req).catch((e) => console.error('⚠️ placement update hook:', e.message));
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
// ====== AUTOMATION: audit trail, checkpoints, client links, interviews, offers, e-signature ======
// (auto is declared with `var` hoisting semantics via the function below so the
// routes above can call auto.* at request time; install runs synchronously here.)
auto = automation.install({
  app, pool, events: new Events(pool), authenticateToken, requireAdmin, sendEmail, isEmailConfigured, insertRow, JOB_ORDER_COLS,
  markdownToHtml, buildCandidateProfile, isProfileAIConfigured, leadWorkflow, contactsSync, roleCache: roleGuard.roles,
});
// Users & roles changes must clear the cached role.
app.use('/api/users', (req, res, next) => { if (!['GET', 'HEAD'].includes(req.method)) roleGuard.roles.clear(); next(); });
app.get('/api/roles/matrix', authenticateToken, (req, res) => res.json({ matrix: roles.MATRIX, ownership: process.env.OWNERSHIP_MODE !== 'off', nda_gate: process.env.NDA_GATE !== 'off', scoping: process.env.SCOPE_MODE !== 'off', scoped: Object.keys(roles.SCOPED), scoped_roles: roles.SCOPE_ROLES }));
// SLA watchdog, weekly digest, maintenance, post-placement cadence
const watchdog = require('./watchdog').install({ pool, events: auto.events, notify: auto.notify, notifyOwners: auto.notifyOwners, sendEmail, isEmailConfigured, matching, roleCache: roleGuard.roles, jwt, jwtSecret: JWT_SECRET, port: PORT, app, authenticateToken, requireAdmin });
// Candidate outreach from AI matches
const outreach = require('./outreach').install({ app, pool, events: auto.events, authenticateToken, notifyOwners: auto.notifyOwners, runMatch, createSignatureRequest: auto.createSignatureRequest, sendSignatureRequest: auto.sendSignatureRequest, normalizeSubmissionStatus: automation.normalizeSubmissionStatus, throttle: auto.throttle });
// Timesheets, approvals, invoices, QuickBooks
const timesheets = require('./timesheets').install({ app, pool, events: auto.events, authenticateToken, requireAdmin, notifyOwners: auto.notifyOwners, sendEmail, isEmailConfigured, throttle: auto.throttle, jwt, jwtSecret: JWT_SECRET });
auto.registerWorkers({ ...watchdog.workers, ...outreach.workers, ...timesheets.workers });
auto.hooks.afterPlacement.push(watchdog.schedulePlacementJobs, timesheets.schedulePlacement);
auto.hooks.intakeApproved = (job, req) => auto.events.enqueue('outreach.suggest', { job_order_id: job.id, created_by: req.user.id }, { dedupeKey: `outreach.suggest:${job.id}`, maxAttempts: 2 });
auto.hooks.bootstrap = watchdog.bootstrap;
// Reply as myself (admin): personal interest reply + tailored resume attachment
const personal = require('./personal-reply').install({ app, pool, authenticateToken, requireAdmin, sendEmail, textToHtml, leadWorkflow, events: auto.events, extractText, resumeUpload, notifyOwners: auto.notifyOwners });
leadWorkflow.onPersonalInbound = personal.onPersonalInbound;

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
  auto.startJobRunner();
});

module.exports = { app, syncApolloJobOrders };
