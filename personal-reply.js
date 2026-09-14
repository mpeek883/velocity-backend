// "Reply as myself": for admins only. Instead of the staffing-firm reply, Brad
// tells the recruiter he IS interested in the role, explains why he is a strong
// fit, and attaches a resume tailored to that position (built from his stored
// base resume; nothing is invented). Sending is always a click.
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

const MODEL = process.env.PERSONAL_AI_MODEL || process.env.LEAD_AI_MODEL || 'claude-opus-5';
let defaultClient = null;
function getClient() { if (!defaultClient) defaultClient = new Anthropic({ timeout: 120 * 1000, maxRetries: 2 }); return defaultClient; }
function _setClientForTests(c) { defaultClient = c; }
const isAIConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SCHEMA = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS resume_text TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS resume_filename VARCHAR(255)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS resume_updated_at TIMESTAMP',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS headline VARCHAR(255)',
  `CREATE TABLE IF NOT EXISTS tailored_resumes (id SERIAL PRIMARY KEY, lead_id TEXT, user_id TEXT, job_title VARCHAR(255), subject VARCHAR(500), body TEXT, resume_markdown TEXT, filename VARCHAR(255), model VARCHAR(80), status VARCHAR(20) DEFAULT 'draft', sent_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
];

const DraftSchema = z.object({
  subject: z.string().describe('Reply subject line, usually "Re: " + their subject.'),
  body: z.string().describe('The reply body in plain text, no signature.'),
  fit_points: z.array(z.string()).describe('Three to five one-line reasons Brad is a strong fit, each grounded in the resume.'),
  resume_markdown: z.string().describe('The tailored resume in Markdown: # Name, contact line, ## Summary, ## Core Skills, ## Experience (company, title, dates, bullets), ## Education / Certifications. Only facts present in the base resume, re-ordered and emphasised for this role.'),
});

function baseResumeMissing() { const e = new Error('Add your base resume under Settings > My Profile first (paste it or upload a PDF/DOCX).'); e.status = 409; e.code = 'RESUME_REQUIRED'; throw e; }

function templateDraft(lead, user) {
  const first = String(lead.name || '').split(' ')[0] || 'there';
  const role = lead.job_title || 'the role';
  const subject = `Re: ${lead.email_subject || role}`;
  const body = `Hi ${first},\n\nThank you for reaching out about the ${role}${lead.end_client ? ` with ${lead.end_client}` : ''}. I am very interested.\n\nThe role lines up closely with what I have been doing: I have led exactly this kind of work and can step in quickly. I have attached a resume tailored to the position so you can see the fit at a glance.\n\nI am available to talk this week at your convenience${lead.rate_or_salary ? `, and the ${lead.rate_or_salary} rate works for me` : ''}. Please let me know the next step.`;
  const resume_markdown = `# ${user.name || 'Brad Peek'}\n${[user.email, user.phone].filter(Boolean).join(' · ')}\n\n## Summary\n${user.headline || ''}\n\n${(user.resume_text || '').trim()}`;
  return { subject, body, fit_points: [], resume_markdown, model: 'template' };
}

