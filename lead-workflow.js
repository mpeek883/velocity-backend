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

// Every email that leaves the Leads area is blind-copied here (set LEAD_EMAIL_BCC to '' to stop).
const LEAD_BCC = process.env.LEAD_EMAIL_BCC === undefined ? 'bradpeek@peekitservices.com' : process.env.LEAD_EMAIL_BCC;
const SIGNATURE = process.env.LEAD_REPLY_SIGNATURE || 'Best regards,\n\nBrad Peek\nManaging Member | Peek Talent Solutions\n301-710-4423\nbradpeek@peekitservices.com\npeekitservices.com';
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
/** Every reply threads on the recruiter's own subject: "RE: <their subject>" with any existing Re/Fw prefixes stripped. */
function replySubject(lead, fallback) {
  const base = String(lead.email_subject || fallback || lead.job_title || 'Your email').replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/i, '').trim();
  return `RE: ${base}`;
}
const ASK_LABEL = { job_title: 'The job title', job_description: 'The full job description', client_name: "The end client's name", rate: 'The rate being offered', work_situation: 'The work situation (remote, on-site with location, or hybrid)' };
const COUNT_WORD = ['one', 'two', 'three', 'four', 'five'];
function templateOfferReply(lead, missing) {
  const first = leadFirstName(lead);
  const role = lead.job_title ? `${lead.job_title} role` : 'role you are looking to fill';
  const where = [lead.end_client ? `supporting ${lead.end_client}` : '', lead.job_location ? `in ${lead.job_location}` : (lead.work_arrangement ? `(${lead.work_arrangement})` : '')].filter(Boolean).join(' ');
  const wants = [
    lead.employment_type ? `available for a ${String(lead.employment_type).toLowerCase()} engagement` : 'available now',
    lead.work_arrangement && !/remote/i.test(lead.work_arrangement) ? `able to work ${String(lead.work_arrangement).toLowerCase()}${lead.job_location ? ` in ${lead.job_location}` : ''}` : (lead.work_arrangement ? 'comfortable working remotely' : ''),
    'authorized to work in the US without sponsorship',
  ].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ', and $1');
  const confirm = "If you can reply confirming you'd like our help, we'll begin sourcing right away.";
  const ask = missing.length
    ? `\n\nTo target our search accurately, could you confirm ${missing.length === 1 ? 'one detail' : `${COUNT_WORD[missing.length - 1] || missing.length} details`}:\n\n${missing.map((m, i) => `${i + 1}. ${ASK_LABEL[m.key] || m.label}`).join('\n')}\n\n${confirm}`
    : `\n\n${confirm}`;
  const body = `Hi ${first},\n\nThank you for reaching out and for considering my credentials for the ${role}${where ? ` ${where}` : ''}.\n\nI'm not personally available for this engagement at this time, but I would be glad to leverage my placement company, Peek Talent Solutions, to help you find a qualified resource to fill it. We can work our network of ${NETWORK_SIZE} qualified professionals to identify people with the experience your client is looking for, who are ${wants}.\n\nOnce we identify a match, we'll send over a candidate profile for your consideration. If you or your client would like to interview the candidate, coordinate with us and we'll arrange the video interview.${ask}\n\nThanks again, ${first}, and I look forward to working with you.`;
  return { subject: replySubject(lead), body };
}

/**
 * Draft the offer reply with the model, personalized to the recruiter's email.
 */
