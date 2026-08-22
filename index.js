// VelocityCRM Backend API - Production Ready
// Node.js Express API with PostgreSQL, JWT Auth, and Free-Sources Scraping

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Test DB connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

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

// ============================================
// AUTH ENDPOINTS
// ============================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, org_id FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, org_id: user.org_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, email: user.email, org_id: user.org_id } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// CONTACTS ENDPOINTS
// ============================================

app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

app.post('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company_id, title, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO contacts (org_id, name, email, phone, company_id, title, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.org_id, name, email, phone, company_id, title, notes]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

app.put('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company_id, title, notes } = req.body;
    const result = await pool.query(
      'UPDATE contacts SET name=$1, email=$2, phone=$3, company_id=$4, title=$5, notes=$6, updated_at=NOW() WHERE id=$7 AND org_id=$8 RETURNING *',
      [name, email, phone, company_id, title, notes, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

app.delete('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM contacts WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ============================================
// ACCOUNTS ENDPOINTS
// ============================================

app.get('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM accounts WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

app.post('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const { name, industry, website, revenue, employees, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO accounts (org_id, name, industry, website, revenue, employees, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.org_id, name, industry, website, revenue, employees, notes]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating account:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.put('/api/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const { name, industry, website, revenue, employees, notes } = req.body;
    const result = await pool.query(
      'UPDATE accounts SET name=$1, industry=$2, website=$3, revenue=$4, employees=$5, notes=$6, updated_at=NOW() WHERE id=$7 AND org_id=$8 RETURNING *',
      [name, industry, website, revenue, employees, notes, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.delete('/api/accounts/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM accounts WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Account deleted' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ============================================
// CANDIDATES ENDPOINTS
// ============================================

app.get('/api/candidates', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM candidates WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

app.post('/api/candidates', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, title, company, location, experience_years, skills, source, status, availability, desired_rate, linkedin_url } = req.body;
    const result = await pool.query(
      'INSERT INTO candidates (org_id, name, email, phone, title, company, location, experience_years, skills, source, status, availability, desired_rate, linkedin_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *',
      [req.user.org_id, name, email, phone, title, company, location, experience_years, skills, source, status, availability, desired_rate, linkedin_url]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating candidate:', error);
    res.status(500).json({ error: 'Failed to create candidate' });
  }
});

app.put('/api/candidates/:id', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, title, company, location, experience_years, skills, source, status, availability, desired_rate, linkedin_url } = req.body;
    const result = await pool.query(
      'UPDATE candidates SET name=$1, email=$2, phone=$3, title=$4, company=$5, location=$6, experience_years=$7, skills=$8, source=$9, status=$10, availability=$11, desired_rate=$12, linkedin_url=$13, updated_at=NOW() WHERE id=$14 AND org_id=$15 RETURNING *',
      [name, email, phone, title, company, location, experience_years, skills, source, status, availability, desired_rate, linkedin_url, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating candidate:', error);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

app.delete('/api/candidates/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Candidate deleted' });
  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

// ============================================
// JOB ORDERS ENDPOINTS
// ============================================

app.get('/api/job-orders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM job_orders WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching job orders:', error);
    res.status(500).json({ error: 'Failed to fetch job orders' });
  }
});

app.post('/api/job-orders', authenticateToken, async (req, res) => {
  try {
    const { title, company_id, location, description, required_skills, experience_years, salary_min, salary_max, comp_type, remote_policy, status, priority } = req.body;
    const result = await pool.query(
      'INSERT INTO job_orders (org_id, title, company_id, location, description, required_skills, experience_years, salary_min, salary_max, comp_type, remote_policy, status, priority) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
      [req.user.org_id, title, company_id, location, description, required_skills, experience_years, salary_min, salary_max, comp_type, remote_policy, status || 'Prospecting', priority]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating job order:', error);
    res.status(500).json({ error: 'Failed to create job order' });
  }
});

app.put('/api/job-orders/:id', authenticateToken, async (req, res) => {
  try {
    const { title, company_id, location, description, required_skills, experience_years, salary_min, salary_max, comp_type, remote_policy, status, priority } = req.body;
    const result = await pool.query(
      'UPDATE job_orders SET title=$1, company_id=$2, location=$3, description=$4, required_skills=$5, experience_years=$6, salary_min=$7, salary_max=$8, comp_type=$9, remote_policy=$10, status=$11, priority=$12, updated_at=NOW() WHERE id=$13 AND org_id=$14 RETURNING *',
      [title, company_id, location, description, required_skills, experience_years, salary_min, salary_max, comp_type, remote_policy, status, priority, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating job order:', error);
    res.status(500).json({ error: 'Failed to update job order' });
  }
});

app.delete('/api/job-orders/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM job_orders WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Job order deleted' });
  } catch (error) {
    console.error('Error deleting job order:', error);
    res.status(500).json({ error: 'Failed to delete job order' });
  }
});

// ============================================
// SUBMISSIONS ENDPOINTS
// ============================================

app.get('/api/submissions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM submissions WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

app.post('/api/submissions', authenticateToken, async (req, res) => {
  try {
    const { candidate_id, job_order_id, status, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO submissions (org_id, candidate_id, job_order_id, status, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.org_id, candidate_id, job_order_id, status || 'Submitted', notes]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating submission:', error);
    res.status(500).json({ error: 'Failed to create submission' });
  }
});

app.put('/api/submissions/:id', authenticateToken, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const result = await pool.query(
      'UPDATE submissions SET status=$1, notes=$2, updated_at=NOW() WHERE id=$3 AND org_id=$4 RETURNING *',
      [status, notes, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating submission:', error);
    res.status(500).json({ error: 'Failed to update submission' });
  }
});

app.delete('/api/submissions/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Submission deleted' });
  } catch (error) {
    console.error('Error deleting submission:', error);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// ============================================
// PLACEMENTS ENDPOINTS
// ============================================

app.get('/api/placements', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM placements WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching placements:', error);
    res.status(500).json({ error: 'Failed to fetch placements' });
  }
});

app.post('/api/placements', authenticateToken, async (req, res) => {
  try {
    const { submission_id, start_date, end_date, salary, notes, guarantee_days } = req.body;
    const result = await pool.query(
      'INSERT INTO placements (org_id, submission_id, start_date, end_date, salary, notes, guarantee_days) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.org_id, submission_id, start_date, end_date, salary, notes, guarantee_days]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating placement:', error);
    res.status(500).json({ error: 'Failed to create placement' });
  }
});

app.put('/api/placements/:id', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date, salary, notes, guarantee_days } = req.body;
    const result = await pool.query(
      'UPDATE placements SET start_date=$1, end_date=$2, salary=$3, notes=$4, guarantee_days=$5, updated_at=NOW() WHERE id=$6 AND org_id=$7 RETURNING *',
      [start_date, end_date, salary, notes, guarantee_days, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating placement:', error);
    res.status(500).json({ error: 'Failed to update placement' });
  }
});

app.delete('/api/placements/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM placements WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Placement deleted' });
  } catch (error) {
    console.error('Error deleting placement:', error);
    res.status(500).json({ error: 'Failed to delete placement' });
  }
});

