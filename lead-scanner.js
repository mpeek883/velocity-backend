// Recruiter lead scanner.
// Reads recent messages from configured mailboxes, filters out job-board
// blasts and automated mail, asks Claude whether each remaining message is a
// real recruiter/headhunter trying to fill a role, and extracts the recruiter,
// their company (with address), contact details, and the job description into
// a lead record. Every scanned message is logged by its message id so nothing
// is processed twice.
//
// Mailbox configuration (environment variables on the API service):
//   Microsoft 365 via Graph (existing MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET
//   app registration; needs the Mail.Read application permission):
//     GRAPH_SCAN_MAILBOXES=brad.peek@peekitservices.com[,other@peekitservices.com]
//   IMAP (Gmail and Verizon/AOL need an app password, not the account password):
//     GMAIL_USER=milton.b.peek@gmail.com        GMAIL_APP_PASSWORD=xxxx
//     VERIZON_USER=bradpeek@verizon.net         VERIZON_APP_PASSWORD=xxxx
//   or any list:  IMAP_MAILBOXES=[{"address":"...","host":"imap.example.com","port":993,"user":"...","pass":"..."}]
//   Schedule:     LEAD_SCAN_INTERVAL_MIN=60 (0 disables), LEAD_SCAN_DAYS=14, LEAD_SCAN_MAX=50

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { graphConfigured, getGraphAccessToken } = require('./email');

const MODEL = process.env.LEAD_AI_MODEL || 'claude-opus-5';

// ---------------------------------------------------------------------------
// Mailbox configuration
// ---------------------------------------------------------------------------
function listMailboxes() {
  const boxes = [];
  if (graphConfigured()) {
    const addrs = (process.env.GRAPH_SCAN_MAILBOXES || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const address of addrs) boxes.push({ address, provider: 'graph' });
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    boxes.push({ address: process.env.GMAIL_USER, provider: 'imap', host: 'imap.gmail.com', port: 993, user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD });
  }
  if (process.env.VERIZON_USER && process.env.VERIZON_APP_PASSWORD) {
    // Verizon.net mailboxes are hosted by AOL Mail.
    boxes.push({ address: process.env.VERIZON_USER, provider: 'imap', host: process.env.VERIZON_IMAP_HOST || 'imap.aol.com', port: 993, user: process.env.VERIZON_USER, pass: process.env.VERIZON_APP_PASSWORD });
  }
  if (process.env.IMAP_MAILBOXES) {
    try {
      for (const m of JSON.parse(process.env.IMAP_MAILBOXES)) {
        if (m && m.address && m.host && m.user && m.pass) boxes.push({ address: m.address, provider: 'imap', host: m.host, port: Number(m.port) || 993, user: m.user, pass: m.pass });
      }
    } catch (err) {
      console.error('⚠️ IMAP_MAILBOXES is not valid JSON:', err.message);
    }
  }
  return boxes;
}

function publicMailboxes() {
  return listMailboxes().map((b) => ({ address: b.address, provider: b.provider, host: b.host || null }));
}

// ---------------------------------------------------------------------------
// Connectors: each returns [{ message_id, subject, from_name, from_email, received_at, text }]
// ---------------------------------------------------------------------------
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function fetchGraphMessages(address, { since, max = 50 } = {}, fetchImpl = global.fetch) {
  const token = await getGraphAccessToken(fetchImpl);
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address)}/mailFolders/inbox/messages`);
  url.searchParams.set('$top', String(Math.min(max, 100)));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$select', 'id,internetMessageId,subject,from,receivedDateTime,body,bodyPreview');
  if (since) url.searchParams.set('$filter', `receivedDateTime ge ${new Date(since).toISOString()}`);
  const resp = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Graph mail read failed (${resp.status}): ${(data.error && data.error.message) || resp.statusText}`);
  return (data.value || []).map((m) => ({
    message_id: m.internetMessageId || m.id,
    subject: m.subject || '',
    from_name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
    from_email: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
    received_at: m.receivedDateTime || null,
    text: (m.body && (m.body.contentType === 'html' ? htmlToText(m.body.content) : m.body.content)) || m.bodyPreview || '',
  }));
}

