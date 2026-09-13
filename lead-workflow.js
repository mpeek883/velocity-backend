// Recruiter lead reply workflow.
//
//   new -> reviewed (AI drafts the offer reply) -> replied / awaiting_info
//       -> interested -> opportunity_created        (recruiter confirms + details complete)
//       -> declined                                  (recruiter says no; close-out sent)
//       -> closed_no_response                        (no reply in 3 business days; close-out sent)
//
// Critical details we need before an opportunity is created: job title, job
// description, the client's name, the rate offered, and the work situation
// (remote / on-site with location / hybrid with location).

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { sendEmail, textToHtml, FROM_EMAIL } = require('./email');

const MODEL = process.env.LEAD_AI_MODEL || 'claude-opus-5';
const FOLLOW_UP_BUSINESS_DAYS = parseInt(process.env.LEAD_FOLLOW_UP_BUSINESS_DAYS || '3', 10);

const SIGNATURE = process.env.LEAD_REPLY_SIGNATURE || 'Best regards,\n\nBrad Peek\nManaging Member | PEEK IT Services LLC\n301-710-4423\nbradpeek@peekitservices.com\npeekitservices.com';
const NETWORK_SIZE = process.env.LEAD_NETWORK_SIZE || '5,000+';

const CRITICAL_FIELDS = [
  { key: 'job_title', label: 'the job title', has: (l) => !!(l.job_title && l.job_title.trim()) },
  { key: 'job_description', label: 'the job description', has: (l) => !!(l.job_description && l.job_description.trim().length >= 40) },
  { key: 'client_name', label: "the client's name", has: (l) => !!(l.end_client && l.end_client.trim()) },
  { key: 'rate', label: 'the rate being offered', has: (l) => !!(l.rate_or_salary && l.rate_or_salary.trim()) },
  { key: 'work_situation', label: 'the work situation (remote, 100% on-site with location, or hybrid with location)', has: (l) => {
      const arr = (l.work_arrangement || '').toLowerCase();
      if (arr.includes('remote')) return true;
      return !!(arr && l.job_location && l.job_location.trim());
    } },
];

function missingInfo(lead) {
  return CRITICAL_FIELDS.filter((f) => !f.has(lead)).map((f) => ({ key: f.key, label: f.label }));
}

function addBusinessDays(from, days) {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

let defaultClient = null;
function getClient() {
  if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 });
  return defaultClient;
}
function _setClientForTests(client) { defaultClient = client; }
function isAIConfigured() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

const DraftSchema = z.object({
  subject: z.string(),
  body: z.string().describe('Plain text email body. No markdown. Ends before the signature; the signature is appended separately.'),
});

function leadFirstName(lead) {
  return String(lead.name || '').trim().split(/\s+/)[0] || 'there';
}

/** Deterministic fallback used when the model is unavailable. */
function templateOfferReply(lead, missing) {
  const first = leadFirstName(lead);
  const role = lead.job_title ? `the ${lead.job_title} role` : 'the role you are looking to fill';
  const ask = missing.length
    ? `\n\nTo get started, could you send over ${missing.map((m) => m.label).join(', ').replace(/, ([^,]*)$/, ', and $1')}?`
    : '';
  const body = `Hi ${first},\n\nThank you for your email and for considering my credentials for ${role}.\n\nWhile I am not personally available for this role, we would be happy to help you find the right resource. We work with a network of ${NETWORK_SIZE} qualified professionals and can quickly identify people who are available and interested in being considered.\n\nAs soon as we identify a match, we will send over a candidate profile for your consideration. If you or your client would like to interview the candidate, just coordinate with us and we will arrange it.${ask}\n\nWe look forward to working with you.`;
  return { subject: `Re: ${lead.email_subject || role}`, body };
}

/**
 * Draft the offer reply with the model, personalized to the recruiter's email.
 */
