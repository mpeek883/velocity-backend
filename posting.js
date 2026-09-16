// Job postings: the text a recruiter pastes into Indeed, Dice, LinkedIn or
// ZipRecruiter, and the record of where it was actually posted.
//
// Until now nothing in the pipeline produced a postable advert. A job order
// carried the recruiter's own email text, which is written to another
// recruiter, names the end client and quotes the bill rate - none of which
// belongs in a public posting. This builds a clean, client-safe advert from
// whatever the job order and its originating lead hold, stores it on the job
// order so it can be edited once and reused, and tracks each board it goes to
// so "where was this posted, and when" has an answer.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { roleRequirements } = require('./skills');

const MODEL = process.env.POSTING_AI_MODEL || 'claude-opus-5';
const COMPANY = process.env.FROM_NAME || 'Peek Talent Solutions';
const CONTACT_EMAIL = process.env.FROM_EMAIL || 'bradpeek@peekitservices.com';
const CONTACT_PHONE = process.env.POSTING_CONTACT_PHONE || '301-710-4423';

// Boards a posting is normally taken to. `post_url` is where a person goes to
// paste it; none of these have an API we are entitled to post through, so the
// step is deliberately "copy, open, paste, then record it here".
const BOARDS = [
  { id: 'indeed', name: 'Indeed', post_url: 'https://employers.indeed.com/p/post-job', note: 'Largest reach. Free postings are rate-limited; sponsored posts are paid.' },
  { id: 'linkedin', name: 'LinkedIn', post_url: 'https://www.linkedin.com/talent/post-a-job', note: 'One free job at a time per account.' },
  { id: 'dice', name: 'Dice', post_url: 'https://www.dice.com/employer', note: 'Best response rate for IT contract roles. Paid.' },
  { id: 'ziprecruiter', name: 'ZipRecruiter', post_url: 'https://www.ziprecruiter.com/post-job', note: 'Syndicates to a hundred-plus smaller boards. Free trial, then paid.' },
  { id: 'google', name: 'Google Jobs', post_url: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting', note: 'Picked up automatically from a careers page carrying JobPosting markup.' },
  { id: 'other', name: 'Other', post_url: '', note: 'A niche board, a user group, or a direct share.' },
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS job_board_posts (
    id SERIAL PRIMARY KEY,
    job_order_id TEXT,
    board VARCHAR(40),
    board_name VARCHAR(80),
    url TEXT,
    status VARCHAR(20) DEFAULT 'posted',
    notes TEXT,
    applicants INTEGER DEFAULT 0,
    posted_by TEXT,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_job_board_posts_job ON job_board_posts (job_order_id)',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS job_posting TEXT',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS job_posting_generated_at TIMESTAMP',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS job_posting_model VARCHAR(100)',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS posted_boards TEXT',
];

const PostingSchema = z.object({
  headline: z.string().describe('The job title as it should appear on the board. No requisition numbers, no client name.'),
  summary: z.string().describe('Two or three sentences on the role and why it is worth applying for.'),
  responsibilities: z.array(z.string()).min(3).max(8),
  required_qualifications: z.array(z.string()).min(3).max(10),
  preferred_qualifications: z.array(z.string()).max(6),
});

let defaultClient = null;
function getClient() { if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 }); return defaultClient; }
function _setClientForTests(c) { defaultClient = c; }
function isPostingAIConfigured() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

/** Everything the posting can draw on, from the job order and the lead behind it. */
function postingContext(job, lead = null) {
  const req = roleRequirements({
    title: job.title,
    description: job.description,
    required_skills: job.required_skills,
    nice_to_have_skills: job.nice_to_have_skills,
    extraText: lead ? lead.job_description : '',
  });
  const arrangement = job.work_arrangement
    || (/(^|\s)(remote|hybrid|on-?site)\b/i.exec(String(job.location || '')) || [])[2]
    || (lead && lead.work_arrangement) || '';
  const location = String(job.location || '').replace(/^(remote|hybrid|on-?site)\s*-\s*/i, '').trim() || (lead && lead.job_location) || '';
  return {
    title: job.title || (lead && lead.job_title) || '',
    location, arrangement,
    employment_type: job.employment_type || (lead && lead.employment_type) || '',
    // The client's own bill rate never goes in a public posting; only the pay
    // rate we are advertising to candidates does.
    pay_rate: job.pay_rate || job.candidate_rate || '',
    description: job.description || (lead && lead.job_description) || '',
    required: req.must, preferred: req.nice, years: req.years,
  };
}