// ============================================
// CONTRACTS ENDPOINTS
// ============================================

app.get('/api/contracts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM contracts WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
});

app.post('/api/contracts', authenticateToken, async (req, res) => {
  try {
    const { name, type, account_id, contact_id, status, start_date, end_date, value, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO contracts (org_id, name, type, account_id, contact_id, status, start_date, end_date, value, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [req.user.org_id, name, type, account_id, contact_id, status || 'Draft', start_date, end_date, value, notes]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contract:', error);
    res.status(500).json({ error: 'Failed to create contract' });
  }
});

app.put('/api/contracts/:id', authenticateToken, async (req, res) => {
  try {
    const { name, type, account_id, contact_id, status, start_date, end_date, value, notes } = req.body;
    const result = await pool.query(
      'UPDATE contracts SET name=$1, type=$2, account_id=$3, contact_id=$4, status=$5, start_date=$6, end_date=$7, value=$8, notes=$9, updated_at=NOW() WHERE id=$10 AND org_id=$11 RETURNING *',
      [name, type, account_id, contact_id, status, start_date, end_date, value, notes, req.params.id, req.user.org_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating contract:', error);
    res.status(500).json({ error: 'Failed to update contract' });
  }
});

app.delete('/api/contracts/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM contracts WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
    res.json({ message: 'Contract deleted' });
  } catch (error) {
    console.error('Error deleting contract:', error);
    res.status(500).json({ error: 'Failed to delete contract' });
  }
});

// ============================================
// FREE SOURCES CANDIDATE SEARCH
// ============================================

app.post('/api/candidates/search/free-sources', authenticateToken, async (req, res) => {
  try {
    const { query, platform } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    // This endpoint returns results from free scraping platforms
    // Implementations: Jobvertise, Craigslist, Wellfound, PostJobFree
    // Each platform returns candidate data in standardized format

    const results = {
      platform: platform || 'all',
      query,
      candidates: [],
      timestamp: new Date(),
      message: 'Free sources search endpoint. Scraping implementations to be added.'
    };

    res.json(results);
  } catch (error) {
    console.error('Error searching free sources:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// APOLLO CANDIDATE SEARCH
// ============================================

app.post('/api/candidates/search', authenticateToken, async (req, res) => {
  try {
    const { query, limit = 25 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    // Apollo.io integration
    // Requires APOLLO_API_KEY in environment
    // Returns candidates with contact info (subject to Professional tier limitations)

    const results = {
      source: 'apollo',
      query,
      candidates: [],
      timestamp: new Date(),
      message: 'Apollo search endpoint. API integration to be configured.'
    };

    res.json(results);
  } catch (error) {
    console.error('Error searching candidates:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// DASHBOARD / ANALYTICS
// ============================================

app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const contactsCount = await pool.query('SELECT COUNT(*) as count FROM contacts WHERE org_id = $1', [req.user.org_id]);
    const candidatesCount = await pool.query('SELECT COUNT(*) as count FROM candidates WHERE org_id = $1', [req.user.org_id]);
    const jobOrdersCount = await pool.query('SELECT COUNT(*) as count FROM job_orders WHERE org_id = $1', [req.user.org_id]);
    const placementsCount = await pool.query('SELECT COUNT(*) as count FROM placements WHERE org_id = $1', [req.user.org_id]);

    res.json({
      contacts: parseInt(contactsCount.rows[0].count),
      candidates: parseInt(candidatesCount.rows[0].count),
      jobOrders: parseInt(jobOrdersCount.rows[0].count),
      placements: parseInt(placementsCount.rows[0].count),
    });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

app.get('/', (req, res) => {
  res.json({ message: 'VelocityCRM Backend API is running' });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, () => {
  console.log(`\n🚀 VelocityCRM Backend API listening on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 Authentication: JWT enabled`);
  console.log(`🔍 Free Sources: Ready for integration\n`);
});

module.exports = app;
