// Client-facing candidate profiles for submissions.
// Redaction is the default: identifying details (name, email, phone,
// LinkedIn, street address, current employer) are removed from the data
// BEFORE it goes to the model, and the generated text is scrubbed again
// afterwards as a safety net. A named version is produced only on request.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = process.env.PROFILE_AI_MODEL || process.env.RESUME_AI_MODEL || 'claude-opus-5';

const ProfileSchema = z.object({
  headline: z.string().describe('One line, e.g. "Senior ServiceNow Developer with 8 years in ITSM/ITAM"'),
  summary: z.string().describe('Two to four sentences selling the candidate for this role, third person.'),
  key_strengths: z.array(z.string()).describe('3-5 short bullet points on what makes this candidate stand out.'),
  core_skills: z.array(z.string()).describe('Most relevant technical and professional skills, canonical spelling.'),
  experience_highlights: z.array(z.string()).describe('3-6 bullets of concrete accomplishments or scope of work.'),
  role_fit: z.string().describe('One or two sentences on fit for the specific job order, or general fit if no job order.'),
  logistics: z.string().describe('Availability, work authorization, location/remote preference, compensation expectations if known. Empty if unknown.'),
});

let defaultClient = null;
function getClient() {
  if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 });
  return defaultClient;
}
function _setClientForTests(client) { defaultClient = client; }

function isProfileAIConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const URL_RE = /https?:\/\/\S+|(?:www\.)?linkedin\.com\/\S+/gi;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){0,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Court|Ct\.?|Way|Place|Pl\.?|Circle|Cir\.?|Trail|Trl\.?|Parkway|Pkwy\.?)\b[^\n,]*/gi;

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Region only: keep city/state, drop anything that looks like a street address. */
function generalizeLocation(location) {
  if (!location) return '';
  const cleaned = String(location).replace(STREET_RE, '').replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '');
  return cleaned;
}

/** Remove a candidate's identifying strings from free text. */
function redactText(text, candidate = {}) {
  let out = String(text || '');
  out = out.replace(EMAIL_RE, '[email redacted]').replace(URL_RE, '[link redacted]').replace(PHONE_RE, '[phone redacted]').replace(STREET_RE, '[address redacted]');
  const name = String(candidate.name || '').trim();
  if (name) {
    const parts = name.split(/\s+/).map((p) => p.replace(/[.,]/g, '')).filter((p) => p.length > 1);
    if (parts.length >= 2) {
      // "First [Middle] Last" in any spacing/initial form -> one replacement.
      const first = escapeRegex(parts[0]);
      const last = escapeRegex(parts[parts.length - 1]);
      out = out.replace(new RegExp(`\\b${first}\\b(?:\\s+[A-Za-z][A-Za-z.]*){0,2}\\s+\\b${last}\\b`, 'gi'), 'the candidate');
    }
    // Then any remaining standalone first/last name mentions.
    for (const token of parts) {
      out = out.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi'), 'the candidate');
    }
    out = out.replace(/\b(the candidate)(\s+the candidate)+\b/gi, 'the candidate');
  }
  if (candidate.company) {
    const company = String(candidate.company).trim();
    out = out.replace(new RegExp(`\\b${escapeRegex(company)}\\b`, 'gi'), 'their current employer');
    // Also catch the distinctive words of the company name on their own
    // ("Acme" when the record says "Acme Corp"), skipping generic suffixes.
    const generic = new Set(['inc', 'inc.', 'llc', 'ltd', 'corp', 'corp.', 'co', 'co.', 'company', 'corporation', 'group', 'the', 'and', 'of', 'services', 'solutions', 'technologies', 'international', 'global']);
    for (const word of company.split(/\s+/)) {
      const w = word.replace(/[.,]/g, '');
      if (w.length > 3 && !generic.has(w.toLowerCase())) {
        out = out.replace(new RegExp(`\\b${escapeRegex(w)}\\b`, 'gi'), 'their current employer');
      }
    }
    out = out.replace(/\b(their current employer)(\s+their current employer)+\b/gi, 'their current employer');
  }
  return out;
}