/** Assemble the final advert text from its parts. */
function renderPosting(parts, ctx) {
  const line = (label, value) => (value ? `${label}: ${value}` : '');
  const bullets = (items) => (items || []).map((x) => `- ${String(x).replace(/^[-*•]\s*/, '')}`).join('\n');
  const where = [ctx.arrangement, ctx.location].filter(Boolean).join(' - ');
  return [
    parts.headline || ctx.title,
    [line('Location', where), line('Employment type', ctx.employment_type), line('Rate', ctx.pay_rate)].filter(Boolean).join('  |  '),
    '',
    parts.summary,
    '',
    'What you will do',
    bullets(parts.responsibilities),
    '',
    'What you need',
    bullets(parts.required_qualifications),
    (parts.preferred_qualifications || []).length ? `\nNice to have\n${bullets(parts.preferred_qualifications)}` : '',
    '',
    'Work authorization: applicants must be authorized to work in the United States without sponsorship.',
    '',
    `How to apply: reply to this posting, or send your resume to ${CONTACT_EMAIL}.`,
    '',
    `${COMPANY}`,
    `${CONTACT_EMAIL} | ${CONTACT_PHONE}`,
    '',
    `${COMPANY} is an equal opportunity employer. All qualified applicants are considered without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, disability, or veteran status.`,
  ].filter((x) => x !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The advert we can build with no model available. */
function templatePosting(job, lead = null) {
  const ctx = postingContext(job, lead);
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  return {
    posting: renderPosting({
      headline: ctx.title,
      summary: `${COMPANY} is hiring a ${ctx.title}${ctx.location ? ` in ${ctx.location}` : ''}. ${ctx.description ? String(ctx.description).split(/\n\n/)[0].slice(0, 400) : 'Full details are available on request.'}`,
      responsibilities: ['Deliver the work described above alongside the client team.', 'Work with stakeholders to turn requirements into working solutions.', 'Document what you build and hand it over cleanly.'],
      required_qualifications: [
        ...(ctx.years ? [`${ctx.years}+ years of relevant professional experience`] : []),
        ...ctx.required.map(cap),
      ].slice(0, 10),
      preferred_qualifications: ctx.preferred.map(cap),
    }, ctx),
    model: 'template',
  };
}

/**
 * Write a job posting for this job order. Falls back to the template when the
 * model is unavailable, so this never leaves a recruiter with nothing to post.
 */
async function generatePosting(job, lead = null, options = {}) {
  const ctx = postingContext(job, lead);
  if (!isPostingAIConfigured() && !options.client) return templatePosting(job, lead);
  const client = options.client || getClient();
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [
        `You write job postings for ${COMPANY}, an IT staffing firm, to publish on public job boards such as Indeed, Dice, LinkedIn and ZipRecruiter.`,
        'The posting is read by candidates, not by the client, so it must be clean, specific and appealing.',
        'Hard rules: never name the end client or any company the role is for; never mention a bill rate, a margin, a fee, or anything about the staffing arrangement; never include requisition numbers, internal notes, recruiter names or email threads.',
        'Use only what the context gives you. Do not invent benefits, salary figures, team sizes or certifications that are not stated.',
        'Write plainly in the second person ("you will"), no marketing superlatives, no emoji.',
      ].join(' '),
      output_config: { effort: 'low', format: zodOutputFormat(PostingSchema) },
      messages: [{ role: 'user', content: `Write the posting.\n\n<context>\n${JSON.stringify({ ...ctx, description: String(ctx.description).slice(0, 6000) }, null, 2)}\n</context>` }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return templatePosting(job, lead);
    return { posting: renderPosting(response.parsed_output, ctx), model: response.model || MODEL, parts: response.parsed_output };
  } catch (err) {
    const fallback = templatePosting(job, lead);
    return { ...fallback, error: err.message };
  }
}

module.exports = { BOARDS, SCHEMA, generatePosting, templatePosting, renderPosting, postingContext, isPostingAIConfigured, MODEL, _setClientForTests };