async function fetchImapMessages(box, { since, max = 50 } = {}) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: box.host, port: box.port || 993, secure: true, auth: { user: box.user, pass: box.pass }, logger: false });
  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const criteria = since ? { since: new Date(since) } : { all: true };
      const uids = await client.search(criteria, { uid: true });
      const chosen = uids.slice(-max).reverse();
      for (const uid of chosen) {
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
        out.push({
          message_id: parsed.messageId || `${box.address}:${uid}`,
          subject: parsed.subject || '',
          from_name: from.name || '',
          from_email: from.address || '',
          received_at: parsed.date ? parsed.date.toISOString() : null,
          text: parsed.text || htmlToText(parsed.html || ''),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cheap pre-filter so obvious non-recruiter mail never reaches the model.
// ---------------------------------------------------------------------------
const AUTOMATED_SENDER_RE = /(no-?reply|donotreply|do-not-reply|notifications?|newsletter|alerts?|mailer|bounce|digest|jobs?-?alert|jobalerts|updates)@|@(indeed|linkedin|dice|ziprecruiter|monster|glassdoor|careerbuilder|lensa|talent|jobcase|simplyhired|hired)\./i;
const RECRUITER_HINT_RE = /\b(opportunit|role|position|job|recruit|hiring|contract|resume|c2c|w2|1099|opening|requirement|req\b|client|interview|rate|per hour|\/hr|remote|onsite|hybrid|headhunt|staffing|talent)/i;

function prefilter(msg) {
  const from = String(msg.from_email || '').toLowerCase();
  if (!from) return { skip: true, reason: 'no sender' };
  if (AUTOMATED_SENDER_RE.test(from)) return { skip: true, reason: 'automated or job-board sender' };
  const hay = `${msg.subject}\n${msg.text}`.slice(0, 6000);
  if (!RECRUITER_HINT_RE.test(hay)) return { skip: true, reason: 'no recruiting language' };
  if (/\bunsubscribe\b/i.test(hay) && !/\b(your (resume|profile|background)|reach(ing)? out|came across)/i.test(hay)) return { skip: true, reason: 'bulk mailing' };
  return { skip: false };
}

// ---------------------------------------------------------------------------
// AI classification + extraction
// ---------------------------------------------------------------------------
const LeadSchema = z.object({
  is_recruiter_outreach: z.boolean().describe('True only if a real person (recruiter, headhunter, staffing/talent partner, or hiring manager) is personally reaching out to fill a specific role. False for job-board alerts, newsletters, mass marketing, candidate applications, vendor sales pitches, or anything automated.'),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('One sentence explaining the decision.'),
  recruiter: z.object({
    name: z.string(),
    title: z.string(),
    company: z.string().describe('The recruiter\'s own firm/agency.'),
    company_address: z.string().describe('Street/city/state/postal address of the firm if present in the signature; empty if not.'),
    company_website: z.string(),
    phone: z.string(),
    email: z.string(),
    linkedin: z.string(),
  }),
  job: z.object({
    title: z.string(),
    end_client: z.string().describe('The company the role is actually with, if different from the recruiter\'s firm.'),
    location: z.string(),
    work_arrangement: z.string().describe('Remote, On-site, Hybrid, or empty if not stated.'),
    employment_type: z.string().describe('e.g. Contract, C2C, W2, Full-time, Contract-to-hire'),
    rate_or_salary: z.string(),
    description: z.string().describe('The job description as written in the email, lightly cleaned. Empty if none.'),
  }),
  summary: z.string().describe('Two sentences: who is reaching out and what they need.'),
});

let defaultClient = null;
function getClient() {
  if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 });
  return defaultClient;
}
function _setClientForTests(client) { defaultClient = client; }
function isLeadAIConfigured() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

async function classifyMessage(msg, options = {}) {
  const client = options.client || getClient();
  const body = String(msg.text || '').slice(0, 12000);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: 'You screen a recruiter\'s inbox for a staffing business. Decide whether an email is genuine, personal outreach from a recruiter/headhunter/hiring manager trying to fill a role, and extract the details exactly as written. Never invent details; leave fields empty when absent.',
    output_config: { effort: 'low', format: zodOutputFormat(LeadSchema) },
    messages: [{ role: 'user', content: `From: ${msg.from_name} <${msg.from_email}>\nSubject: ${msg.subject}\nReceived: ${msg.received_at || 'unknown'}\n\n<email>\n${body}\n</email>` }],
  });
  if (response.stop_reason === 'refusal') return { is_recruiter_outreach: false, confidence: 0, reason: 'model declined', recruiter: {}, job: {}, summary: '' };
  return response.parsed_output || { is_recruiter_outreach: false, confidence: 0, reason: 'no output', recruiter: {}, job: {}, summary: '' };
}