async function draftOfferReply(lead, options = {}) {
  const missing = missingInfo(lead);
  if (!isAIConfigured() && !options.client) return { ...templateOfferReply(lead, missing), missing, model: 'template' };
  const client = options.client || getClient();
  const system = [
    'You write short, warm, professional replies on behalf of Brad Peek, Managing Member of PEEK IT Services LLC, a staffing firm.',
    'A recruiter or headhunter has emailed Brad about a role. Write the reply as Brad, in plain text, no markdown, no subject line inside the body, and do not include a signature (it is appended automatically).',
    'The reply MUST: (1) thank them for their email and for considering Brad\'s credentials for the role; (2) explain that Brad is not personally available for this role, but that PEEK IT would be happy to help them find a resource by working its network of ' + NETWORK_SIZE + ' qualified professionals to identify people who are available and interested; (3) say that once a match is identified, a candidate profile will be sent over for their consideration, and that if they or their client want to interview the candidate they can coordinate with PEEK IT to arrange it; (4) if any critical details are missing, ask for them specifically; (5) close by inviting them to confirm they would like PEEK IT\'s help.',
    'Adapt the tone and specifics to the content of their email. Keep it under 220 words.',
  ].join(' ');
  const context = {
    recruiter: { name: lead.name, title: lead.title, company: lead.company, email: lead.email },
    their_email: { subject: lead.email_subject, summary: lead.notes },
    role_as_understood: { job_title: lead.job_title, end_client: lead.end_client, location: lead.job_location, work_arrangement: lead.work_arrangement, rate: lead.rate_or_salary, employment_type: lead.employment_type, job_description: (lead.job_description || '').slice(0, 1500) },
    missing_details_to_request: missing.map((m) => m.label),
  };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system,
    output_config: { effort: 'low', format: zodOutputFormat(DraftSchema) },
    messages: [{ role: 'user', content: `Write the reply.\n\n<context>\n${JSON.stringify(context, null, 2)}\n</context>` }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return { ...templateOfferReply(lead, missing), missing, model: 'template' };
  const subject = response.parsed_output.subject || `Re: ${lead.email_subject || 'Your email'}`;
  return { subject, body: response.parsed_output.body.trim(), missing, model: response.model || MODEL };
}

const ReplyAnalysisSchema = z.object({
  interest: z.enum(['interested', 'not_interested', 'unclear']).describe('Whether the recruiter wants PEEK IT to help fill the role.'),
  provided: z.object({
    job_title: z.string(),
    job_description: z.string(),
    client_name: z.string(),
    rate: z.string(),
    work_location: z.string(),
    work_arrangement: z.string().describe('Remote, On-site, Hybrid, or empty if not stated.'),
  }).describe('Details stated in THIS email only; empty strings when absent.'),
  summary: z.string(),
});

async function analyzeInboundReply(lead, msg, options = {}) {
  const client = options.client || getClient();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: 'You read a recruiter\'s reply to a staffing firm\'s offer to help fill a role. Decide whether they want the help, and extract any role details they provide. Never invent details.',
    output_config: { effort: 'low', format: zodOutputFormat(ReplyAnalysisSchema) },
    messages: [{ role: 'user', content: `Our offer went to ${lead.name} at ${lead.company} about "${lead.job_title || lead.email_subject}".\n\nTheir reply:\nSubject: ${msg.subject}\n\n${String(msg.text || '').slice(0, 10000)}` }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return { interest: 'unclear', provided: {}, summary: 'Could not analyze reply' };
  return response.parsed_output;
}

function closeOutEmail(lead) {
  const first = leadFirstName(lead);
  return {
    subject: `Re: ${lead.email_subject || 'Your email'}`,
    body: `Hi ${first},\n\nThank you for your time and consideration. If we can ever help you find a resource for a role you are trying to fill, please do not hesitate to call on us. We would be glad to put our network to work for you.\n\nWishing you continued success.`,
  };
}

function followUpRequestEmail(lead, missing) {
  const first = leadFirstName(lead);
  const list = missing.map((m) => `- ${m.label}`).join('\n');
  return {
    subject: `Re: ${lead.email_subject || 'Your email'}`,
    body: `Hi ${first},\n\nThank you for confirming. To get started identifying the right resource, we just need a few more details:\n${list}\n\nOnce we have these, we will begin our search right away and send over candidate profiles as soon as we have a strong match.`,
  };
}

async function logEmail(pool, lead, { direction, kind, subject, body, message_id = null, from_email = null, to_email = null, analysis = null }) {
  const ins = await pool.query(
    `INSERT INTO lead_emails (lead_id, direction, kind, subject, body, message_id, from_email, to_email, analysis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [lead.id, direction, kind, subject, body, message_id, from_email, to_email, analysis ? JSON.stringify(analysis) : null]);
  return ins.rows[0];
}

async function setLead(pool, id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return null;
  const q = await pool.query(`UPDATE leads SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((c) => fields[c]), id]);
  return q.rows[0];
}

/** Send an email to the lead, log it, and update workflow fields. */
async function sendLeadEmail(pool, lead, { kind, subject, body, status, extra = {} }, options = {}) {
  if (!lead.email) throw Object.assign(new Error('Lead has no email address'), { status: 400 });
  const fullBody = `${body.trim()}\n\n${SIGNATURE}`;
  const result = await sendEmail({ to: lead.email, subject, text: fullBody, html: textToHtml(fullBody) }, options.sendOptions);
  await logEmail(pool, lead, { direction: 'outbound', kind, subject, body: fullBody, to_email: lead.email, from_email: FROM_EMAIL });
  const now = new Date();
  const fields = { workflow_status: status, ...extra };
  if (kind === 'offer_reply') { fields.replied_at = now; fields.follow_up_due_at = addBusinessDays(now, FOLLOW_UP_BUSINESS_DAYS); }
  if (kind === 'info_request') { fields.follow_up_due_at = addBusinessDays(now, FOLLOW_UP_BUSINESS_DAYS); }
  if (kind === 'close_out') { fields.follow_up_due_at = null; }
  const updated = await setLead(pool, lead.id, fields);
  return { ...result, lead: updated };
}

async function createOpportunityFromLead(pool, lead, analysis = {}) {
  const clientName = lead.end_client || lead.company;
  const title = lead.job_title || 'Staffing request';
  const rateNum = parseFloat(String(lead.rate_or_salary || '').replace(/[^0-9.]/g, '')) || null;
  const notes = [
    analysis.summary,
    `Recruiter: ${lead.name}${lead.title ? `, ${lead.title}` : ''} at ${lead.company}${lead.phone ? ` (${lead.phone})` : ''}`,
    lead.company_address ? `Address: ${lead.company_address}` : '',
    `Rate: ${lead.rate_or_salary || 'n/a'} | Type: ${lead.employment_type || 'n/a'} | Work: ${[lead.work_arrangement, lead.job_location].filter(Boolean).join(' - ') || 'n/a'}`,
    'Created automatically from recruiter email workflow.',
  ].filter(Boolean).join('\n');
  const ins = await pool.query(
    `INSERT INTO opportunities (name, account, contact, contact_email, value, stage, probability, type, notes, job_title, job_description, client_name, rate, work_location, work_arrangement, lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [`${clientName} - ${title}`, clientName, lead.name, lead.email, rateNum, 'Qualification', 40, 'New Business', notes,
      lead.job_title || null, lead.job_description || null, clientName, lead.rate_or_salary || null, lead.job_location || null, lead.work_arrangement || null, lead.id]);
  return ins.rows[0];
}

/**
 * Handle a reply from a recruiter we have written to.
 * Returns { action, lead, opportunity? }.
 */
async function handleInboundReply(pool, lead, msg, options = {}) {
  const analysis = await (options.analyze || ((l, m) => analyzeInboundReply(l, m, options)))(lead, msg);
  await logEmail(pool, lead, { direction: 'inbound', kind: 'reply', subject: msg.subject, body: String(msg.text || '').slice(0, 20000), message_id: msg.message_id, from_email: msg.from_email, analysis });

  // Apply any details they supplied.
  const p = analysis.provided || {};
  const updates = { last_inbound_at: new Date() };
  if (p.job_title) updates.job_title = p.job_title;
  if (p.job_description && p.job_description.length > (lead.job_description || '').length) updates.job_description = p.job_description;
  if (p.client_name) updates.end_client = p.client_name;
  if (p.rate) updates.rate_or_salary = p.rate;
  if (p.work_location) updates.job_location = p.work_location;
  if (p.work_arrangement) updates.work_arrangement = p.work_arrangement;
  let current = await setLead(pool, lead.id, updates);

  if (analysis.interest === 'not_interested') {
    const mail = closeOutEmail(current);
    const r = await sendLeadEmail(pool, current, { kind: 'close_out', ...mail, status: 'declined' }, options);
    return { action: 'declined_close_out_sent', lead: r.lead, analysis };
  }
  if (analysis.interest === 'interested') {
    const missing = missingInfo(current);
    if (missing.length) {
      const mail = followUpRequestEmail(current, missing);
      const r = await sendLeadEmail(pool, current, { kind: 'info_request', ...mail, status: 'awaiting_info', extra: { missing_info: JSON.stringify(missing.map((m) => m.key)) } }, options);
      return { action: 'info_requested', lead: r.lead, missing, analysis };
    }
    const opp = await createOpportunityFromLead(pool, current, analysis);
    current = await setLead(pool, current.id, { workflow_status: 'opportunity_created', opportunity_id: opp.id, follow_up_due_at: null, missing_info: '[]' });
    return { action: 'opportunity_created', lead: current, opportunity: opp, analysis };
  }
  // Unclear: keep waiting, but give them another window.
  current = await setLead(pool, current.id, { follow_up_due_at: addBusinessDays(new Date(), FOLLOW_UP_BUSINESS_DAYS) });
  return { action: 'unclear_waiting', lead: current, analysis };
}

/** Close out leads that never replied within the window. */
async function processFollowUps(pool, options = {}) {
  const due = await pool.query(
    `SELECT * FROM leads WHERE workflow_status IN ('replied','awaiting_info') AND follow_up_due_at IS NOT NULL AND follow_up_due_at <= $1 ORDER BY follow_up_due_at`,
    [options.now || new Date()]);
  const result = { checked: due.rows.length, closed: 0, errors: [] };
  for (const lead of due.rows) {
    try {
      const mail = closeOutEmail(lead);
      await sendLeadEmail(pool, lead, { kind: 'close_out', ...mail, status: 'closed_no_response' }, options);
      result.closed += 1;
    } catch (err) {
      result.errors.push({ lead_id: lead.id, error: err.message });
    }
  }
  return result;
}

module.exports = {
  CRITICAL_FIELDS, missingInfo, addBusinessDays, draftOfferReply, templateOfferReply, analyzeInboundReply,
  closeOutEmail, followUpRequestEmail, sendLeadEmail, handleInboundReply, processFollowUps, createOpportunityFromLead,
  logEmail, setLead, isAIConfigured, FOLLOW_UP_BUSINESS_DAYS, _setClientForTests,
};
