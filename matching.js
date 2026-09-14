// AI-based candidate matching.
//
// Two layers, blended:
//   1. A deterministic profile score (skills with synonym normalization,
//      title similarity, experience fit, location / work arrangement,
//      rate fit, availability, work authorization). Cheap; runs for every
//      candidate and produces a transparent breakdown.
//   2. A model assessment for the top candidates (Claude, structured output)
//      that reads the actual job text and the candidate's background and
//      scores skills, experience, domain, and logistics fit with a written
//      rationale, strengths, and gaps.
// Final score = 40% deterministic + 60% model when the model ran, else the
// deterministic score. Results are stored per (target, candidate).

const Anthropic = require('@anthropic-ai/sdk');
const { screenUS } = require('./work-auth');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = process.env.MATCH_AI_MODEL || 'claude-opus-5';

const SYNONYMS = {
  'js': 'javascript', 'node': 'node.js', 'nodejs': 'node.js', 'reactjs': 'react', 'react.js': 'react', 'postgres': 'postgresql', 'ms sql': 'sql server',
  'mssql': 'sql server', 'k8s': 'kubernetes', 'aws cloud': 'aws', 'amazon web services': 'aws', 'azure cloud': 'azure', 'gcp': 'google cloud',
  'snow': 'servicenow', 'service now': 'servicenow', 'itil v4': 'itil', 'itilv4': 'itil', 'ci/cd': 'cicd', 'ci cd': 'cicd', 'sam': 'software asset management',
  'ham': 'hardware asset management', 'it asset management': 'itam', 'it service management': 'itsm', 'cmdb': 'cmdb', 'ts': 'typescript', 'py': 'python',
  'active directory': 'active directory', 'ad': 'active directory', 'o365': 'office 365', 'm365': 'office 365', 'microsoft 365': 'office 365',
  'sfdc': 'salesforce', 'pm': 'project management', 'ba': 'business analysis', 'qa': 'quality assurance', 'ml': 'machine learning',
};
const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'to', 'senior', 'sr', 'jr', 'junior', 'lead', 'principal', 'staff', 'ii', 'iii', 'iv', 'i', 'level']);