async function draftPersonalReply(lead, user, { client } = {}) {
  if (!user.resume_text || user.resume_text.trim().length < 80) baseResumeMissing();
  if (!(client || isAIConfigured())) return templateDraft(lead, user);
  const c = client || getClient();
  const system = [
    `You write on behalf of ${user.name || 'Brad Peek'} (${user.headline || 'senior IT professional'}), replying personally to a recruiter who emailed about a role. ${user.name || 'Brad'} IS interested in this role for himself.`,
    'Write two things. (1) A warm, confident, specific reply in plain text (no markdown, no subject inside the body, no signature: it is appended automatically) that thanks the recruiter, says clearly that he is interested, gives three to five concrete reasons he is a strong fit drawn from his resume and mapped to the job details, confirms logistics that are known (location/remote, rate if acceptable, availability) and asks for the next step. 150-260 words.',
    '(2) A resume tailored to this position in Markdown. Use ONLY facts from the base resume: never invent employers, dates, titles, certifications, technologies or numbers. Re-order and emphasise: lead with a summary aimed at this role, a Core Skills section that surfaces the technologies the job asks for and he actually has, then Experience with the most relevant bullets first (rewrite bullets to speak to the job, keep them truthful), then Education / Certifications. Keep it to what fits on two pages. Structure: "# Full Name", a contact line, "## Summary", "## Core Skills", "## Experience" (each job as "### Title, Company (dates)" followed by bullets), "## Education / Certifications".',
    'If the base resume lacks something the job asks for, do not claim it; the reply can say he is quick to pick it up.',
  ].join(' ');
  const context = {
    recruiter: { name: lead.name, title: lead.title, company: lead.company },
    their_email: { subject: lead.email_subject, body: (lead.email_body || '').slice(0, 3000) },
    role: { job_title: lead.job_title, end_client: lead.end_client, location: lead.job_location, work_arrangement: lead.work_arrangement, rate: lead.rate_or_salary, employment_type: lead.employment_type, job_description: (lead.job_description || '').slice(0, 4000) },
    base_resume: user.resume_text.slice(0, 14000),
    contact_line: [user.email, user.phone].filter(Boolean).join(' · '),
  };
  const response = await c.messages.parse({ model: MODEL, max_tokens: 6000, system, output_config: { effort: 'medium', format: zodOutputFormat(DraftSchema) }, messages: [{ role: 'user', content: `Write the reply and the tailored resume.\n\n<context>\n${JSON.stringify(context, null, 2)}\n</context>` }] });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return templateDraft(lead, user);
  const p = response.parsed_output;
  return { subject: p.subject || `Re: ${lead.email_subject || lead.job_title || 'Your email'}`, body: p.body.trim(), fit_points: p.fit_points || [], resume_markdown: p.resume_markdown.trim(), model: response.model || MODEL };
}

/** Markdown (headings, ### job lines, bullets, paragraphs) -> DOCX buffer. */
async function resumeDocx(markdown, { name = 'Resume' } = {}) {
  const children = [];
  const inline = (t) => { const runs = []; const re = /\*\*(.+?)\*\*/g; let last = 0; let m; while ((m = re.exec(t))) { if (m.index > last) runs.push(new TextRun(t.slice(last, m.index))); runs.push(new TextRun({ text: m[1], bold: true })); last = m.index + m[0].length; } if (last < t.length) runs.push(new TextRun(t.slice(last))); return runs.length ? runs : [new TextRun('')]; };
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('# ')) children.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
    else if (line.startsWith('## ')) children.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 80 } }));
    else if (line.startsWith('### ')) children.push(new Paragraph({ children: [new TextRun({ text: line.slice(4).trim(), bold: true })], spacing: { before: 160, after: 40 } }));
    else if (/^[-*•]\s+/.test(line)) children.push(new Paragraph({ children: inline(line.replace(/^[-*•]\s+/, '')), bullet: { level: 0 } }));
    else if (i === 1 || (i === 2 && !lines[1].trim())) children.push(new Paragraph({ children: inline(line), alignment: AlignmentType.CENTER, spacing: { after: 120 } }));
    else children.push(new Paragraph({ children: inline(line), spacing: { after: 80 } }));
  }
  const doc = new Document({ creator: name, title: `${name} resume`, styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }] });
  return Packer.toBuffer(doc);
}
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
function resumeFilename(user, lead) { return `${safeName(user.name || 'Resume')}_Resume_${safeName(lead.job_title || 'Role')}.docx`; }