// ---------------------------------------------------------------------------
// Lead assembly
// ---------------------------------------------------------------------------
function leadFromExtraction(msg, box, ex) {
  const r = ex.recruiter || {};
  const j = ex.job || {};
  const notesParts = [
    ex.summary,
    j.end_client ? `End client: ${j.end_client}` : '',
    j.employment_type ? `Type: ${j.employment_type}` : '',
    j.rate_or_salary ? `Rate/Salary: ${j.rate_or_salary}` : '',
    `Source email: "${msg.subject}" from ${msg.from_email} on ${msg.received_at || 'unknown date'} (${box.address})`,
  ].filter(Boolean);
  return {
    name: r.name || msg.from_name || msg.from_email,
    title: r.title || '',
    company: r.company || (msg.from_email.split('@')[1] || ''),
    company_address: r.company_address || '',
    company_website: r.company_website || '',
    email: (r.email || msg.from_email || '').toLowerCase(),
    phone: r.phone || '',
    linkedin: r.linkedin || '',
    source: 'Recruiter Email',
    status: 'new',
    score: Math.round((Number(ex.confidence) || 0) * 100),
    job_title: j.title || '',
    job_location: j.location || '',
    job_description: j.description || '',
    rate_or_salary: j.rate_or_salary || '',
    end_client: j.end_client || '',
    employment_type: j.employment_type || '',
    work_arrangement: j.work_arrangement || (/\bremote\b/i.test(`${j.location} ${msg.subject}`) ? 'Remote' : /\bhybrid\b/i.test(`${j.location} ${msg.subject}`) ? 'Hybrid' : /\bon-?site\b/i.test(`${j.location} ${msg.subject}`) ? 'On-site' : ''),
    workflow_status: 'new',
    origin: 'system',
    notes: notesParts.join('\n'),
    mailbox: box.address,
    message_id: msg.message_id,
    email_subject: msg.subject,
    email_received_at: msg.received_at || null,
  };
}

/**
 * Scan mailboxes and create/update leads.
 * @param {object} deps { pool, mailboxes?, fetchGraph?, fetchImap?, classify?, since?, max? }
 */
