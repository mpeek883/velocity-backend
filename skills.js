// Shared vocabulary and extraction helpers for role requirements.
//
// Candidate matching, job-posting generation and the Authorize Search step all
// need the same answer to "what does this role actually require?" and "what can
// this person actually do?". Keeping that in one place means a job order, the
// recruiter email it came from and a resume are all read with the same
// vocabulary, so a skill written three different ways still matches.

// Alternate spellings -> the canonical form used everywhere else.
const SYNONYMS = {
  js: 'javascript', node: 'node.js', nodejs: 'node.js', 'node js': 'node.js',
  reactjs: 'react', 'react.js': 'react', 'react js': 'react', vuejs: 'vue', angularjs: 'angular',
  postgres: 'postgresql', 'ms sql': 'sql server', mssql: 'sql server', 'microsoft sql server': 'sql server',
  k8s: 'kubernetes', 'aws cloud': 'aws', 'amazon web services': 'aws', 'azure cloud': 'azure',
  gcp: 'google cloud', 'google cloud platform': 'google cloud',
  snow: 'servicenow', 'service now': 'servicenow', 'service-now': 'servicenow',
  'itil v4': 'itil', itilv4: 'itil', 'itil 4': 'itil',
  'ci/cd': 'cicd', 'ci cd': 'cicd', 'ci-cd': 'cicd',
  sam: 'software asset management', ham: 'hardware asset management',
  'it asset management': 'itam', 'software asset management': 'software asset management',
  'it service management': 'itsm', 'configuration management database': 'cmdb',
  ts: 'typescript', py: 'python', 'c sharp': 'c#', csharp: 'c#', dotnet: '.net', 'dot net': '.net',
  ad: 'active directory', o365: 'office 365', m365: 'office 365', 'microsoft 365': 'office 365',
  sfdc: 'salesforce', pm: 'project management', ba: 'business analysis',
  qa: 'quality assurance', ml: 'machine learning', ai: 'artificial intelligence',
  iac: 'infrastructure as code', 'terraform cloud': 'terraform',
  'power bi': 'power bi', powerbi: 'power bi', 'rest api': 'rest', 'restful': 'rest',
  'source control': 'git', github: 'git', gitlab: 'git',
  sox: 'sarbanes-oxley', 'fed ramp': 'fedramp', 'nist 800-53': 'nist',
};

// Skills we recognise in free text. Deliberately weighted toward the IT
// staffing work this system does (ServiceNow / ITAM / ITSM / cloud / data)
// rather than trying to be a universal taxonomy.
const VOCAB = [
  // ServiceNow and IT operations
  'servicenow', 'itsm', 'itam', 'itom', 'itbm', 'cmdb', 'itil', 'hardware asset management',
  'software asset management', 'discovery', 'service catalog', 'flow designer', 'integrationhub',
  'incident management', 'problem management', 'change management', 'asset management',
  'license management', 'snow license manager', 'flexera', 'ivanti', 'lansweeper', 'jamf', 'intune',
  'sccm', 'active directory', 'office 365', 'sharepoint', 'power platform', 'powershell',
  // Languages
  'javascript', 'typescript', 'python', 'java', 'c#', '.net', 'go', 'ruby', 'php', 'scala', 'kotlin',
  'swift', 'rust', 'perl', 'bash', 'sql', 'r', 'matlab', 'abap', 'cobol', 'vba',
  // Web and app
  'react', 'angular', 'vue', 'node.js', 'express', 'next.js', 'django', 'flask', 'spring',
  'spring boot', 'rails', 'laravel', 'graphql', 'rest', 'soap', 'html', 'css', 'tailwind',
  // Data
  'postgresql', 'mysql', 'sql server', 'oracle', 'mongodb', 'redis', 'elasticsearch', 'snowflake',
  'databricks', 'redshift', 'bigquery', 'hadoop', 'spark', 'kafka', 'airflow', 'dbt', 'etl',
  'power bi', 'tableau', 'looker', 'qlik', 'ssrs', 'ssis',
  // Cloud and platform
  'aws', 'azure', 'google cloud', 'kubernetes', 'docker', 'terraform', 'ansible', 'puppet', 'chef',
  'jenkins', 'cicd', 'github actions', 'gitlab ci', 'argocd', 'helm', 'openshift', 'vmware',
  'linux', 'windows server', 'infrastructure as code', 'serverless', 'lambda', 'ec2', 's3',
  // Security and compliance
  'cissp', 'security+', 'siem', 'splunk', 'qradar', 'crowdstrike', 'okta', 'sailpoint', 'cyberark',
  'zero trust', 'penetration testing', 'vulnerability management', 'soc 2', 'sarbanes-oxley',
  'hipaa', 'pci dss', 'fedramp', 'nist', 'iso 27001', 'cmmc',
  // Practice and delivery
  'agile', 'scrum', 'kanban', 'safe', 'jira', 'confluence', 'project management',
  'business analysis', 'quality assurance', 'test automation', 'selenium', 'cypress', 'playwright',
  'salesforce', 'sap', 'workday', 'peoplesoft', 'dynamics 365', 'netsuite',
  'machine learning', 'artificial intelligence', 'data science', 'nlp',
  'git', 'devops', 'sre', 'observability', 'datadog', 'new relic', 'grafana', 'prometheus',
];

// Words that carry no identity in a job title.
const TITLE_STOP = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'to', 'at', 'by',
  'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'mid', 'level',
  'i', 'ii', 'iii', 'iv', 'v', 'entry', 'experienced', 'expert',
  'contract', 'contractor', 'fulltime', 'full', 'time', 'part', 'permanent', 'perm', 'temp',
  'remote', 'hybrid', 'onsite', 'position', 'role', 'opening', 'opportunity', 'job', 'req',
  'w2', 'c2c', '1099', 'corp', 'urgent', 'immediate', 'need', 'needed', 'hiring',
]);