function install(deps) {
  const { app, pool, authenticateToken, requireAdmin, sendEmail, textToHtml, leadWorkflow, events, extractText, resumeUpload, notifyOwners } = deps;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); } };
  const loadUser = (id) => one('SELECT id, name, email, phone, headline, resume_text, resume_filename, resume_updated_at FROM users WHERE id::text=$1', [String(id)]);
  const loadLead = (id) => one('SELECT * FROM leads WHERE id::text=$1', [String(id)]);

  // ---- My resume (any signed-in user keeps their own; only admins can use it on leads) ----
  app.get('/api/users/me/resume', authenticateToken, wrap(async (req, res) => { const u = await loadUser(req.user.id); res.json({ resume_text: u ? u.resume_text || '' : '', resume_filename: u ? u.resume_filename : null, resume_updated_at: u ? u.resume_updated_at : null, phone: u ? u.phone : null, headline: u ? u.headline : null, chars: u && u.resume_text ? u.resume_text.length : 0 }); }));
  app.put('/api/users/me/resume', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {};
    const sets = {};
    if (b.resume_text !== undefined) { sets.resume_text = String(b.resume_text).slice(0, 60000); sets.resume_filename = b.resume_filename || 'pasted text'; }
    if (b.phone !== undefined) sets.phone = String(b.phone).slice(0, 50);
    if (b.headline !== undefined) sets.headline = String(b.headline).slice(0, 255);
    const cols = Object.keys(sets);
    if (!cols.length) return res.status(400).json({ error: 'Nothing to save' });
    if (sets.resume_text !== undefined) { cols.push('resume_updated_at'); sets.resume_updated_at = new Date(); }
    await pool.query(`UPDATE users SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')} WHERE id::text=$${cols.length + 1}`, [...cols.map((c) => sets[c]), String(req.user.id)]);
    await events.record({ type: 'user.resume_updated', entity_type: 'user', entity_id: req.user.id, actor: `user:${req.user.id}`, payload: { chars: sets.resume_text ? sets.resume_text.length : undefined } });
    res.json({ ok: true, chars: sets.resume_text ? sets.resume_text.length : undefined });
  }));
  app.post('/api/users/me/resume/upload', authenticateToken, (req, res) => {
    resumeUpload.single('resume')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) return res.status(400).json({ error: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB).' : uploadErr.message });
        if (!req.file) return res.status(400).json({ error: 'Attach a PDF, DOCX or TXT file as "resume"' });
        const text = await extractText(req.file.buffer, req.file.originalname);
        if (!text || text.trim().length < 80) return res.status(400).json({ error: 'Could not read enough text from that file. Paste the resume text instead.' });
        await pool.query('UPDATE users SET resume_text=$1, resume_filename=$2, resume_updated_at=CURRENT_TIMESTAMP WHERE id::text=$3', [text.slice(0, 60000), req.file.originalname, String(req.user.id)]);
        await events.record({ type: 'user.resume_updated', entity_type: 'user', entity_id: req.user.id, actor: `user:${req.user.id}`, payload: { filename: req.file.originalname, chars: text.length } });
        res.json({ ok: true, chars: text.length, resume_filename: req.file.originalname });
      } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
  });

  // ---- Reply as myself (admin only) ----
  app.post('/api/leads/:id/personal-draft', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const lead = await loadLead(req.params.id); if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const user = await loadUser(req.user.id);
    const d = await draftPersonalReply(lead, user);
    const filename = resumeFilename(user, lead);
    await pool.query("DELETE FROM tailored_resumes WHERE lead_id=$1 AND user_id=$2 AND status='draft'", [String(lead.id), String(req.user.id)]);
    const row = await one('INSERT INTO tailored_resumes (lead_id, user_id, job_title, subject, body, resume_markdown, filename, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [String(lead.id), String(req.user.id), lead.job_title || null, d.subject, d.body, d.resume_markdown, filename, d.model]);
    await events.record({ type: 'lead.personal_drafted', entity_type: 'lead', entity_id: lead.id, actor: `user:${req.user.id}`, payload: { model: d.model, draft_id: row.id } });
    res.json({ draft_id: row.id, subject: d.subject, body: d.body, fit_points: d.fit_points, resume_markdown: d.resume_markdown, filename, model: d.model, signature: leadWorkflow.SIGNATURE });
  }));
  app.get('/api/leads/:id/personal-draft', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const row = await one('SELECT * FROM tailored_resumes WHERE lead_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [String(req.params.id), String(req.user.id)]);
    if (!row) return res.status(404).json({ error: 'No personal draft yet' });
    res.json({ draft_id: row.id, subject: row.subject, body: row.body, resume_markdown: row.resume_markdown, filename: row.filename, model: row.model, status: row.status, sent_at: row.sent_at, signature: leadWorkflow.SIGNATURE });
  }));
  app.post('/api/leads/:id/personal-resume.docx', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const lead = await loadLead(req.params.id); if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const user = await loadUser(req.user.id);
    const md = (req.body && req.body.resume_markdown) || (await one('SELECT resume_markdown FROM tailored_resumes WHERE lead_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [String(lead.id), String(req.user.id)]) || {}).resume_markdown;
    if (!md) return res.status(404).json({ error: 'No tailored resume yet; draft one first' });
    const buf = await resumeDocx(md, { name: user.name });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${resumeFilename(user, lead)}"`);
    res.send(buf);
  }));
  app.post('/api/leads/:id/personal-reply', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const lead = await loadLead(req.params.id); if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.email) return res.status(400).json({ error: 'Lead has no email address' });
    const user = await loadUser(req.user.id);
    const b = req.body || {};
    if (!b.subject || !b.body) return res.status(400).json({ error: 'subject and body are required' });
    const attach = b.attach_resume !== false;
    if (attach && !b.resume_markdown) return res.status(400).json({ error: 'resume_markdown is required when attaching the tailored resume' });
    const fullBody = `${String(b.body).trim()}\n\n${leadWorkflow.SIGNATURE}`;
    const filename = resumeFilename(user, lead);
    const mail = { to: lead.email, subject: b.subject, text: fullBody, html: textToHtml(fullBody) };
    if (attach) { mail.attachmentBuffer = await resumeDocx(b.resume_markdown, { name: user.name }); mail.attachmentFilename = filename; }
    const result = await sendEmail(mail);
    await leadWorkflow.logEmail(pool, lead, { direction: 'outbound', kind: 'personal_reply', subject: b.subject, body: fullBody + (attach ? `\n\n[Attached: ${filename}]` : ''), to_email: lead.email });
    await pool.query("UPDATE tailored_resumes SET status='sent', sent_at=CURRENT_TIMESTAMP, subject=$1, body=$2, resume_markdown=COALESCE($3, resume_markdown), updated_at=CURRENT_TIMESTAMP WHERE lead_id=$4 AND user_id=$5 AND status='draft'", [b.subject, b.body, b.resume_markdown || null, String(lead.id), String(req.user.id)]).catch(() => {});
    const updated = await leadWorkflow.setLead(pool, lead.id, { workflow_status: 'personal_interest', status: 'personal', reviewed_at: lead.reviewed_at || new Date(), replied_at: new Date(), follow_up_due_at: null, missing_info: '[]' });
    await events.record({ type: 'lead.personal_reply_sent', entity_type: 'lead', entity_id: lead.id, actor: `user:${req.user.id}`, payload: { to: lead.email, attached: attach ? filename : null, transport: result && result.transport } });
    await pool.query('INSERT INTO activities (type, title, contact, account, lead_id, status, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7)', ['Email', `Applied personally: ${lead.job_title || 'role'}${lead.end_client ? ` at ${lead.end_client}` : ''}`, lead.name, lead.company, String(lead.id), 'completed', String(req.user.id)]).catch(() => {});
    res.json({ ok: true, transport: result && result.transport, attached: attach ? filename : null, lead: updated });
  }));

  // Replies on a personal lead are never auto-answered; the owner is told instead.
  const onPersonalInbound = async (lead, msg) => {
    await notifyOwners({ owners: [lead.assigned_to], roles: ['admin'], type: 'lead.personal_reply', title: `${lead.name} replied about ${lead.job_title || 'the role you applied for'}`, body: String(msg.text || '').slice(0, 400), entity_type: 'lead', entity_id: lead.id });
  };
  return { draftPersonalReply, resumeDocx, resumeFilename, onPersonalInbound };
}

module.exports = { install, SCHEMA, draftPersonalReply, resumeDocx, resumeFilename, templateDraft, _setClientForTests, isAIConfigured, MODEL };
