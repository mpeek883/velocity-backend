// Resume text extraction and lightweight field parsing.
// Supports PDF (pdf-parse), DOCX (mammoth), and plain text. Legacy binary
// .doc files are not supported.

const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt'];

// Common skills to look for. Matched case-insensitively on word boundaries;
// the canonical spelling here is what gets returned.
const SKILL_KEYWORDS = [
  // Languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'C++', 'Go', 'Rust', 'Ruby', 'PHP',
  'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'Perl', 'Bash', 'PowerShell', 'SQL', 'PL/SQL', 'T-SQL',
  // Frontend
  'React', 'Angular', 'Vue', 'Next.js', 'Redux', 'HTML', 'CSS', 'Sass', 'Tailwind', 'Bootstrap', 'jQuery',
  // Backend
  'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', '.NET', 'ASP.NET',
  'Rails', 'Laravel', 'GraphQL', 'REST', 'gRPC', 'Microservices',
  // Data
  'PostgreSQL', 'MySQL', 'SQL Server', 'Oracle', 'MongoDB', 'Redis', 'DynamoDB', 'Cassandra',
  'Elasticsearch', 'Snowflake', 'BigQuery', 'Redshift', 'Databricks', 'Spark', 'Hadoop', 'Kafka',
  'Airflow', 'dbt', 'Tableau', 'Power BI', 'Looker', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch',
  'Machine Learning', 'Data Science', 'Data Engineering', 'ETL',
  // Cloud / DevOps
  'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Jenkins',
  'GitHub Actions', 'GitLab', 'CI/CD', 'Linux', 'Windows Server', 'VMware', 'Nginx',
  // Enterprise / business systems
  'Salesforce', 'SAP', 'ServiceNow', 'Workday', 'NetSuite', 'QuickBooks', 'Dynamics 365',
  'SharePoint', 'Office 365', 'Active Directory', 'Okta',
  // Practices / roles
  'Agile', 'Scrum', 'Kanban', 'Jira', 'Confluence', 'Project Management', 'Product Management',
  'Business Analysis', 'UX', 'UI Design', 'Figma', 'QA', 'Test Automation', 'Selenium', 'Cypress',
  'Cybersecurity', 'Network Security', 'Penetration Testing', 'SIEM', 'Splunk',
  'Technical Support', 'Help Desk', 'IT Support', 'System Administration', 'Networking', 'Cisco',
  'Recruiting', 'Account Management', 'Sales', 'Customer Success', 'Marketing', 'SEO',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract plain text from an uploaded resume buffer.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @returns {Promise<string>}
 */
async function extractText(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.pdf') {
    // pdf.js reads the underlying ArrayBuffer from offset 0. Buffers that
    // multer assembles for small uploads come from Node's shared pool with a
    // non-zero byteOffset, which makes pdf.js see garbage ("bad XRef entry").
    // Hand it an exact, offset-free copy of the file bytes.
    const bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
    const data = await pdfParse(bytes);
    return data.text || '';
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (ext === '.txt') {
    return buffer.toString('utf8');
  }
  if (ext === '.doc') {
    const err = new Error('Legacy .doc files are not supported. Please save the resume as .docx or PDF.');
    err.status = 415;
    throw err;
  }
  const err = new Error(`Unsupported file type "${ext || 'unknown'}". Supported: PDF, DOCX, TXT.`);
  err.status = 415;
  throw err;
}

function looksLikeName(line) {
  if (!line || line.length > 40) return false;
  if (/\d|@|http|resume|curriculum|vitae|cv\b/i.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z'.-]*,?$/.test(w));
}

function guessName(lines, email) {
  const candidate = lines.slice(0, 10).find(looksLikeName);
  if (candidate) return candidate.replace(/,$/, '').trim();

  // Fall back to the email local part, e.g. "jane.doe" -> "Jane Doe".
  if (email) {
    const local = email.split('@')[0].replace(/\d+/g, '');
    const parts = local.split(/[._-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
  }
  return '';
}

function findSkills(text) {
  const found = [];
  for (const skill of SKILL_KEYWORDS) {
    // Skills that start/end with non-word characters (C#, C++, .NET) need
    // lookarounds instead of \b.
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(skill)}(?![A-Za-z0-9])`, 'i');
    if (re.test(text)) found.push(skill);
  }
  return found;
}

/**
 * Pull candidate fields out of resume text.
 * @param {string} text
 * @returns {{name: string, email: string, phone: string, skills: string}}
 */
function parseResumeText(text) {
  const normalized = (text || '').replace(/\r/g, '');
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);

  const emailMatch = normalized.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0] : '';

  const phoneMatch = normalized.match(PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0].trim() : '';

  const name = guessName(lines, email);
  const skills = findSkills(normalized).join(', ');

  return { name, email, phone, skills };
}

module.exports = { extractText, parseResumeText, SUPPORTED_EXTENSIONS, SKILL_KEYWORDS };
