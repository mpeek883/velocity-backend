// Candidate outreach from AI matches: draft a personalised email to the top
// matches for a job order, send on a click, and let the candidate answer with
// one click. "Interested" creates the submission and sends the Right to
// Represent; nothing is emailed without a person choosing to send.
const Anthropic = require('@anthropic-ai/sdk');

const COMPANY = process.env.ESIGN_COMPANY_NAME || 'Peek Talent Solutions';
const MODEL = process.env.OUTREACH_AI_MODEL || 'claude-opus-5';
const APP_URL = (process.env.APP_URL || 'https://velocity-i5hx.onrender.com').replace(/\/$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nl2br = (s) => esc(s).replace(/\n/g, '<br/>');
let client = null;
function getClient() { if (!client) client = new Anthropic({ timeout: 60000, maxRetries: 2 }); return client; }
function _setClientForTests(c) { client = c; }
const isAIConfigured = () => !!process.env.ANTHROPIC_API_KEY;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS candidate_outreach (id SERIAL PRIMARY KEY, job_order_id TEXT, candidate_id TEXT, token VARCHAR(80), status VARCHAR(20) DEFAULT 'draft', subject VARCHAR(255), body TEXT, rank INTEGER, score INTEGER, model VARCHAR(80), sent_at TIMESTAMP, responded_at TIMESTAMP, response VARCHAR(20), response_note TEXT, availability TEXT, submission_id TEXT, rtr_request_id TEXT, created_by TEXT, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
];

function templateDraft({ candidate, job, match }) {
  const first = String(candidate.name || '').split(' ')[0] || 'there';
  const skills = (match && match.breakdown && match.breakdown.matched_skills) ? match.breakdown.matched_skills.slice(0, 3).join(', ') : (job.required_skills || '').split(',').slice(0, 3).map((s) => s.trim()).filter(Boolean).join(', ');
  const subject = `${job.title}${job.location ? ` - ${job.location}` : ''}: a role that fits your background`;
  const body = `Hi ${first},\n\nI am reaching out from ${COMPANY} about a ${job.title} opening${job.location ? ` (${job.location})` : ''}${job.salary_range ? ` paying ${job.salary_range}` : ''}. Your experience${skills ? ` with ${skills}` : ''} lines up well with what the client is looking for.\n\n${(job.description || '').slice(0, 400).trim()}${(job.description || '').length > 400 ? '...' : ''}\n\nIf you would like to hear more, click "I'm interested" below and I will call you to walk through the details and confirm the rate before anything is sent to the client. If the timing is wrong, "Not now" tells me to keep you in mind for the next one.\n\nBest regards,\n${COMPANY}`;
  return { subject, body, model: 'template' };
}

async function aiDraft({ candidate, job, match }) {
  const prompt = `You write short recruiter outreach emails for ${COMPANY}, a US staffing firm. Write to the candidate below about the job order. Plain text, 120-170 words, warm and specific: mention one or two concrete things from their background that fit, the title, location/arrangement and pay if known. Do NOT name the end client. Do not include a subject line in the body, greeting "Hi <first name>," and sign off as "${COMPANY}". End with one sentence telling them to use the "I'm interested" button below or "Not now". Return JSON {"subject": string, "body": string} only.

CANDIDATE: ${JSON.stringify({ name: candidate.name, title: candidate.title, skills: candidate.skills, location: candidate.location, experience_years: candidate.experience_years, summary: String(candidate.resume_text || candidate.notes || '').slice(0, 1200) })}
JOB ORDER: ${JSON.stringify({ title: job.title, location: job.location, rate: job.salary_range, skills: job.required_skills, description: String(job.description || '').slice(0, 1500) })}
MATCH NOTES: ${JSON.stringify(match && match.ai ? { strengths: match.ai.strengths, rationale: match.ai.rationale } : match && match.breakdown ? match.breakdown : {})}`;
  const res = await getClient().messages.create({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.map((c) => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text);
  if (!parsed.subject || !parsed.body) throw new Error('AI draft missing subject or body');
  return { subject: String(parsed.subject).slice(0, 255), body: String(parsed.body), model: MODEL };
}

function install(deps) {
  const { app, pool, events, authenticateToken, notifyOwners, runMatch, createSignatureRequest, sendSignatureRequest, normalizeSubmissionStatus, throttle } = deps;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const rows = async (sql, p) => (await pool.query(sql, p)).rows;
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); } };
  const token = () => require('crypto').randomBytes(24).toString('base64url');

  async function draftForJob(job, { limit = 5, useAI = true, usOnly = true, createdBy = null } = {}) {
    const m = await runMatch('job_order', job.id, { limit: Math.max(limit * 2, 10), ai_top: useAI ? limit : 0, use_ai: useAI, us_only: usOnly });
    if (!m) throw Object.assign(new Error('Job order not found'), { status: 404 });
    const drafts = [];
    for (const match of m.matches) {
      if (drafts.length >= limit) break;
      const cand = await one('SELECT * FROM candidates WHERE id::text=$1', [String(match.candidate_id)]);
      if (!cand || !cand.email) continue;
      const already = await one("SELECT id, status FROM candidate_outreach WHERE job_order_id=$1 AND candidate_id=$2 AND status<>'draft' ORDER BY id DESC LIMIT 1", [String(job.id), String(cand.id)]);
      if (already) continue; // already contacted for this job
      const existingSub = await one('SELECT id FROM submissions WHERE job_order_id::text=$1 AND candidate_id::text=$2', [String(job.id), String(cand.id)]);
      if (existingSub) continue;
      let d;
      try { d = useAI && isAIConfigured() ? await aiDraft({ candidate: cand, job, match }) : templateDraft({ candidate: cand, job, match }); } catch (e) { d = { ...templateDraft({ candidate: cand, job, match }), model: `template (AI failed: ${e.message.slice(0, 80)})` }; }
      await pool.query("DELETE FROM candidate_outreach WHERE job_order_id=$1 AND candidate_id=$2 AND status='draft'", [String(job.id), String(cand.id)]);
      const row = await one('INSERT INTO candidate_outreach (job_order_id, candidate_id, status, subject, body, rank, score, model, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [String(job.id), String(cand.id), 'draft', d.subject, d.body, match.rank, match.score, d.model, createdBy == null ? null : String(createdBy)]);
      drafts.push({ ...row, candidate_name: cand.name, candidate_email: cand.email, candidate_title: cand.title });
    }
    await events.record({ type: 'outreach.drafted', entity_type: 'job_order', entity_id: job.id, actor: createdBy ? `user:${createdBy}` : 'system', payload: { drafts: drafts.length, ai: useAI && isAIConfigured() } });
    return { job_order: { id: job.id, title: job.title }, drafts, excluded: m.excluded, ai_used: drafts.some((d) => d.model !== 'template') };
  }

  function outreachEmail(row, cand, job) {
    const url = `${APP_URL}/?candidate=${encodeURIComponent(row.token)}`;
    const html = `<p>${nl2br(row.body)}</p><p style="margin:18px 0"><a href="${esc(url)}&r=interested" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">I'm interested</a>&nbsp;&nbsp;<a href="${esc(url)}&r=not_interested" style="color:#475569;text-decoration:underline">Not now</a></p><p style="font-size:12px;color:#94a3b8">This link is personal to you and expires in 14 days. ${esc(COMPANY)}</p>`;
    return { to: cand.email, subject: row.subject, html, text: `${row.body}\n\nI'm interested: ${url}&r=interested\nNot now: ${url}&r=not_interested`, entity_type: 'job_order', entity_id: job.id };
  }

  async function sendDrafts(job, ids, req) {
    const sent = [];
    for (const id of ids) {
      const row = await one("SELECT * FROM candidate_outreach WHERE id=$1 AND job_order_id=$2 AND status='draft'", [id, String(job.id)]);
      if (!row) continue;
      const cand = await one('SELECT * FROM candidates WHERE id::text=$1', [String(row.candidate_id)]);
      if (!cand || !cand.email) continue;
      const t = token();
      const upd = await one("UPDATE candidate_outreach SET status='sent', token=$1, sent_at=CURRENT_TIMESTAMP, expires_at=$2, created_by=COALESCE(created_by,$3), updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *", [t, new Date(Date.now() + 14 * 86400000), String(req.user.id), row.id]);
      await events.enqueue('email.send', outreachEmail(upd, cand, job), { dedupeKey: `outreach.email:${row.id}`, maxAttempts: 4 });
      await events.record({ type: 'outreach.sent', entity_type: 'candidate', entity_id: cand.id, actor: `user:${req.user.id}`, payload: { job_order_id: job.id, outreach_id: row.id } });
      await pool.query('INSERT INTO activities (type, title, contact, candidate_id, account_id, status, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7)', ['Email', `Outreach sent: ${job.title}`, cand.name, String(cand.id), job.account_id ? String(job.account_id) : null, 'completed', String(req.user.id)]).catch(() => {});
      sent.push({ ...upd, candidate_name: cand.name, candidate_email: cand.email });
    }
    return sent;
  }

  async function respond(row, body) {
    const response = body.response === 'interested' ? 'interested' : body.response === 'not_interested' ? 'not_interested' : null;
    if (!response) throw Object.assign(new Error('response must be interested or not_interested'), { status: 400 });
    const cand = await one('SELECT * FROM candidates WHERE id::text=$1', [String(row.candidate_id)]);
    const job = await one('SELECT * FROM job_orders WHERE id::text=$1', [String(row.job_order_id)]);
    if (!cand || !job) throw Object.assign(new Error('This opportunity is no longer available'), { status: 410 });
    const sets = { status: response, response, responded_at: new Date(), response_note: body.note || null, availability: body.availability || null };
    if (body.phone && !cand.phone) await pool.query('UPDATE candidates SET phone=$1 WHERE id::text=$2', [String(body.phone).slice(0, 50), String(cand.id)]).catch(() => {});
    if (body.work_authorization) await pool.query('UPDATE candidates SET work_auth=$1 WHERE id::text=$2', [String(body.work_authorization).slice(0, 100), String(cand.id)]).catch(() => {});
    let submission = null; let rtr = null;
    if (response === 'interested') {
      submission = await one('SELECT * FROM submissions WHERE job_order_id::text=$1 AND candidate_id::text=$2', [String(job.id), String(cand.id)]);
      if (!submission) {
        submission = await one('INSERT INTO submissions (candidate_id, job_order_id, status, notes, created_by, stage_changed_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) RETURNING *', [cand.id, job.id, normalizeSubmissionStatus('submitted'), `Responded to outreach${body.note ? `: ${body.note}` : ''}`, row.created_by]);
        await events.record({ type: 'submission.created', entity_type: 'submission', entity_id: submission.id, actor: `candidate:${cand.email}`, payload: { from: 'outreach', job_order_id: job.id } });
      }
      sets.submission_id = String(submission.id);
      try {
        rtr = await createSignatureRequest({ kind: 'rtr', entity_type: 'submission', entity_id: submission.id, req: { user: { id: row.created_by || 'system' } } });
        rtr = await sendSignatureRequest(rtr, { user: { id: row.created_by || 'system' } });
        sets.rtr_request_id = String(rtr.id);
      } catch (e) { await events.exception({ kind: 'outreach.rtr_failed', entity_type: 'submission', entity_id: submission.id, message: `Candidate ${cand.name} said yes but the RTR could not be sent: ${e.message}`, assigned_to: row.created_by }); }
      await pool.query('INSERT INTO activities (type, title, contact, candidate_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['Call', `Call ${cand.name}: interested in ${job.title}${body.availability ? ` (available ${body.availability})` : ''}`, cand.name, String(cand.id), 'pending', new Date(Date.now() + 86400000), row.created_by]).catch(() => {});
    }
    const cols = Object.keys(sets);
    await pool.query(`UPDATE candidate_outreach SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1}`, [...cols.map((c) => sets[c]), row.id]);
    await events.record({ type: `outreach.${response}`, entity_type: 'candidate', entity_id: cand.id, actor: `candidate:${cand.email}`, payload: { job_order_id: job.id, note: body.note || null, availability: body.availability || null, submission_id: submission ? submission.id : null } });
    await notifyOwners({ owners: [row.created_by], type: `outreach.${response}`, title: response === 'interested' ? `${cand.name} is interested in ${job.title}` : `${cand.name} passed on ${job.title}`, body: response === 'interested' ? `Submission created and the Right to Represent was ${rtr ? 'sent' : 'NOT sent (see exceptions)'}. Call them${body.availability ? ` (${body.availability})` : ''} to confirm the rate before sending to the client.` : (body.note || 'No reason given.'), entity_type: 'submission', entity_id: submission ? submission.id : null, email: response === 'interested' });
    return { ok: true, response, submission_id: submission ? submission.id : null, rtr_sent: !!rtr };
  }

  // Routes
  app.post('/api/job-orders/:id/outreach/draft', authenticateToken, wrap(async (req, res) => {
    const job = await one('SELECT * FROM job_orders WHERE id::text=$1', [String(req.params.id)]);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const b = req.body || {};
    res.json(await draftForJob(job, { limit: Number(b.limit) || 5, useAI: b.use_ai !== false, usOnly: b.us_only !== false, createdBy: req.user.id }));
  }));
  app.get('/api/job-orders/:id/outreach', authenticateToken, wrap(async (req, res) => {
    const list = await rows('SELECT o.*, c.name AS candidate_name, c.email AS candidate_email, c.title AS candidate_title FROM candidate_outreach o LEFT JOIN candidates c ON c.id::text=o.candidate_id ORDER BY o.rank, o.id', []);
    res.json(list.filter((o) => String(o.job_order_id) === String(req.params.id)).map((o) => ({ ...o, token: undefined, url: o.token ? `${APP_URL}/?candidate=${o.token}` : null })));
  }));
  app.put('/api/outreach/:id', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {};
    const q = await pool.query("UPDATE candidate_outreach SET subject=COALESCE($1, subject), body=COALESCE($2, body), updated_at=CURRENT_TIMESTAMP WHERE id=$3 AND status='draft' RETURNING *", [b.subject || null, b.body || null, req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Draft not found (only drafts can be edited)' });
    res.json(q.rows[0]);
  }));
  app.delete('/api/outreach/:id', authenticateToken, wrap(async (req, res) => { await pool.query("DELETE FROM candidate_outreach WHERE id=$1 AND status='draft'", [req.params.id]); res.json({ ok: true }); }));
  app.post('/api/job-orders/:id/outreach/send', authenticateToken, wrap(async (req, res) => {
    const job = await one('SELECT * FROM job_orders WHERE id::text=$1', [String(req.params.id)]);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const ids = (req.body && req.body.ids) || [];
    if (!ids.length) return res.status(400).json({ error: 'ids of the drafts to send are required' });
    const sent = await sendDrafts(job, ids, req);
    res.json({ sent: sent.length, outreach: sent.map((s) => ({ ...s, token: undefined })) });
  }));
  app.get('/api/candidate/:token', wrap(async (req, res) => {
    if (!(await throttle(`candidate:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const row = await one('SELECT * FROM candidate_outreach WHERE token=$1', [String(req.params.token)]);
    if (!row) return res.status(404).json({ error: 'This link is not valid' });
    const cand = await one('SELECT name FROM candidates WHERE id::text=$1', [String(row.candidate_id)]);
    const job = await one('SELECT title, location, salary_range, description, required_skills FROM job_orders WHERE id::text=$1', [String(row.job_order_id)]);
    const expired = row.expires_at && new Date(row.expires_at) < new Date() && row.status === 'sent';
    res.json({ company: COMPANY, candidate_first_name: cand ? String(cand.name).split(' ')[0] : '', status: expired ? 'expired' : row.status, response: row.response, message: row.body, job: job ? { title: job.title, location: job.location, rate: job.salary_range, skills: job.required_skills, description: job.description } : null, expires_at: row.expires_at });
  }));
  app.post('/api/candidate/:token/respond', wrap(async (req, res) => {
    if (!(await throttle(`candidate:${req.ip}`, 30))) return res.status(429).json({ error: 'Too many requests' });
    const row = await one('SELECT * FROM candidate_outreach WHERE token=$1', [String(req.params.token)]);
    if (!row) return res.status(404).json({ error: 'This link is not valid' });
    if (row.status !== 'sent') return res.status(409).json({ error: row.status === 'expired' ? 'This link has expired' : `You already answered (${row.response}). Contact ${COMPANY} to change it.` });
    if (row.expires_at && new Date(row.expires_at) < new Date()) { await pool.query("UPDATE candidate_outreach SET status='expired' WHERE id=$1", [row.id]); return res.status(410).json({ error: 'This link has expired' }); }
    res.json(await respond(row, req.body || {}));
  }));

  const workers = {
    'outreach.suggest': async ({ job_order_id, created_by }) => {
      const job = await one('SELECT * FROM job_orders WHERE id::text=$1', [String(job_order_id)]);
      if (!job) return 'gone';
      const r = await draftForJob(job, { limit: Number(process.env.OUTREACH_TOP || 5), useAI: true, createdBy: created_by || job.created_by });
      if (r.drafts.length) await notifyOwners({ owners: [created_by || job.created_by], type: 'outreach.ready', title: `${r.drafts.length} outreach draft(s) ready: ${job.title}`, body: `Matching ran on the approved job order. Review the drafts on the job order (Outreach) and send the ones you like.`, entity_type: 'job_order', entity_id: job.id });
      return { drafts: r.drafts.length };
    },
  };
  return { draftForJob, sendDrafts, respond, workers, templateDraft };
}

module.exports = { install, SCHEMA, templateDraft, aiDraft, _setClientForTests, isAIConfigured, MODEL };