async function scanMailboxes(deps) {
  const { pool } = deps;
  const days = Number(deps.days || process.env.LEAD_SCAN_DAYS || 14);
  const max = Number(deps.max || process.env.LEAD_SCAN_MAX || 50);
  const since = deps.since || new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const boxes = deps.mailboxes || listMailboxes();
  // Resolve through module.exports so tests can swap the connectors.
  const fetchGraph = deps.fetchGraph || ((box, opts) => module.exports.fetchGraphMessages(box.address, opts));
  const fetchImap = deps.fetchImap || ((box, opts) => module.exports.fetchImapMessages(box, opts));
  const classify = deps.classify || ((msg) => module.exports.classifyMessage(msg));

  const summary = { started_at: new Date().toISOString(), since, mailboxes: [], leads_created: 0, leads_updated: 0, messages_scanned: 0 };
  for (const box of boxes) {
    const r = { address: box.address, provider: box.provider, fetched: 0, already_scanned: 0, filtered_out: 0, ai_checked: 0, not_recruiter: 0, leads_created: 0, leads_updated: 0, errors: [] };
    summary.mailboxes.push(r);
    let messages = [];
    try {
      messages = box.provider === 'graph' ? await fetchGraph(box, { since, max }) : await fetchImap(box, { since, max });
    } catch (err) {
      r.errors.push(`mailbox read failed: ${err.message}`);
      continue;
    }
    r.fetched = messages.length;
    for (const msg of messages) {
      try {
        if (!msg.message_id) continue;
        const seen = await pool.query('SELECT id FROM email_scan_log WHERE message_id=$1', [msg.message_id]);
        if (seen.rows.length) { r.already_scanned += 1; continue; }
        summary.messages_scanned += 1;

        // A message from a recruiter we have already written to is a reply
        // in the offer workflow, not a new lead.
        const fromEmail = String(msg.from_email || '').toLowerCase();
        if (fromEmail) {
          const open = await pool.query("SELECT * FROM leads WHERE LOWER(email)=$1 AND workflow_status IN ('replied','awaiting_info') ORDER BY id LIMIT 1", [fromEmail]);
          if (open.rows.length) {
            const outcome = await (deps.handleInbound || module.exports.handleInboundReply)(pool, open.rows[0], msg);
            r.replies_handled = (r.replies_handled || 0) + 1;
            summary.replies_handled = (summary.replies_handled || 0) + 1;
            await pool.query(
              'INSERT INTO email_scan_log (mailbox, message_id, subject, from_email, received_at, classification, reason, lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
              [box.address, msg.message_id, msg.subject, msg.from_email, msg.received_at || null, 'lead_reply', outcome.action, open.rows[0].id]);
            continue;
          }
        }

        const pf = prefilter(msg);
        let classification = 'not_recruiter';
        let leadId = null;
        let reason = pf.reason || '';
        if (pf.skip) {
          r.filtered_out += 1;
        } else {
          r.ai_checked += 1;
          const ex = await classify(msg);
          reason = ex.reason || '';
          if (ex.is_recruiter_outreach && (Number(ex.confidence) || 0) >= 0.5) {
            classification = 'recruiter_lead';
            const lead = leadFromExtraction(msg, box, ex);
            const existing = lead.email ? await pool.query('SELECT * FROM leads WHERE LOWER(email)=$1 ORDER BY id LIMIT 1', [lead.email]) : { rows: [] };
            if (existing.rows.length) {
              // Same recruiter again: keep known contact details unless the new
              // email supplies them, replace the job fields with the latest role,
              // and append to the notes.
              const cur = existing.rows[0];
              const keep = (fresh, old) => (fresh && String(fresh).trim() ? fresh : (old || null));
              const merged = {
                name: keep(lead.name, cur.name), title: keep(lead.title, cur.title), company: keep(lead.company, cur.company),
                company_address: keep(lead.company_address, cur.company_address), company_website: keep(lead.company_website, cur.company_website),
                phone: keep(lead.phone, cur.phone), linkedin: keep(lead.linkedin, cur.linkedin),
                job_title: lead.job_title, job_location: lead.job_location, job_description: lead.job_description, rate_or_salary: lead.rate_or_salary,
                notes: [cur.notes, '---', lead.notes].filter(Boolean).join('\n'),
                score: Math.max(Number(cur.score) || 0, lead.score),
                mailbox: lead.mailbox, message_id: lead.message_id, email_subject: lead.email_subject, email_received_at: lead.email_received_at,
              };
              const cols = Object.keys(merged);
              await pool.query(
                `UPDATE leads SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1}`,
                [...cols.map((c) => merged[c]), cur.id]);
              leadId = cur.id; r.leads_updated += 1; summary.leads_updated += 1;
            } else {
              const cols = Object.keys(lead);
              const ins = await pool.query(`INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map((c) => lead[c]));
              leadId = ins.rows[0].id; r.leads_created += 1; summary.leads_created += 1;
            }
          } else {
            r.not_recruiter += 1;
          }
        }
        await pool.query(
          'INSERT INTO email_scan_log (mailbox, message_id, subject, from_email, received_at, classification, reason, lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [box.address, msg.message_id, msg.subject, msg.from_email, msg.received_at || null, classification, reason, leadId]);
      } catch (err) {
        r.errors.push(`${msg.subject || msg.message_id}: ${err.message}`);
      }
    }
  }
  summary.finished_at = new Date().toISOString();
  return summary;
}

module.exports = {
  listMailboxes, publicMailboxes, fetchGraphMessages, fetchImapMessages, prefilter, classifyMessage, leadFromExtraction, scanMailboxes, htmlToText, isLeadAIConfigured, MODEL, _setClientForTests,
  // Reply handling lives in lead-workflow.js; resolved lazily so tests can swap it.
  handleInboundReply: (pool, lead, msg) => require('./lead-workflow').handleInboundReply(pool, lead, msg),
};