function initialsLabel(candidate) {
  const parts = String(candidate.name || '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.map((p) => p[0].toUpperCase()).join('.');
  return initials ? `Candidate ${initials}.` : `Candidate #${candidate.id || ''}`.trim();
}

/** Build the data object the model sees. Redacted mode contains no PII. */
function prepareCandidateData(candidate, jobOrder, redacted) {
  const skills = Array.isArray(candidate.skills) ? candidate.skills.join(', ') : (candidate.skills || '');
  const base = {
    title: candidate.title || '',
    years_experience: candidate.experience_years ?? null,
    skills,
    location: redacted ? generalizeLocation(candidate.location) : (candidate.location || ''),
    work_authorization: candidate.work_auth || '',
    availability: [candidate.availability, candidate.availability_date].filter(Boolean).join(' from '),
    desired_rate: candidate.desired_rate ?? null,
    desired_salary: candidate.desired_salary ?? null,
    background: redacted ? redactText(candidate.resume_text || '', candidate) : (candidate.resume_text || ''),
    recruiter_notes: redacted ? redactText(candidate.notes || '', candidate) : (candidate.notes || ''),
  };
  if (!redacted) {
    base.name = candidate.name || '';
    base.current_company = candidate.company || '';
  }
  const job = jobOrder ? {
    title: jobOrder.title || '',
    company: jobOrder.company || '',
    location: jobOrder.location || '',
    description: jobOrder.description || '',
    salary_range: jobOrder.salary_range || '',
  } : null;
  return { candidate: base, job_order: job };
}

function renderMarkdown(profile, { label, jobOrder, redacted }) {
  const lines = [];
  lines.push(`# Candidate Profile: ${label}`);
  if (jobOrder && jobOrder.title) lines.push(`*Submitted for:* ${jobOrder.title}${jobOrder.company ? ` at ${jobOrder.company}` : ''}`);
  lines.push('');
  lines.push(`**${profile.headline}**`);
  lines.push('');
  lines.push(profile.summary);
  lines.push('');
  if (profile.key_strengths.length) { lines.push('## Key Strengths'); profile.key_strengths.forEach((s) => lines.push(`- ${s}`)); lines.push(''); }
  if (profile.core_skills.length) { lines.push('## Core Skills'); lines.push(profile.core_skills.join(' · ')); lines.push(''); }
  if (profile.experience_highlights.length) { lines.push('## Experience Highlights'); profile.experience_highlights.forEach((s) => lines.push(`- ${s}`)); lines.push(''); }
  if (profile.role_fit) { lines.push('## Fit for This Role'); lines.push(profile.role_fit); lines.push(''); }
  if (profile.logistics) { lines.push('## Logistics'); lines.push(profile.logistics); lines.push(''); }
  lines.push('---');
  lines.push(redacted
    ? '*Identifying details are withheld at this stage. Full contact information is available from Peek IT Services on request.*'
    : '*Presented by Peek IT Services.*');
  return lines.join('\n');
}

/**
 * Generate a profile.
 * @param {{candidate: object, jobOrder?: object, redacted?: boolean}} input
 * @param {{client?: object}} [options]
 */
async function buildCandidateProfile({ candidate, jobOrder = null, redacted = true }, options = {}) {
  if (!candidate) throw Object.assign(new Error('candidate is required'), { status: 400 });
  const client = options.client || getClient();
  const data = prepareCandidateData(candidate, jobOrder, redacted);

  const system = [
    'You write concise, persuasive candidate profiles that a staffing agency sends to its client to present a candidate for a role.',
    'Write in the third person. Use only facts present in the data; do not invent employers, dates, certifications, or metrics.',
    redacted
      ? 'This is a BLIND profile: never mention the candidate\'s name, employer names, email, phone, links, or street address. Refer to them as "the candidate". Describe employers generically (e.g. "a Fortune 500 insurer").'
      : 'Use the candidate\'s name naturally.',
    'Tailor the profile to the job order when one is provided.',
  ].join(' ');

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system,
    output_config: { effort: 'low', format: zodOutputFormat(ProfileSchema) },
    messages: [{ role: 'user', content: `Create the candidate profile from this data.\n\n<data>\n${JSON.stringify(data, null, 2)}\n</data>` }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to write this profile'), { status: 422, code: 'AI_REFUSAL' });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('The model returned no parseable profile');

  // Safety net: scrub anything identifying that slipped through.
  const scrub = (v) => (redacted ? redactText(v, candidate) : v);
  const profile = {
    headline: scrub(parsed.headline || ''),
    summary: scrub(parsed.summary || ''),
    key_strengths: (parsed.key_strengths || []).map(scrub).filter(Boolean),
    core_skills: (parsed.core_skills || []).map((s) => s.trim()).filter(Boolean),
    experience_highlights: (parsed.experience_highlights || []).map(scrub).filter(Boolean),
    role_fit: scrub(parsed.role_fit || ''),
    logistics: scrub(parsed.logistics || ''),
  };
  const label = redacted ? initialsLabel(candidate) : (candidate.name || 'Candidate');
  return {
    redacted,
    label,
    profile,
    markdown: renderMarkdown(profile, { label, jobOrder, redacted }),
    model: response.model || MODEL,
  };
}

function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  const out = [];
  let inList = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('- ')) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (line.startsWith('# ')) out.push(`<h2>${inline(line.slice(2))}</h2>`);
    else if (line.startsWith('## ')) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (line === '---') out.push('<hr/>');
    else if (line === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

module.exports = { buildCandidateProfile, redactText, generalizeLocation, initialsLabel, prepareCandidateData, renderMarkdown, markdownToHtml, isProfileAIConfigured, MODEL, _setClientForTests };