function normSkill(s) {
  const t = String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return SYNONYMS[t] || t;
}
function skillList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').replace(/^\{|\}$/g, '').split(/[,;|\n]/);
  return [...new Set(arr.map(normSkill).filter(Boolean))];
}
function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter((t) => t && !STOP.has(t)).map((t) => SYNONYMS[t] || t);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Skills mentioned anywhere in free text (job description), matched against a vocabulary. */
function skillsInText(text, vocab) {
  const hay = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return vocab.filter((sk) => sk.length > 1 && new RegExp(`(^|[^a-z0-9])${escapeRe(sk)}(?=$|[^a-z0-9])`).test(hay));
}
function numFrom(v) {
  const m = String(v || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function yearsRequired(text) {
  const m = String(text || '').match(/(\d{1,2})\s*\+?\s*(?:years|yrs)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Deterministic score. target = { title, description, skills, location, work_arrangement, rate, employment_type }
 */
function deterministicScore(candidate, target) {
  const breakdown = {};
  const candSkills = skillList(candidate.skills);
  const candText = `${candidate.title || ''} ${candidate.resume_text || ''} ${candidate.notes || ''}`;
  const candVocab = [...new Set([...candSkills, ...skillList(skillsInText(candText, Object.values(SYNONYMS)))])];

  // Required skills: explicit list on the target, plus skills detected in the description.
  const targetSkills = [...new Set([...skillList(target.skills), ...skillsInText(`${target.title || ''} ${target.description || ''}`, [...new Set([...Object.values(SYNONYMS), ...candVocab])])])];
  let skillsScore = 50;
  let matched = [], missing = [];
  if (targetSkills.length) {
    matched = targetSkills.filter((s) => candVocab.includes(s));
    missing = targetSkills.filter((s) => !candVocab.includes(s));
    skillsScore = Math.round((matched.length / targetSkills.length) * 100);
  }
  breakdown.skills = { score: skillsScore, matched, missing, weight: 0.4 };

  // Title similarity (token overlap, order-insensitive).
  const tt = tokens(target.title), ct = tokens(candidate.title);
  const overlap = tt.filter((t) => ct.includes(t)).length;
  const titleScore = tt.length ? Math.round((overlap / tt.length) * 100) : 50;
  breakdown.title = { score: titleScore, weight: 0.15 };

  // Experience.
  const req = yearsRequired(target.description) ?? yearsRequired(target.title);
  const have = candidate.experience_years != null ? Number(candidate.experience_years) : null;
  let expScore = 60;
  if (req != null && have != null) expScore = have >= req ? 100 : Math.max(0, Math.round((have / req) * 100));
  else if (have != null) expScore = Math.min(100, 50 + have * 5);
  breakdown.experience = { score: expScore, required_years: req, candidate_years: have, weight: 0.15 };

  // Location / arrangement.
  const arr = String(target.work_arrangement || '').toLowerCase();
  const tLoc = String(target.location || '').toLowerCase();
  const cLoc = String(candidate.location || '').toLowerCase();
  let locScore = 70;
  if (arr.includes('remote') || tLoc.includes('remote')) locScore = 100;
  else if (tLoc && cLoc) {
    const tState = (tLoc.match(/\b([a-z]{2})\b$/) || [])[1];
    const same = tLoc.split(',')[0].trim() && cLoc.includes(tLoc.split(',')[0].trim());
    locScore = same ? 100 : (tState && cLoc.includes(tState) ? 75 : 30);
  }
  breakdown.location = { score: locScore, weight: 0.1 };

  // Rate fit: candidate's desired hourly rate vs target rate.
  const tRate = numFrom(target.rate), cRate = candidate.desired_rate != null ? Number(candidate.desired_rate) : null;
  let rateScore = 70;
  if (tRate && cRate) rateScore = cRate <= tRate ? 100 : Math.max(0, Math.round(100 - ((cRate - tRate) / tRate) * 200));
  breakdown.rate = { score: rateScore, target_rate: tRate, candidate_rate: cRate, weight: 0.1 };

  // Availability + status.
  const avail = String(candidate.availability || '').toLowerCase();
  const status = String(candidate.status || '').toLowerCase();
  let availScore = 70;
  if (avail.includes('not') || status === 'placed' || status === 'dnc') availScore = 10;
  else if (avail.includes('soon')) availScore = 60;
  else if (avail.includes('available') || status === 'active') availScore = 100;
  breakdown.availability = { score: availScore, weight: 0.1 };

  const total = Object.values(breakdown).reduce((acc, b) => acc + b.score * b.weight, 0);
  return { score: Math.round(total), breakdown };
}

const AssessmentSchema = z.object({
  skills_fit: z.number().min(0).max(100),
  experience_fit: z.number().min(0).max(100),
  domain_fit: z.number().min(0).max(100).describe('Industry / problem-domain familiarity relevant to this role.'),
  logistics_fit: z.number().min(0).max(100).describe('Location, work arrangement, rate, availability, authorization.'),
  overall: z.number().min(0).max(100).describe('Holistic likelihood this candidate is a strong submission for the role.'),
  strengths: z.array(z.string()).max(5),
  gaps: z.array(z.string()).max(5),
  rationale: z.string().describe('Two or three sentences a recruiter could repeat to the client.'),
});

let defaultClient = null;
function getClient() { if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 }); return defaultClient; }
function _setClientForTests(c) { defaultClient = c; }
function isMatchAIConfigured() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

async function aiAssess(candidate, target, options = {}) {
  const client = options.client || getClient();
  const payload = {
    role: { title: target.title, client: target.client_name || target.company || '', location: target.location, work_arrangement: target.work_arrangement, rate: target.rate, employment_type: target.employment_type, description: String(target.description || '').slice(0, 6000), required_skills: skillList(target.skills) },
    candidate: { title: candidate.title, years_experience: candidate.experience_years, skills: skillList(candidate.skills), location: candidate.location, availability: candidate.availability, work_authorization: candidate.work_auth, desired_rate: candidate.desired_rate, background: String(candidate.resume_text || '').slice(0, 6000), notes: String(candidate.notes || '').slice(0, 1500) },
  };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: 'You are a senior technical recruiter scoring how well a candidate matches a specific role. Be rigorous and calibrated: 90+ means an immediate submission, 70-89 a solid candidate with minor gaps, 50-69 a stretch, below 50 not a fit. Use only the information given.',
    output_config: { effort: 'medium', format: zodOutputFormat(AssessmentSchema) },
    messages: [{ role: 'user', content: `Score this match.\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>` }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
  return { ...response.parsed_output, model: response.model || MODEL };
}

/**
 * Rank candidates for a target (opportunity or job order).
 * deps: { pool, target: {kind, id, ...fields}, candidates?, limit, aiTop, useAI, client }
 */
async function rankCandidates(deps) {
  const { pool, target } = deps;
  const limit = Number(deps.limit || 10);
  const aiTop = Number(deps.aiTop ?? 5);
  const useAI = deps.useAI !== false && (deps.client || isMatchAIConfigured());
  const all = deps.candidates || (await pool.query("SELECT * FROM candidates WHERE COALESCE(status,'active') NOT IN ('DNC','dnc') ORDER BY id")).rows;

  // US work authorization screen (on by default): candidates who need
  // sponsorship or are outside the US are never ranked; with strict on,
  // candidates with nothing on file are held back too.
  const usOnly = deps.usOnly !== false, strictUS = deps.strictUS !== false;
  const excluded = { not_authorized: 0, unknown: 0 };
  const candidates = [];
  const screens = new Map();
  for (const c of all) {
    const scr = screenUS({ workAuth: c.work_auth, location: c.location, text: `${c.resume_text || ''}
${c.notes || ''}` });
    screens.set(String(c.id), scr);
    if (usOnly && scr.eligible === false) { excluded.not_authorized += 1; continue; }
    if (usOnly && strictUS && scr.eligible === null) { excluded.unknown += 1; continue; }
    candidates.push(c);
  }

  const scored = candidates.map((c) => ({ candidate: c, det: deterministicScore(c, target) }))
    .sort((a, b) => b.det.score - a.det.score);

  const results = [];
  for (let i = 0; i < Math.min(scored.length, limit); i++) {
    const { candidate, det } = scored[i];
    let ai = null;
    if (useAI && i < aiTop) {
      try { ai = await aiAssess(candidate, target, { client: deps.client }); } catch (err) { ai = { error: err.message }; }
    }
    const aiScore = ai && ai.overall != null ? Math.round(ai.overall) : null;
    const final = aiScore != null ? Math.round(det.score * 0.4 + aiScore * 0.6) : det.score;
    results.push({ candidate_id: candidate.id, candidate_name: candidate.name, candidate_title: candidate.title, score: final, deterministic_score: det.score, ai_score: aiScore, breakdown: det.breakdown, ai, rank: 0, us_work: screens.get(String(candidate.id)) });
  }
  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => { r.rank = i + 1; });
  results.excluded = excluded; results.us_only = usOnly; results.strict_us = strictUS;
  return results;
}

async function storeMatches(pool, target, results) {
  await pool.query('DELETE FROM candidate_matches WHERE target_kind=$1 AND target_id=$2', [target.kind, String(target.id)]);
  for (const r of results) {
    await pool.query(
      `INSERT INTO candidate_matches (target_kind, target_id, candidate_id, rank, score, deterministic_score, ai_score, breakdown, rationale, strengths, gaps, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [target.kind, String(target.id), String(r.candidate_id), r.rank, r.score, r.deterministic_score, r.ai_score, JSON.stringify(r.breakdown),
        r.ai && r.ai.rationale ? r.ai.rationale : null, r.ai && r.ai.strengths ? JSON.stringify(r.ai.strengths) : null, r.ai && r.ai.gaps ? JSON.stringify(r.ai.gaps) : null, r.ai && r.ai.model ? r.ai.model : null]);
  }
}

function targetFromOpportunity(o) {
  return { kind: 'opportunity', id: o.id, title: o.job_title || o.name, description: o.job_description || o.notes || '', skills: '', location: o.work_location || '', work_arrangement: o.work_arrangement || '', rate: o.rate || (o.value != null ? String(o.value) : ''), client_name: o.client_name || o.account || '', employment_type: '' };
}
function targetFromJobOrder(j) {
  return { kind: 'job_order', id: j.id, title: j.title, description: j.description || '', skills: j.required_skills || '', location: j.location || '', work_arrangement: '', rate: j.salary_range || '', client_name: j.company || '', employment_type: '' };
}

module.exports = { deterministicScore, aiAssess, rankCandidates, storeMatches, targetFromOpportunity, targetFromJobOrder, skillList, normSkill, isMatchAIConfigured, MODEL, _setClientForTests };