const clean = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

/** One skill string reduced to its canonical form. */
function normSkill(s) {
  const t = clean(s).replace(/[.,;]+$/, '');
  return SYNONYMS[t] || t;
}

/** A skills value (array, comma string, or Postgres array literal) as a canonical list. */
function skillList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).replace(/^\{|\}$/g, '').split(/[,;|\n]/);
  return [...new Set(arr.map(normSkill).filter(Boolean))];
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Skills from the shared vocabulary that appear in free text. `extra` adds
 * words to look for (for example the skills already on a candidate record) so
 * a term the vocabulary does not know about is still found on both sides.
 */
function extractSkills(text, extra = []) {
  const hay = clean(text);
  if (!hay) return [];
  const vocab = [...new Set([...VOCAB, ...Object.keys(SYNONYMS), ...skillList(extra)])];
  const found = new Set();
  for (const term of vocab) {
    if (term.length < 2) continue;
    // Word-boundary match that tolerates the punctuation real skills contain
    // (c#, .net, node.js, ci/cd) which \b does not handle.
    if (new RegExp(`(^|[^a-z0-9+#.])${escapeRe(term)}(?=$|[^a-z0-9+#])`).test(hay)) found.add(normSkill(term));
  }
  return [...found];
}

/**
 * Skills a job description explicitly calls out, split into must-have and
 * nice-to-have by the heading they sit under. Everything the model or a
 * recruiter typed under "required" counts for more than a passing mention.
 */
const REQUIRED_HEADING = /(^|\n)[^\n]{0,60}\b(required|requirements|must[- ]?have|qualifications|essential|minimum)\b[^\n]{0,40}\n/i;
const NICE_HEADING = /(^|\n)[^\n]{0,60}\b(nice[- ]?to[- ]?have|preferred|desired|plus(es)?|bonus|good to have)\b[^\n]{0,40}\n/i;

function sectionAfter(text, headingRe) {
  const m = String(text || '').match(headingRe);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = String(text).slice(start);
  // Stop at the next blank-line-separated heading.
  const end = rest.search(/\n\s*\n[^\n]{0,60}:\s*\n/);
  return end === -1 ? rest.slice(0, 2000) : rest.slice(0, end);
}

/**
 * Everything we can work out about what a role needs, from whatever text and
 * structured fields exist. Returns canonical skill lists plus years and rate.
 */
function roleRequirements({ title = '', description = '', required_skills = '', nice_to_have_skills = '', extraText = '' } = {}) {
  const explicit = skillList(required_skills);
  const explicitNice = skillList(nice_to_have_skills);
  const body = [description, extraText].filter(Boolean).join('\n\n');
  const fromRequired = extractSkills(sectionAfter(body, REQUIRED_HEADING));
  const fromNice = extractSkills(sectionAfter(body, NICE_HEADING));
  const fromBody = extractSkills(`${title}\n${body}`);

  const must = [...new Set([...explicit, ...fromRequired])];
  const nice = [...new Set([...explicitNice, ...fromNice])].filter((s) => !must.includes(s));
  // Anything else mentioned anywhere is a weak signal, not a requirement.
  const mentioned = fromBody.filter((s) => !must.includes(s) && !nice.includes(s));
  return { must, nice, mentioned, years: requiredYears(body) ?? requiredYears(title), rate: parseRate(body) };
}

/** Years of experience a description asks for, or null. */
function requiredYears(text) {
  const t = String(text || '');
  const m = t.match(/(\d{1,2})\s*(?:\+|plus)?\s*(?:-|to|–)?\s*(\d{1,2})?\s*(?:\+)?\s*(?:years?|yrs?)\b[^.\n]{0,30}\b(?:experience|exp\b)/i)
    || t.match(/\b(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?)/i)
    || t.match(/(\d{1,2})\s*\+\s*(?:years?|yrs?)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 40 ? n : null;
}

/** An hourly rate (or an annual salary converted to hourly) found in text, or null. */
function parseRate(text) {
  const t = String(text || '');
  const hourly = t.match(/\$\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/|\s*per\s*)?\s*(?:hr|hour)\b/i);
  if (hourly) return parseFloat(hourly[1]);
  const kSalary = t.match(/\$\s*(\d{2,3})\s*k\b/i);
  if (kSalary) return (parseFloat(kSalary[1]) * 1000) / 2080;
  const salary = t.match(/\$\s*(\d{2,3}),(\d{3})\b/);
  if (salary) return parseFloat(`${salary[1]}${salary[2]}`) / 2080;
  const bare = t.match(/\b(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/|\s*per\s*)\s*(?:hr|hour)\b/i);
  return bare ? parseFloat(bare[1]) : null;
}

/** Title words that actually identify the role. */
function titleTokens(s) {
  return [...new Set(
    clean(s).split(/[^a-z0-9.+#]+/)
      .filter((t) => t && !TITLE_STOP.has(t) && !/^\d+$/.test(t))
      .map((t) => SYNONYMS[t] || t),
  )];
}

/** Overlap of two titles as an F1 score (0-1): both directions must agree. */
function titleSimilarity(a, b) {
  const ta = titleTokens(a), tb = titleTokens(b);
  if (!ta.length || !tb.length) return null;
  const shared = ta.filter((t) => tb.includes(t)).length;
  if (!shared) return 0;
  const precision = shared / ta.length, recall = shared / tb.length;
  return (2 * precision * recall) / (precision + recall);
}

module.exports = {
  SYNONYMS, VOCAB, TITLE_STOP,
  normSkill, skillList, extractSkills, roleRequirements, requiredYears, parseRate,
  titleTokens, titleSimilarity, sectionAfter,
};