async function draftOfferReply(lead, options = {}) {
  const missing = missingInfo(lead);
  if (!isAIConfigured() && !options.client) return { ...templateOfferReply(lead, missing), missing, model: 'template' };
  const client = options.client || getClient();
  const system = [
    'You write warm, specific, professional replies on behalf of Brad Peek, Managing Member of Peek Talent Solutions, a staffing firm. A recruiter or headhunter has emailed Brad about a role. Write the reply as Brad, first person, plain text, no markdown, no subject line inside the body, and no signature (it is appended automatically).',
    'Follow this structure exactly. Paragraph 1: "Hi <first name>," then thank them for reaching out and for considering my credentials for the <role title> <supporting <program or client> in <location>> (use whatever of these their email states). Paragraph 2: "I am not personally available for this engagement at this time, but I would be glad to leverage my placement company, Peek Talent Solutions, to help you find a qualified resource to fill it." Then one sentence: "We can work our network of ' + NETWORK_SIZE + ' qualified professionals to identify <a specific profile pulled from their job description: seniority, years of experience, the two or three most important skills or tools> who are <available for the stated term or employment type>, <able to meet the stated on-site, hybrid or remote arrangement>, and <can convert or work without sponsorship>." Paragraph 3: "Once we identify a match, we will send over a candidate profile for your consideration. If you or your client would like to interview the candidate, coordinate with us and we will arrange the video interview." Paragraph 4, only if details are missing: "To target our search accurately, could you confirm <N> details:" followed by a numbered list, one line each, of exactly the missing details supplied in the context. Then: "If you can reply confirming you would like our help, we will begin sourcing right away." Final line: "Thanks again, <first name>, and I look forward to working with you." Contractions (I\'m, we\'ll, you\'d) are welcome.',
    'Use only facts from their email; never invent requirements, terms or client names. Do not ask for details that are already known. Keep it under 260 words. The subject must be exactly "RE: " followed by their original subject line without any existing Re or Fw prefixes.',
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
  const subject = replySubject(lead, response.parsed_output.subject);
  return { subject, body: response.parsed_output.body.trim(), missing, model: response.model || MODEL };
}

const ReplyAnalysisSchema = z.object({
  interest: z.enum(['interested', 'not_interested', 'unclear']).describe('Whether the recruiter wants Peek Talent Solutions to help fill the role.'),
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

// Follow-up nudges between the offer reply and the close-out: a short, friendly
// push for a yes or a no. LEAD_NUDGE_DAYS lists the business days after the
// reply on which to send them (default 1 and 2; the close-out is day 3).
const NUDGE_DAYS = String(process.env.LEAD_NUDGE_DAYS === undefined ? '1,2' : process.env.LEAD_NUDGE_DAYS).split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
function nudgeEmail(lead, n, missing = []) {
  const first = leadFirstName(lead);
  const role = lead.job_title ? `your ${lead.job_title} search` : 'your search';
  const need = missing.length ? missing.map((m) => (ASK_LABEL[m.key] || m.label).toLowerCase().replace(/^the /, '')).join(', ').replace(/, ([^,]*)$/, ' and $1') : '';
  const body = n === 1
    ? `Hi ${first},\n\nHope your week is going well. I know recruiter inboxes fill up fast, so I just wanted to float my note back to the top.\n\nIf ${role} is still open, I'd be glad to start lining up a few strong people for you. All I need is a quick "yes" to get moving${need ? `, plus the ${need} so I can aim the search properly` : ''}.\n\nDid I mention that, as long as the rate is market-competitive, our resources and services come at no additional rate increase over and above what's being offered? You get the candidate and the placement support at the rate you already have in hand.\n\nAnd if it's already filled or the timing isn't right, no worries at all, a quick "no" is just as helpful.\n\nThanks, ${first}.`
    : `Hi ${first},\n\nOne last friendly check-in from me, and then I'll get out of your inbox.\n\nIf you'd still like a hand with ${role}, reply with a "yes" and I'll start sending you candidates this week${need ? ` (the ${need} would help me aim the search)` : ''}. If it has closed out on your side, just let me know and I'll wish you luck with it.\n\nEither way, I appreciate you thinking of me, and I hope our paths cross on the next one.\n\nThanks again, ${first}.`;
  return { subject: replySubject(lead), body };
}
function closeOutEmail(lead) {
  const first = leadFirstName(lead);
  return {
    subject: replySubject(lead),
    body: `Hi ${first},\n\nThank you for your time and consideration. If we can ever help you find a resource for a role you are trying to fill, please do not hesitate to call on us. We would be glad to put our network to work for you.\n\nWishing you continued success.`,
  };
}

function followUpRequestEmail(lead, missing) {
  const first = leadFirstName(lead);
  const list = missing.map((m) => `- ${m.label}`).join('\n');
  return {
    subject: replySubject(lead),
    body: `Hi ${first},\n\nThank you for confirming. To target our search accurately, could you confirm ${missing.length === 1 ? 'one detail' : 'a few details'}:\n\n${missing.map((m, i) => `${i + 1}. ${ASK_LABEL[m.key] || m.label}`).join('\n')}\n\nOnce we have these, we'll begin sourcing right away and send over candidate profiles as soon as we have a strong match.\n\nThanks again, ${first}.`,
  };
}

async function logEmail(pool, lead, { direction, kind, subject, body, message_id = null, from_email = null, to_email = null, analysis = null }) {
  const ins = await pool.query(
    `INSERT INTO lead_emails (lead_id, direction, kind, subject, body, message_id, from_email, to_email, analysis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [String(lead.id), direction, kind, subject, body, message_id, from_email, to_email, analysis ? JSON.stringify(analysis) : null]);
  return ins.rows[0];
}

async function setLead(pool, id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return null;
  const q = await pool.query(`UPDATE leads SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((c) => fields[c]), String(id)]);
  return q.rows[0];
}

/** Send an email to the lead, log it, and update workflow fields. */
async function sendLeadEmail(pool, lead, { kind, subject, body, status, extra = {} }, options = {}) {
  if (!lead.email) throw Object.assign(new Error('Lead has no email address'), { status: 400 });
  const fullBody = `${body.trim()}\n\n${SIGNATURE}`;
  // The email always reads as a direct reply: "RE: <their subject>", threaded on their message id where the transport allows it.
  const finalSubject = lead.email_subject ? replySubject(lead, subject) : (/^\s*re:/i.test(subject) ? subject : `RE: ${subject}`);
  const result = await sendEmail({ to: lead.email, bcc: LEAD_BCC || undefined, subject: finalSubject, text: fullBody, html: textToHtml(fullBody), inReplyTo: lead.message_id || undefined, references: lead.message_id || undefined }, options.sendOptions);
  await logEmail(pool, lead, { direction: 'outbound', kind, subject: finalSubject, body: fullBody, to_email: lead.email, from_email: FROM_EMAIL });
  const now = new Date();
  const fields = { workflow_status: status, ...extra };
  // Any outbound communication means the lead has been worked: "new" is only
  // for leads that just dropped in from a scan or have not been touched yet.
  if (!fields.status && ['new', '', null, undefined].includes(lead.status)) fields.status = 'contacted';
  // A close-out ends the conversation: no reply -> closed, they said no -> unqualified.
  if (kind === 'close_out' && !extra.status && ['new', 'contacted', '', null, undefined].includes(lead.status)) fields.status = status === 'closed_no_response' ? 'closed' : 'unqualified';
  if (kind === 'offer_reply') { fields.replied_at = now; fields.follow_up_due_at = addBusinessDays(now, FOLLOW_UP_BUSINESS_DAYS); }
  if (kind === 'info_request') { fields.follow_up_due_at = addBusinessDays(now, FOLLOW_UP_BUSINESS_DAYS); }
  if (kind === 'close_out') { fields.follow_up_due_at = null; }
  const updated = await setLead(pool, lead.id, fields);
  return { ...result, lead: updated };
}

/** Find the account for a client name, creating it if needed. Returns the row or null. */
async function findOrCreateAccount(pool, name, extra = {}) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = await pool.query('SELECT * FROM accounts WHERE LOWER(name)=LOWER($1) ORDER BY id LIMIT 1', [clean]);
  if (found.rows.length) return found.rows[0];
  const ins = await pool.query('INSERT INTO accounts (name, website) VALUES ($1, $2) RETURNING *', [clean, extra.website || null]);
  const row = ins.rows[0];
  try {
    const num = await pool.query('UPDATE accounts SET account_no=(SELECT COALESCE(MAX(account_no),0)+1 FROM accounts) WHERE id::text=$1 AND account_no IS NULL RETURNING *', [String(row.id)]);
    return num.rows[0] || row;
  } catch { return row; }
}

async function createOpportunityFromLead(pool, lead, analysis = {}) {
  const clientName = lead.end_client || lead.company;
  const title = lead.job_title || 'Staffing request';
  // Tie the chain together: the client becomes (or already is) an Account,
  // the Opportunity points at that Account and at the Lead, and the Lead
  // points back at both.
  const account = await findOrCreateAccount(pool, clientName, { website: lead.end_client ? null : lead.company_website });
  if (account && !lead.account_id) await setLead(pool, lead.id, { account_id: String(account.id) });
  const rateNum = parseFloat(String(lead.rate_or_salary || '').replace(/[^0-9.]/g, '')) || null;
  const notes = [
    analysis.summary,
    `Recruiter: ${lead.name}${lead.title ? `, ${lead.title}` : ''} at ${lead.company}${lead.phone ? ` (${lead.phone})` : ''}`,
    lead.company_address ? `Address: ${lead.company_address}` : '',
    `Rate: ${lead.rate_or_salary || 'n/a'} | Type: ${lead.employment_type || 'n/a'} | Work: ${[lead.work_arrangement, lead.job_location].filter(Boolean).join(' - ') || 'n/a'}`,
    'Created automatically from recruiter email workflow.',
  ].filter(Boolean).join('\n');
  const ins = await pool.query(
    `INSERT INTO opportunities (name, account, account_id, contact, contact_email, value, stage, probability, type, notes, job_title, job_description, client_name, rate, work_location, work_arrangement, lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [`${clientName} - ${title}`, clientName, account ? String(account.id) : null, lead.name, lead.email, rateNum, 'Qualification', 40, 'New Business', notes,
      lead.job_title || null, lead.job_description || null, clientName, lead.rate_or_salary || null, lead.job_location || null, lead.work_arrangement || null, String(lead.id)]);
  const row = ins.rows[0];
  try {
    const num = await pool.query('UPDATE opportunities SET opportunity_no=(SELECT COALESCE(MAX(opportunity_no),0)+1 FROM opportunities) WHERE id::text=$1 AND opportunity_no IS NULL RETURNING *', [String(row.id)]);
    return num.rows[0] || row;
  } catch { return row; }
}

/**
 * Handle a reply from a recruiter we have written to.
 * Returns { action, lead, opportunity? }.
 */
async function handleInboundReply(pool, lead, msg, options = {}) {
  if (module.exports.onInbound) { try { await module.exports.onInbound(lead, msg); } catch (e) { console.error('⚠️ inbound hook:', e.message); } }
  if (lead.workflow_status === 'personal_interest') {
    // Brad applied for this role himself: log the reply, tell him, and never auto-answer.
    await logEmail(pool, lead, { direction: 'inbound', kind: 'reply', subject: msg.subject, body: String(msg.text || '').slice(0, 20000), message_id: msg.message_id, from_email: msg.from_email });
    const current = await setLead(pool, lead.id, { last_inbound_at: new Date() });
    if (module.exports.onPersonalInbound) { try { await module.exports.onPersonalInbound(current, msg); } catch (e) { console.error('⚠️ personal inbound hook:', e.message); } }
    return { action: 'personal_reply_received', lead: current };
  }
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

  // The recruiter's answer drives the visible lead status: interested ->
  // qualified, not interested -> unqualified, unclear -> stays contacted.
  if (analysis.interest === 'not_interested') {
    const mail = closeOutEmail(current);
    const r = await sendLeadEmail(pool, current, { kind: 'close_out', ...mail, status: 'declined', extra: { status: 'unqualified' } }, options);
    return { action: 'declined_close_out_sent', lead: r.lead, analysis };
  }
  if (analysis.interest === 'interested') {
    const missing = missingInfo(current);
    if (missing.length) {
      const mail = followUpRequestEmail(current, missing);
      const r = await sendLeadEmail(pool, current, { kind: 'info_request', ...mail, status: 'awaiting_info', extra: { missing_info: JSON.stringify(missing.map((m) => m.key)), status: 'qualified' } }, options);
      return { action: 'info_requested', lead: r.lead, missing, analysis };
    }
    if (process.env.LEAD_AUTO_CONVERT === 'true') {
      // Legacy behaviour: convert without a human checkpoint.
      const opp = await createOpportunityFromLead(pool, current, analysis);
      current = await setLead(pool, current.id, { workflow_status: 'opportunity_created', status: 'converted', opportunity_id: String(opp.id), follow_up_due_at: null, missing_info: '[]' });
      if (module.exports.onLeadUpdated) { try { await module.exports.onLeadUpdated(current); } catch { /* mirror is best-effort */ } }
      return { action: 'opportunity_created', lead: current, opportunity: opp, analysis };
    }
    // Authorize Search checkpoint: the recruiter is interested and every
    // critical detail is on file, so a person now decides whether to open the
    // search. Nothing is created until POST /api/leads/:id/authorize-search.
    current = await setLead(pool, current.id, { workflow_status: 'ready_to_authorize', status: 'qualified', follow_up_due_at: null, missing_info: '[]' });
    if (module.exports.onReadyToAuthorize) { try { await module.exports.onReadyToAuthorize(current, analysis); } catch (e) { console.error('⚠️ ready-to-authorize hook failed:', e.message); } }
    if (module.exports.onLeadUpdated) { try { await module.exports.onLeadUpdated(current); } catch { /* mirror is best-effort */ } }
    return { action: 'ready_to_authorize', lead: current, analysis };
  }
  // Unclear: keep waiting, but give them another window; the lead stays contacted.
  current = await setLead(pool, current.id, { follow_up_due_at: addBusinessDays(new Date(), FOLLOW_UP_BUSINESS_DAYS), ...(['new', '', null, undefined].includes(current.status) ? { status: 'contacted' } : {}) });
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
  logEmail, setLead, isAIConfigured, FOLLOW_UP_BUSINESS_DAYS, _setClientForTests, findOrCreateAccount, SIGNATURE, LEAD_BCC, replySubject, nudgeEmail, NUDGE_DAYS,
};
