// Workflow automation on top of events.js:
//   - notifications (in-app + email via the job queue)
//   - controlled submission statuses with audited transitions and gates
//   - Authorize Search checkpoint: one idempotent transaction that opens the
//     search (account, contact, opportunity, job order, intake link, NDA check)
//   - client intake link -> authoritative job order fields after approval
//   - client review link for submissions with client-side actions
//   - interview rounds, offers, contract stages before placement
//   - e-signature requests (NDA / RTR / SOW) with webhook status updates
//   - audit routes: events, exceptions, jobs, summary
const esign = require('./esign');
const dedupe = require('./dedupe');
const { Events, parse } = require('./events');
const EXTRA_SCHEMA = [...require('./watchdog').SCHEMA, ...require('./outreach').SCHEMA, ...require('./timesheets').SCHEMA, ...dedupe.SCHEMA, ...require('./personal-reply').SCHEMA];

const APP_URL = (process.env.APP_URL || 'https://velocity-i5hx.onrender.com').replace(/\/$/, '');
const COMPANY = esign.COMPANY;

// ---------- Controlled submission statuses ----------
const SUBMISSION_STATUSES = [
  { id: 'submitted', label: 'Submitted', order: 1 },
  { id: 'client_review', label: 'With client', order: 2 },
  { id: 'interview_requested', label: 'Interview requested', order: 3 },
  { id: 'interviewing', label: 'Interviewing', order: 4 },
  { id: 'offer', label: 'Offer', order: 5 },
  { id: 'offer_accepted', label: 'Offer accepted', order: 6 },
  { id: 'contract_sent', label: 'Contract sent', order: 7 },
  { id: 'contract_signed', label: 'Contract signed', order: 8 },
  { id: 'hired', label: 'Hired / placed', order: 9, terminal: true },
  { id: 'on_hold', label: 'On hold', order: 10 },
  { id: 'declined', label: 'Declined by client', order: 11, terminal: true },
  { id: 'withdrawn', label: 'Candidate withdrew', order: 12, terminal: true },
];
const STATUS_IDS = SUBMISSION_STATUSES.map((s) => s.id);
const STATUS_ALIASES = {
  pending: 'submitted', new: 'submitted', reviewed: 'client_review', 'client review': 'client_review', 'with client': 'client_review',
  'phone screen': 'interviewing', screening: 'interviewing', technical: 'interviewing', interview: 'interviewing', 'hiring manager': 'interviewing', 'final round': 'interviewing', 'interview requested': 'interview_requested',
  'offer extended': 'offer', 'offer pending': 'offer', accepted: 'offer_accepted', 'offer accepted': 'offer_accepted', rejected: 'declined', placed: 'hired', hire: 'hired', hold: 'on_hold', 'on hold': 'on_hold', withdrew: 'withdrawn',
};
function normalizeSubmissionStatus(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
  if (!k) return 'submitted';
  if (STATUS_IDS.includes(k.replace(/ /g, '_'))) return k.replace(/ /g, '_');
  return STATUS_ALIASES[k] || null;
}
const INTERVIEW_OR_LATER = ['interview_requested', 'interviewing', 'offer', 'offer_accepted', 'contract_sent', 'contract_signed', 'hired'];
const OFFER_OR_LATER = ['offer', 'offer_accepted', 'contract_sent', 'contract_signed', 'hired'];
const ACCEPTED_OR_LATER = ['offer_accepted', 'contract_sent', 'contract_signed', 'hired'];
const PLACEMENT_READY = ['offer_accepted', 'contract_sent', 'contract_signed'];

const { roleRequirements } = require('./skills');

const INTAKE_FIELDS = ['title', 'location', 'work_arrangement', 'description', 'required_skills', 'rate', 'rate_type', 'employment_type', 'duration', 'start_date', 'target_fill_date', 'interview_process', 'positions', 'priority', 'notes', 'submitted_by_name', 'submitted_by_email'];
const CLIENT_ACTIONS = { request_interview: 'Request interview', decline: 'Decline', more_info: 'Request more information', hold: 'Put on hold', select: 'Select for offer' };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intake_links (id SERIAL PRIMARY KEY, token VARCHAR(80), job_order_id TEXT, opportunity_id TEXT, lead_id TEXT, account_id TEXT, sent_to VARCHAR(255), status VARCHAR(20) DEFAULT 'pending', submitted_data TEXT, submitted_by VARCHAR(255), created_by TEXT, expires_at TIMESTAMP, sent_at TIMESTAMP, submitted_at TIMESTAMP, approved_at TIMESTAMP, approved_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS client_links (id SERIAL PRIMARY KEY, token VARCHAR(80), submission_id TEXT, job_order_id TEXT, candidate_id TEXT, profile_id TEXT, sent_to VARCHAR(255), status VARCHAR(20) DEFAULT 'active', created_by TEXT, expires_at TIMESTAMP, sent_at TIMESTAMP, first_viewed_at TIMESTAMP, last_action VARCHAR(40), last_action_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS client_actions (id SERIAL PRIMARY KEY, client_link_id INTEGER, submission_id TEXT, action VARCHAR(40), note TEXT, availability TEXT, actor_name VARCHAR(255), actor_email VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS interview_rounds (id SERIAL PRIMARY KEY, submission_id TEXT, round INTEGER, type VARCHAR(60), scheduled_at TIMESTAMP, interviewer VARCHAR(255), status VARCHAR(20) DEFAULT 'requested', outcome VARCHAR(20), feedback TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS offers (id SERIAL PRIMARY KEY, submission_id TEXT, candidate_id TEXT, job_order_id TEXT, rate VARCHAR(100), rate_type VARCHAR(30), start_date DATE, end_date DATE, terms TEXT, status VARCHAR(20) DEFAULT 'draft', extended_at TIMESTAMP, responded_at TIMESTAMP, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS signature_requests (id SERIAL PRIMARY KEY, kind VARCHAR(20), entity_type VARCHAR(40), entity_id TEXT, account_id TEXT, candidate_id TEXT, submission_id TEXT, signer_name VARCHAR(255), signer_email VARCHAR(255), provider VARCHAR(30), provider_agreement_id VARCHAR(255), status VARCHAR(20) DEFAULT 'draft', document_html TEXT, fields TEXT, last_event TEXT, error TEXT, created_by TEXT, sent_at TIMESTAMP, viewed_at TIMESTAMP, signed_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id TEXT, type VARCHAR(60), title VARCHAR(255), body TEXT, link VARCHAR(255), entity_type VARCHAR(40), entity_id TEXT, read_at TIMESTAMP, emailed_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_order_id TEXT',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMP',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS authorized_by TEXT',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20)',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS intake_data TEXT',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS source_of_truth VARCHAR(30)',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS lead_id TEXT',
  'ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS created_by TEXT',
  'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMP',
  'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS submitted_to VARCHAR(255)',
  'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rtr_status VARCHAR(20)',
  'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS contract_status VARCHAR(20)',
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nda_status VARCHAR(20)',
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nda_signed_at TIMESTAMP',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS interviewer_email VARCHAR(255)',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS location VARCHAR(255)',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS duration_minutes INTEGER',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS feedback_token VARCHAR(80)',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS rating INTEGER',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS recommendation VARCHAR(20)',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMP',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP',
  'ALTER TABLE interview_rounds ADD COLUMN IF NOT EXISTS calendar_uid VARCHAR(120)',
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS created_by TEXT',
];

const tokenUrl = (kind, token) => `${APP_URL}/?${kind}=${encodeURIComponent(token)}`;
const days = (n) => new Date(Date.now() + n * 86400000);
const actorOf = (req) => (req && req.user ? `user:${req.user.id}` : 'system');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nl2br = (s) => esc(s).replace(/\n/g, '<br/>');

function install(deps) {
  const { app, pool, authenticateToken, requireAdmin, sendEmail, isEmailConfigured, insertRow, JOB_ORDER_COLS, markdownToHtml, buildCandidateProfile, isProfileAIConfigured, leadWorkflow, contactsSync, roleCache } = deps;
  const events = deps.events || new Events(pool);
  const audit = (type, entity_type, entity_id, req, payload, extra = {}) => events.record({ type, entity_type, entity_id, actor: actorOf(req), payload, ...extra });

  async function ensureSchema() {
    await events.ensureSchema();
    for (const sql of [...SCHEMA, ...EXTRA_SCHEMA]) { try { await pool.query(sql); } catch (e) { if (!/already exists|not supported/i.test(e.message)) console.error('⚠️ automation schema:', sql.slice(0, 60), '-', e.message.split('\n')[0]); } }
  }

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const loadSubmission = (id) => one('SELECT * FROM submissions WHERE id::text=$1', [String(id)]);
  const loadJobOrder = (id) => one('SELECT * FROM job_orders WHERE id::text=$1', [String(id)]);
  const loadCandidate = (id) => one('SELECT * FROM candidates WHERE id::text=$1', [String(id)]);
  const loadAccount = (id) => (id == null ? null : one('SELECT * FROM accounts WHERE id::text=$1', [String(id)]));
  const loadUser = (id) => (id == null ? null : one('SELECT id, name, email, role FROM users WHERE id::text=$1', [String(id)]));
  async function accountForJob(job) {
    if (!job) return null;
    if (job.account_id) return loadAccount(job.account_id);
    if (job.company) return one('SELECT * FROM accounts WHERE LOWER(name)=LOWER($1) ORDER BY id LIMIT 1', [job.company]);
    return null;
  }

  // ---------- Notifications ----------
  async function notify({ user_ids = [], roles = [], type, title, body = '', link = null, entity_type = null, entity_id = null, email = true, exclude = null }) {
    const ids = new Set(user_ids.filter((x) => x != null).map(String));
    if (roles.length) {
      try { const q = await pool.query('SELECT id FROM users WHERE COALESCE(is_active, TRUE) = TRUE'); for (const u of q.rows) { const r = await roleCache.roleFor(u.id); if (roles.includes(r)) ids.add(String(u.id)); } } catch { /* */ }
    }
    if (exclude != null) ids.delete(String(exclude));
    if (!ids.size) return [];
    const rows = [];
    for (const uid of ids) {
      try {
        const q = await pool.query('INSERT INTO notifications (user_id, type, title, body, link, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [uid, type, String(title).slice(0, 255), body, link, entity_type, entity_id == null ? null : String(entity_id)]);
        rows.push(q.rows[0]);
        if (email && process.env.NOTIFY_EMAIL !== 'false') await events.enqueue('notify.email', { notification_id: q.rows[0].id }, { dedupeKey: `notify.email:${q.rows[0].id}`, maxAttempts: 4 });
      } catch (e) { console.error('⚠️ notification failed:', e.message); }
    }
    return rows;
  }
  async function notifyOwners({ owners = [], ...rest }) { return notify({ user_ids: owners, roles: owners.length ? [] : ['admin'], ...rest }); }

  // ---------- Job workers ----------
  const workers = {
    'notify.email': async ({ notification_id }) => {
      const n = await one('SELECT * FROM notifications WHERE id=$1', [notification_id]);
      if (!n || n.emailed_at) return 'skipped';
      const u = await loadUser(n.user_id);
      if (!u || !u.email) return 'no email';
      if (!isEmailConfigured()) return 'email not configured';
      await sendEmail({ to: u.email, subject: `[VelocityCRM] ${n.title}`, html: `<p>${nl2br(n.body || n.title)}</p>${n.link ? `<p><a href="${esc(n.link)}">Open in VelocityCRM</a></p>` : ''}`, text: `${n.body || n.title}${n.link ? `\n\n${n.link}` : ''}` });
      await pool.query('UPDATE notifications SET emailed_at=CURRENT_TIMESTAMP WHERE id=$1', [n.id]);
      return 'sent';
    },
    'email.send': async ({ to, subject, html, text, entity_type, entity_id, attachment_base64, attachment_filename }) => {
      if (!isEmailConfigured()) throw new Error('Email is not configured on the API service (SMTP_* or Microsoft Graph)');
      const r = await sendEmail({ to, subject, html, text, ...(attachment_base64 && attachment_filename ? { attachmentBuffer: Buffer.from(attachment_base64, 'base64'), attachmentFilename: attachment_filename } : {}) });
      await events.record({ type: 'email.sent', entity_type, entity_id, payload: { to, subject, transport: r && r.transport } });
      return r;
    },
    'intake.reminder': async ({ intake_link_id }) => {
      const l = await one('SELECT * FROM intake_links WHERE id=$1', [intake_link_id]);
      if (!l || l.status !== 'pending') return 'not pending';
      const job = await loadJobOrder(l.job_order_id);
      await notifyOwners({ owners: [l.created_by], type: 'intake.reminder', title: `Client intake still open: ${job ? job.title : 'job order'}`, body: `The intake link sent to ${l.sent_to || 'the client'} has not been completed. Follow up or approve the job order with the details on file.`, entity_type: 'job_order', entity_id: l.job_order_id });
      await events.exception({ kind: 'intake.overdue', entity_type: 'job_order', entity_id: l.job_order_id, message: `Client intake for "${job ? job.title : l.job_order_id}" not completed after 3 days`, assigned_to: l.created_by });
      return 'reminded';
    },
    'client.reminder': async ({ client_link_id }) => {
      const l = await one('SELECT * FROM client_links WHERE id=$1', [client_link_id]);
      if (!l || l.last_action) return 'acted';
      const sub = await loadSubmission(l.submission_id);
      const cand = sub ? await loadCandidate(sub.candidate_id) : null;
      await notifyOwners({ owners: [l.created_by], type: 'client.reminder', title: `No client response yet: ${cand ? cand.name : 'candidate'}`, body: `${l.sent_to || 'The client'} has not acted on the candidate profile${l.first_viewed_at ? ' (viewed)' : ' (not viewed)'}. Consider a follow-up call.`, entity_type: 'submission', entity_id: l.submission_id });
      return 'reminded';
    },
    'esign.refresh': async ({ request_id }) => {
      const r = await one('SELECT * FROM signature_requests WHERE id=$1', [request_id]);
      if (!r || !r.provider_agreement_id || ['signed', 'declined', 'cancelled', 'expired'].includes(r.status)) return 'final';
      const s = await esign.agreementStatus(r.provider_agreement_id);
      if (s.status && s.status !== r.status) await applySignatureStatus(r, s.status, { event: `poll:${s.provider_status}` });
      else if (!['signed', 'declined', 'cancelled', 'expired'].includes(s.status)) throw new Error(`still ${s.provider_status}`); // retry later with backoff
      return s.status;
    },
  };
  workers['interview.invite'] = async ({ interview_id }) => {
    const ir = await one('SELECT * FROM interview_rounds WHERE id=$1', [interview_id]);
    if (!ir || !ir.scheduled_at || ir.status === 'cancelled') return 'skip';
    const sub = await loadSubmission(ir.submission_id); if (!sub) return 'no submission';
    const cand = await loadCandidate(sub.candidate_id); const job = await loadJobOrder(sub.job_order_id);
    const uid = ir.calendar_uid || `velocity-interview-${ir.id}@${(APP_URL.replace(/^https?:\/\//, ''))}`;
    const ics = buildIcs({ uid, start: new Date(ir.scheduled_at), minutes: ir.duration_minutes || 60, summary: `Interview: ${cand ? cand.name : 'Candidate'} - ${job ? job.title : 'role'} (round ${ir.round})`, description: `${ir.type || 'Interview'}${ir.interviewer ? ` with ${ir.interviewer}` : ''}. Arranged by ${COMPANY}.`, location: ir.location || '', attendees: [cand && cand.email, ir.interviewer_email].filter(Boolean) });
    const when = new Date(ir.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    let sent = [];
    if (cand && cand.email) {
      await events.enqueue('email.send', { to: cand.email, subject: `Interview confirmed: ${job ? job.title : 'role'}, ${when}`, html: `<p>Hi ${esc(cand.name.split(' ')[0])},</p><p>Your round ${ir.round} interview${job ? ` for <strong>${esc(job.title)}</strong>` : ''} is set for <strong>${esc(when)}</strong>${ir.interviewer ? ` with ${esc(ir.interviewer)}` : ''}${ir.location ? ` (${esc(ir.location)})` : ''}. A calendar invitation is attached.</p><h3>How to prepare</h3><ul><li>Re-read the job description and pick two or three examples from your work that match the must-have skills${job && job.required_skills ? ` (${esc(job.required_skills)})` : ''}.</li><li>Be ready to walk through your most recent project: the problem, what you did, the result.</li><li>Have two questions ready about the team and the first 90 days.</li><li>Join five minutes early; if anything changes, reply to this email.</li></ul><p>Good luck,<br/>${esc(COMPANY)}</p>`, text: `Interview round ${ir.round} for ${job ? job.title : 'role'}: ${when}.`, attachment_base64: Buffer.from(ics).toString('base64'), attachment_filename: 'interview.ics', entity_type: 'submission', entity_id: sub.id }, { dedupeKey: `interview.invite.cand:${ir.id}:${new Date(ir.scheduled_at).getTime()}`, maxAttempts: 3 });
      sent.push('candidate');
    }
    if (ir.interviewer_email) {
      const fb = `${APP_URL}/?feedback=${ir.feedback_token}`;
      await events.enqueue('email.send', { to: ir.interviewer_email, subject: `Interview scheduled: ${cand ? cand.name : 'candidate'} for ${job ? job.title : 'role'}, ${when}`, html: `<p>Hello${ir.interviewer ? ` ${esc(ir.interviewer)}` : ''},</p><p>Round ${ir.round} with <strong>${esc(cand ? cand.name : 'the candidate')}</strong>${job ? ` for ${esc(job.title)}` : ''} is set for <strong>${esc(when)}</strong>${ir.location ? ` (${esc(ir.location)})` : ''}. A calendar invitation is attached.</p><p>After the interview, please leave your feedback here (two minutes):</p><p><a href="${esc(fb)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Give feedback</a></p><p>${esc(COMPANY)}</p>`, text: `Interview ${when}. Feedback: ${fb}`, attachment_base64: Buffer.from(ics).toString('base64'), attachment_filename: 'interview.ics', entity_type: 'submission', entity_id: sub.id }, { dedupeKey: `interview.invite.int:${ir.id}:${new Date(ir.scheduled_at).getTime()}`, maxAttempts: 3 });
      sent.push('interviewer');
    }
    await pool.query('UPDATE interview_rounds SET invite_sent_at=CURRENT_TIMESTAMP, calendar_uid=$1 WHERE id=$2', [uid, ir.id]);
    await events.record({ type: 'interview.invited', entity_type: 'submission', entity_id: sub.id, payload: { round: ir.round, sent, scheduled_at: ir.scheduled_at } });
    return sent.join('+') || 'nobody to invite';
  };
  workers['interview.reminder'] = async ({ interview_id }) => {
    const ir = await one('SELECT * FROM interview_rounds WHERE id=$1', [interview_id]);
    if (!ir || ir.status !== 'scheduled') return 'skip';
    const sub = await loadSubmission(ir.submission_id); const cand = sub ? await loadCandidate(sub.candidate_id) : null; const job = sub ? await loadJobOrder(sub.job_order_id) : null;
    const when = new Date(ir.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    if (cand && cand.email) await events.enqueue('email.send', { to: cand.email, subject: `Reminder: interview tomorrow, ${when}`, html: `<p>Hi ${esc(cand.name.split(' ')[0])}, a reminder that your round ${ir.round} interview${job ? ` for ${esc(job.title)}` : ''} is ${esc(when)}${ir.location ? ` (${esc(ir.location)})` : ''}. Reply if anything has changed.</p><p>${esc(COMPANY)}</p>`, text: `Reminder: interview ${when}`, entity_type: 'submission', entity_id: sub.id }, { dedupeKey: `interview.reminder.email:${ir.id}`, maxAttempts: 2 });
    if (sub) await notifyOwners({ owners: [sub.created_by], type: 'interview.tomorrow', title: `Interview tomorrow: ${cand ? cand.name : 'candidate'} (${when})`, body: 'Confirm the candidate is prepared and the interviewer has the invite.', entity_type: 'submission', entity_id: sub.id, email: false });
    return 'reminded';
  };
  const hooks = { afterPlacement: [], intakeApproved: null, bootstrap: null };
  function registerWorkers(extra) { Object.assign(workers, extra); }
  let runner = null;
  function startJobRunner(intervalMs = 30000) {
    if (process.env.NODE_ENV === 'test' || runner) return;
    runner = setInterval(() => events.runJobs(workers).catch((e) => console.error('⚠️ job runner:', e.message)), intervalMs);
    if (runner.unref) runner.unref();
    if (hooks.bootstrap) setTimeout(() => hooks.bootstrap(), 15000);
  }
  function buildIcs({ uid, start, minutes, summary, description, location, attendees }) {
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const end = new Date(start.getTime() + minutes * 60000);
    const escI = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${COMPANY}//VelocityCRM//EN`, 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${escI(summary)}`, `DESCRIPTION:${escI(description)}`, location ? `LOCATION:${escI(location)}` : null, `ORGANIZER;CN=${escI(COMPANY)}:mailto:${process.env.FROM_EMAIL || 'noreply@example.com'}`, ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a}`), 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  }
  async function scheduleInterviewComms(ir, { sendInvite = true } = {}) {
    if (!ir.scheduled_at || ir.status === 'cancelled') return;
    if (!ir.feedback_token) { const t = Events.token(18); await pool.query('UPDATE interview_rounds SET feedback_token=$1 WHERE id=$2', [t, ir.id]); ir.feedback_token = t; }
    if (sendInvite) await events.enqueue('interview.invite', { interview_id: ir.id }, { dedupeKey: `interview.invite:${ir.id}:${new Date(ir.scheduled_at).getTime()}`, maxAttempts: 3 });
    const remindAt = new Date(new Date(ir.scheduled_at).getTime() - 24 * 3600000);
    await events.cancelJobs(`interview.reminder:${ir.id}`);
    if (remindAt > new Date()) await events.enqueue('interview.reminder', { interview_id: ir.id }, { runAt: remindAt, dedupeKey: `interview.reminder:${ir.id}`, maxAttempts: 2 });
  }

  // ---------- Submission status transitions ----------
  async function applySubmissionStatus(sub, next, { req, source = 'user', note = null, override = false, reason = null } = {}) {
    const to = normalizeSubmissionStatus(next);
    if (!to) { const e = new Error(`Unknown submission status "${next}". Allowed: ${STATUS_IDS.join(', ')}`); e.status = 400; e.code = 'INVALID_STATUS'; throw e; }
    const from = normalizeSubmissionStatus(sub.status) || 'submitted';
    if (from === to && normalizeSubmissionStatus(sub.status) === sub.status) return sub;
    if (from === 'hired' && to !== 'hired' && !override) { const e = new Error('This submission is already hired. Reopen it with an override if the placement fell through.'); e.status = 409; e.code = 'TERMINAL_STATUS'; throw e; }
    if (to === 'hired' && source === 'user' && !override) { const e = new Error('Mark a submission hired by recording the placement (Place), so the placement record exists.'); e.status = 409; e.code = 'USE_PLACEMENT'; throw e; }
    const q = await pool.query('UPDATE submissions SET status=$1, stage_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id::text=$2 RETURNING *', [to, String(sub.id)]);
    const row = q.rows[0];
    await events.record({ type: 'submission.status_changed', entity_type: 'submission', entity_id: sub.id, actor: req && req.user ? `user:${req.user.id}` : source, payload: { from, to, note, override, reason } });
    if (override) await events.record({ type: 'gate.override', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { from, to, reason } });
    if (source !== 'user' && sub.created_by) {
      const cand = await loadCandidate(sub.candidate_id);
      await notify({ user_ids: [sub.created_by], type: 'submission.status', title: `${cand ? cand.name : 'Candidate'}: ${labelFor(to)}`, body: note || `Status moved from ${labelFor(from)} to ${labelFor(to)} (${source}).`, entity_type: 'submission', entity_id: sub.id });
    }
    return row;
  }
  const labelFor = (id) => (SUBMISSION_STATUSES.find((s) => s.id === id) || { label: id }).label;

  /** Placement gate used by POST /api/placements. Returns null when allowed, otherwise an error object. */
  function placementGate(sub, body = {}) {
    const st = normalizeSubmissionStatus(sub.status) || 'submitted';
    if (PLACEMENT_READY.includes(st) || st === 'hired') return null;
    if (body.override) return null;
    return { status: 409, code: 'STAGE_GATE', error: `The submission is at "${labelFor(st)}". Record the accepted offer (or contract) first, or pass override with a reason.`, current_status: st, required: PLACEMENT_READY };
  }
  async function afterPlacement(placement, sub, req) {
    if (sub) {
      const st = normalizeSubmissionStatus(sub.status) || 'submitted';
      if (!PLACEMENT_READY.includes(st) && st !== 'hired') await events.record({ type: 'gate.override', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { gate: 'placement', from: st, reason: (req.body && req.body.override_reason) || null } });
      await events.record({ type: 'submission.status_changed', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { from: st, to: 'hired', placement_id: placement.id } });
    }
    await events.record({ type: 'placement.created', entity_type: 'placement', entity_id: placement.id, actor: actorOf(req), payload: { submission_id: placement.submission_id, candidate_id: placement.candidate_id, job_order_id: placement.job_order_id, fee_amount: placement.fee_amount } });
    for (const h of hooks.afterPlacement) { try { await h(placement); } catch (e) { console.error('⚠️ placement hook:', e.message); } }
  }
  async function onPlacementUpdated(row, prev, req) {
    const changed = ['start_date', 'end_date', 'placement_status', 'bill_rate', 'client_approver_email', 'consultant_email', 'timesheet_cycle'].filter((k) => String(prev[k] ?? '') !== String(row[k] ?? ''));
    if (!changed.length) return;
    await events.record({ type: 'placement.updated', entity_type: 'placement', entity_id: row.id, actor: actorOf(req), payload: Object.fromEntries(changed.map((k) => [k, { from: prev[k], to: row[k] }])) });
    if (changed.includes('end_date') && prev.end_date && row.end_date && new Date(row.end_date) > new Date(prev.end_date)) {
      await pool.query("UPDATE placements SET placement_status=CASE WHEN COALESCE(placement_status,'active')='active' THEN 'extended' ELSE placement_status END, initial_end_date=COALESCE(initial_end_date,$1) WHERE id::text=$2", [prev.end_date, String(row.id)]).catch(() => {});
      await events.record({ type: 'placement.extended', entity_type: 'placement', entity_id: row.id, actor: actorOf(req), payload: { from: prev.end_date, to: row.end_date } });
      await events.resolveOpen('placement.ending', 'placement', row.id, 'extended');
    }
    if (['start_date', 'end_date', 'placement_status', 'timesheet_cycle'].some((k) => changed.includes(k))) for (const h of hooks.afterPlacement) { try { await h(row); } catch (e) { console.error('⚠️ placement hook:', e.message); } }
  }
  const dedupeReview = (table, row) => dedupe.reviewRecord(pool, events, table, row).catch((e) => console.error('⚠️ duplicate review:', e.message));

  // ---------- Authorize Search ----------
  async function onLeadReadyToAuthorize(lead) {
    await events.record({ type: 'lead.ready_to_authorize', entity_type: 'lead', entity_id: lead.id, payload: { job_title: lead.job_title, company: lead.company } });
    await pool.query('INSERT INTO activities (type, title, contact, account, lead_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['Task', `Authorize search: ${lead.job_title || 'role'} for ${lead.end_client || lead.company || 'client'}`, lead.name, lead.end_client || lead.company, String(lead.id), 'pending', days(1), lead.assigned_to || null]).catch(() => {});
    await notifyOwners({ owners: lead.assigned_to ? [lead.assigned_to] : [], type: 'lead.ready_to_authorize', title: `Ready to authorize: ${lead.job_title || 'role'} (${lead.company})`, body: `${lead.name} confirmed interest and every critical detail is on file. Open the lead and click Authorize Search to create the opportunity and job order.`, entity_type: 'lead', entity_id: lead.id, link: `${APP_URL}/?lead=${lead.id}` });
  }

  async function authorizeSearch(lead, body, req) {
    const txnId = body.txn_id || `lead-authorize:${lead.id}`;
    const uid = String(req.user.id);
    const result = await events.transaction(txnId, [
      { name: 'opportunity', run: async () => {
        if (lead.opportunity_id) { const o = await one('SELECT * FROM opportunities WHERE id::text=$1', [String(lead.opportunity_id)]); if (o) return { id: String(o.id), opportunity_no: o.opportunity_no, account_id: o.account_id, name: o.name }; }
        const o = await leadWorkflow.createOpportunityFromLead(pool, lead, { summary: body.note || 'Search authorized by ' + (req.user.email || uid) });
        await pool.query("UPDATE opportunities SET stage='Proposal', probability=60, updated_at=CURRENT_TIMESTAMP WHERE id::text=$1", [String(o.id)]).catch(() => {});
        return { id: String(o.id), opportunity_no: o.opportunity_no, account_id: o.account_id ? String(o.account_id) : null, name: o.name };
      } },
      { name: 'job_order', run: async (ctx) => {
        const existing = await one('SELECT * FROM job_orders WHERE opportunity_id=$1 ORDER BY id LIMIT 1', [ctx.opportunity.id]);
        if (existing) return { id: String(existing.id), title: existing.title, existing: true };
        // Requirements are extracted from the recruiter's own words here, so
        // the job order carries something to match candidates against from the
        // moment it is created. It previously wrote an empty string into
        // required_skills, which left candidate matching with nothing to
        // compare and scored every candidate the same.
        const req = roleRequirements({ title: lead.job_title, description: lead.job_description || '' });
        const row = await insertRow('job_orders', JOB_ORDER_COLS, {
          title: lead.job_title || 'Staffing request', company: lead.end_client || lead.company || '', location: [lead.work_arrangement, lead.job_location].filter(Boolean).join(' - '),
          description: lead.job_description || '', salary_range: lead.rate_or_salary || '', status: 'intake_pending', priority: body.priority || 'High',
          opportunity_id: ctx.opportunity.id, account_id: ctx.opportunity.account_id, lead_id: String(lead.id), intake_status: 'pending', source_of_truth: 'lead_email', created_by: uid,
          required_skills: req.must.join(', '), nice_to_have_skills: req.nice.join(', '),
          work_arrangement: lead.work_arrangement || '', employment_type: lead.employment_type || '',
          source: 'Lead',
        });
        return { id: String(row.id), title: row.title, job_no: row.job_no, existing: false };
      } },
      { name: 'intake_link', run: async (ctx) => {
        const token = Events.token(24);
        const to = body.intake_to || lead.email || null;
        const l = await one('INSERT INTO intake_links (token, job_order_id, opportunity_id, lead_id, account_id, sent_to, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [token, ctx.job_order.id, ctx.opportunity.id, String(lead.id), ctx.opportunity.account_id, to, uid, days(14)]);
        return { id: l.id, token, url: tokenUrl('intake', token), expires_at: l.expires_at, to };
      } },
      { name: 'activities', run: async (ctx) => {
        await pool.query('UPDATE activities SET opportunity_id=$1, account_id=COALESCE(account_id,$2) WHERE lead_id=$3 AND opportunity_id IS NULL', [ctx.opportunity.id, ctx.opportunity.account_id, String(lead.id)]).catch(() => {});
        await pool.query("UPDATE activities SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE lead_id=$1 AND title LIKE 'Authorize search:%' AND status<>'completed'", [String(lead.id)]).catch(() => {});
        await pool.query('INSERT INTO activities (type, title, contact, account, lead_id, opportunity_id, account_id, status, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,$9)',
          ['Task', `Search authorized: ${ctx.job_order.title}`, lead.name, lead.end_client || lead.company, String(lead.id), ctx.opportunity.id, ctx.opportunity.account_id, 'completed', uid]).catch(() => {});
        return true;
      } },
      { name: 'lead', run: async (ctx) => {
        await pool.query("UPDATE leads SET workflow_status='opportunity_created', status=CASE WHEN COALESCE(status,'')='converted' THEN status ELSE 'converted' END, opportunity_id=$1, job_order_id=$2, account_id=COALESCE(account_id,$3), authorized_at=CURRENT_TIMESTAMP, authorized_by=$4, follow_up_due_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id::text=$5", [ctx.opportunity.id, ctx.job_order.id, ctx.opportunity.account_id, uid, String(lead.id)]);
        return true;
      } },
      { name: 'contact', run: async () => { const fresh = await one('SELECT * FROM leads WHERE id::text=$1', [String(lead.id)]); try { await contactsSync.syncContactFromLead(pool, fresh || lead); } catch { /* best effort */ } return true; } },
      { name: 'nda', run: async (ctx) => {
        const acct = await loadAccount(ctx.opportunity.account_id);
        const signed = acct && acct.nda_status === 'signed';
        if (!signed && acct) {
          await events.exception({ kind: 'nda.missing', entity_type: 'account', entity_id: acct.id, message: `No signed NDA on file for ${acct.name}. Send the NDA before sharing candidate details.`, assigned_to: uid });
        }
        return { account_id: acct ? String(acct.id) : null, account_name: acct ? acct.name : null, nda_status: acct ? (acct.nda_status || 'missing') : 'no_account' };
      } },
      { name: 'notify', run: async (ctx) => {
        await notifyOwners({ owners: [lead.assigned_to, uid].filter(Boolean), exclude: uid, type: 'lead.authorized', title: `Search authorized: ${ctx.job_order.title} (${ctx.opportunity.name})`, body: `Opportunity O-${String(ctx.opportunity.opportunity_no || '').padStart(5, '0')} and job order "${ctx.job_order.title}" were created. Client intake link: ${ctx.intake_link.url}`, entity_type: 'job_order', entity_id: ctx.job_order.id, link: `${APP_URL}/?job=${ctx.job_order.id}` });
        return true;
      } },
      { name: 'intake_email', run: async (ctx) => {
        if (!body.send_intake || !ctx.intake_link.to) return 'not sent';
        const job = await events.enqueue('email.send', intakeEmail(ctx.intake_link, { title: ctx.job_order.title, company: lead.end_client || lead.company }, lead, body.message), { dedupeKey: `intake.email:${ctx.intake_link.id}`, maxAttempts: 4 });
        await pool.query('UPDATE intake_links SET sent_at=CURRENT_TIMESTAMP WHERE id=$1', [ctx.intake_link.id]);
        await events.enqueue('intake.reminder', { intake_link_id: ctx.intake_link.id }, { runAt: days(3), dedupeKey: `intake.reminder:${ctx.intake_link.id}` });
        return job ? `queued job ${job.id}` : 'queue failed';
      } },
    ], { actor: `user:${uid}`, entity_type: 'lead', entity_id: lead.id });
    if (!result.replayed) await events.record({ type: 'lead.search_authorized', entity_type: 'lead', entity_id: lead.id, actor: `user:${uid}`, txn_id: txnId, payload: { opportunity_id: result.ctx.opportunity.id, job_order_id: result.ctx.job_order.id } });
    const fresh = await one('SELECT * FROM leads WHERE id::text=$1', [String(lead.id)]);
    const opp = await one('SELECT * FROM opportunities WHERE id::text=$1', [result.ctx.opportunity.id]);
    const job = await loadJobOrder(result.ctx.job_order.id);
    return { ok: true, replayed: result.replayed, txn_id: txnId, lead: fresh, opportunity: opp, job_order: job, intake_link: result.ctx.intake_link, nda: result.ctx.nda, intake_email: result.ctx.intake_email, warnings: result.ctx.nda && result.ctx.nda.nda_status !== 'signed' ? ['No signed NDA on file for this client'] : [] };
  }
  function intakeEmail(link, job, lead, message) {
    const subject = `${COMPANY}: confirm the details for ${job.title}`;
    const html = `<p>Hi ${esc(lead.name || '')},</p>${message ? `<p>${nl2br(message)}</p>` : ''}<p>Thank you for authorizing ${esc(COMPANY)} to start the search for <strong>${esc(job.title)}</strong>${job.company ? ` at ${esc(job.company)}` : ''}. To make sure we present the right candidates, please confirm the requirement details on this short form:</p><p><a href="${esc(link.url)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm job requirements</a></p><p>The link is personal to you and expires in 14 days.</p><p>${esc(COMPANY)}</p>`;
    const text = `Hi ${lead.name || ''},\n\n${message ? message + '\n\n' : ''}Please confirm the requirement details for ${job.title}${job.company ? ` at ${job.company}` : ''}:\n${link.url}\n\nThe link expires in 14 days.\n\n${COMPANY}`;
    return { to: link.to, subject, html, text, entity_type: 'job_order', entity_id: link.job_order_id || null };
  }

  // ---------- Client intake ----------
  async function intakeByToken(token) {
    const l = await one('SELECT * FROM intake_links WHERE token=$1', [String(token)]);
    if (!l) return null;
    if (l.expires_at && new Date(l.expires_at) < new Date() && l.status === 'pending') { await pool.query("UPDATE intake_links SET status='expired' WHERE id=$1", [l.id]); l.status = 'expired'; }
    return l;
  }
  function jobPrefill(job) {
    return job ? { title: job.title, company: job.company, location: job.location, description: job.description, rate: job.salary_range, required_skills: job.required_skills, priority: job.priority, target_fill_date: job.target_fill_date } : null;
  }
  async function applyIntakeToJob(job, data, { req, approvedBy }) {
    const d = data || {};
    const sets = {};
    if (d.title) sets.title = d.title;
    if (d.location || d.work_arrangement) sets.location = [d.work_arrangement, d.location].filter(Boolean).join(' - ');
    if (d.description) sets.description = d.description + (d.interview_process ? `\n\nInterview process: ${d.interview_process}` : '') + (d.duration ? `\nDuration: ${d.duration}` : '') + (d.start_date ? `\nStart: ${d.start_date}` : '') + (d.positions ? `\nOpenings: ${d.positions}` : '') + (d.employment_type ? `\nEmployment type: ${d.employment_type}` : '') + (d.notes ? `\nClient notes: ${d.notes}` : '');
    if (d.required_skills) sets.required_skills = d.required_skills;
    // The client's own description is the best source of requirements there
    // is, so re-read it whenever intake is approved.
    if (d.description) {
      const req = roleRequirements({ title: d.title || job.title, description: d.description, required_skills: d.required_skills || job.required_skills });
      if (req.must.length) sets.required_skills = req.must.join(', ');
      if (req.nice.length) sets.nice_to_have_skills = req.nice.join(', ');
    }
    if (d.work_arrangement) sets.work_arrangement = d.work_arrangement;
    if (d.employment_type) sets.employment_type = d.employment_type;
    if (d.rate) sets.salary_range = d.rate_type ? `${d.rate} ${d.rate_type}` : d.rate;
    if (d.priority) sets.priority = d.priority;
    if (d.target_fill_date) sets.target_fill_date = d.target_fill_date;
    sets.intake_status = 'approved'; sets.source_of_truth = 'client_intake';
    if (String(job.status || '') === 'intake_pending') sets.status = 'open';
    const cols = Object.keys(sets);
    const q = await pool.query(`UPDATE job_orders SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id::text=$${cols.length + 1} RETURNING *`, [...cols.map((c) => sets[c]), String(job.id)]);
    await events.record({ type: 'job_order.intake_approved', entity_type: 'job_order', entity_id: job.id, actor: `user:${approvedBy}`, payload: { fields: cols } });
    await events.resolveOpen('intake.overdue', 'job_order', job.id, 'intake approved');
    await events.resolveOpen('intake.review', 'job_order', job.id, 'intake approved');
    return q.rows[0];
  }

  // ---------- Signature requests ----------
  async function fieldsFor(kind, { account, candidate, submission, job, offer, extra = {} }) {
    const f = { reference: '', ...extra };
    if (account) { f.client_name = f.client_name || account.name; f.reference = `A-${String(account.account_no || account.id).padStart(5, '0')}`; }
    if (job) { f.job_title = f.job_title || job.title; f.location = f.location || job.location; f.rate = f.rate || job.salary_range; f.client_name = f.client_name || job.company; }
    if (candidate) { f.candidate_name = f.candidate_name || candidate.name; f.work_authorization = f.work_authorization || candidate.work_authorization || ''; }
    if (offer) { f.rate = offer.rate || f.rate; f.rate_type = offer.rate_type || f.rate_type; f.start_date = offer.start_date || f.start_date; f.end_date = offer.end_date || f.end_date; f.terms = offer.terms; }
    if (submission) f.reference = `${f.reference ? f.reference + ' / ' : ''}S-${submission.id}`;
    return f;
  }
  async function createSignatureRequest({ kind, entity_type, entity_id, signer_email, signer_name, fields = {}, req }) {
    if (!esign.KINDS[kind]) { const e = new Error('kind must be nda, rtr or sow'); e.status = 400; throw e; }
    let account = null; let candidate = null; let submission = null; let job = null; let offer = null;
    if (entity_type === 'account') account = await loadAccount(entity_id);
    else if (entity_type === 'submission') { submission = await loadSubmission(entity_id); if (submission) { candidate = await loadCandidate(submission.candidate_id); job = await loadJobOrder(submission.job_order_id); account = await accountForJob(job); offer = await one("SELECT * FROM offers WHERE submission_id=$1 AND status IN ('accepted','extended') ORDER BY id DESC LIMIT 1", [String(submission.id)]); } }
    else if (entity_type === 'job_order') { job = await loadJobOrder(entity_id); account = await accountForJob(job); }
    else if (entity_type === 'candidate') candidate = await loadCandidate(entity_id);
    if (!account && !candidate && !submission && !job) { const e = new Error(`${entity_type} ${entity_id} not found`); e.status = 404; throw e; }
    const f = await fieldsFor(kind, { account, candidate, submission, job, offer, extra: fields });
    const email = signer_email || (kind === 'rtr' ? (candidate && candidate.email) : (account && account.billing_contact && /@/.test(account.billing_contact) ? account.billing_contact : null));
    const name = signer_name || (kind === 'rtr' ? (candidate && candidate.name) : (f.client_signer || f.client_name));
    if (!email) { const e = new Error('signer_email is required (no email on file for the signer)'); e.status = 400; e.code = 'SIGNER_EMAIL_REQUIRED'; throw e; }
    const html = esign.buildDocument(kind, { ...f, company_signer: process.env.ESIGN_COUNTERSIGNER_NAME || '' });
    const q = await pool.query('INSERT INTO signature_requests (kind, entity_type, entity_id, account_id, candidate_id, submission_id, signer_name, signer_email, provider, status, document_html, fields, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [kind, entity_type, String(entity_id), account ? String(account.id) : null, candidate ? String(candidate.id) : null, submission ? String(submission.id) : null, name || null, email, esign.providerName(), 'draft', html, JSON.stringify(f), String(req.user.id)]);
    const row = q.rows[0];
    await events.record({ type: 'esign.created', entity_type: 'signature_request', entity_id: row.id, actor: actorOf(req), payload: { kind, entity_type, entity_id, signer_email: email, provider: row.provider } });
    return row;
  }
  async function sendSignatureRequest(row, req) {
    const name = `${esign.KINDS[row.kind].label} - ${(parse(row.fields) || {}).client_name || (parse(row.fields) || {}).candidate_name || ''}`.trim();
    if (esign.isConfigured()) {
      const r = await esign.sendAgreement({ kind: row.kind, name, html: row.document_html, signer_email: row.signer_email, signer_name: row.signer_name });
      const q = await pool.query("UPDATE signature_requests SET provider='acrobat_sign', provider_agreement_id=$1, status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, error=NULL WHERE id=$2 RETURNING *", [r.agreement_id, row.id]);
      await events.enqueue('esign.refresh', { request_id: row.id }, { runAt: new Date(Date.now() + 3600000), dedupeKey: `esign.refresh:${row.id}`, maxAttempts: 8 });
      await events.record({ type: 'esign.sent', entity_type: 'signature_request', entity_id: row.id, actor: actorOf(req), payload: { provider: 'acrobat_sign', agreement_id: r.agreement_id, to: row.signer_email } });
      await applySignatureSideEffects(q.rows[0], 'sent');
      return q.rows[0];
    }
    // Manual mode: email the document for signature and return.
    const subject = `${esign.KINDS[row.kind].label} from ${COMPANY} - please sign and return`;
    const html = `<p>Hi ${esc(row.signer_name || '')},</p><p>Please review the attached ${esc(esign.KINDS[row.kind].label)} below, sign it and reply to this email with the signed copy. Electronic signature service is not enabled yet, so a scanned or typed signature returned by email is accepted.</p><hr/>${row.document_html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')}`;
    const job = await events.enqueue('email.send', { to: row.signer_email, subject, html, text: `Please sign and return the ${esign.KINDS[row.kind].label} from ${COMPANY}.`, entity_type: 'signature_request', entity_id: row.id }, { dedupeKey: `esign.manual:${row.id}`, maxAttempts: 4 });
    const q = await pool.query("UPDATE signature_requests SET provider='manual', status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [row.id]);
    await events.record({ type: 'esign.sent', entity_type: 'signature_request', entity_id: row.id, actor: actorOf(req), payload: { provider: 'manual', to: row.signer_email, job_id: job && job.id } });
    await applySignatureSideEffects(q.rows[0], 'sent');
    return q.rows[0];
  }
  async function applySignatureStatus(row, status, { event = null, actor = 'system', note = null } = {}) {
    if (!esign.STATUSES.includes(status)) return row;
    const stamps = status === 'signed' ? ', signed_at=CURRENT_TIMESTAMP' : status === 'viewed' ? ', viewed_at=COALESCE(viewed_at, CURRENT_TIMESTAMP)' : '';
    const q = await pool.query(`UPDATE signature_requests SET status=$1, last_event=$2, updated_at=CURRENT_TIMESTAMP${stamps} WHERE id=$3 RETURNING *`, [status, event, row.id]);
    const r = q.rows[0];
    await events.record({ type: `esign.${status}`, entity_type: 'signature_request', entity_id: r.id, actor, payload: { kind: r.kind, entity_type: r.entity_type, entity_id: r.entity_id, event, note } });
    await applySignatureSideEffects(r, status, note);
    return r;
  }
  async function applySignatureSideEffects(r, status, note) {
    const K = esign.KINDS[r.kind].short;
    if (r.kind === 'nda' && r.account_id) {
      await pool.query('UPDATE accounts SET nda_status=$1, nda_signed_at=CASE WHEN $1=\'signed\' THEN CURRENT_TIMESTAMP ELSE nda_signed_at END, updated_at=CURRENT_TIMESTAMP WHERE id::text=$2', [status, String(r.account_id)]).catch(() => {});
      if (status === 'signed') await events.resolveOpen('nda.missing', 'account', r.account_id, 'NDA signed');
    }
    if (r.kind === 'rtr' && r.submission_id) await pool.query('UPDATE submissions SET rtr_status=$1, updated_at=CURRENT_TIMESTAMP WHERE id::text=$2', [status, String(r.submission_id)]).catch(() => {});
    if (r.kind === 'sow' && r.submission_id) {
      await pool.query('UPDATE submissions SET contract_status=$1, updated_at=CURRENT_TIMESTAMP WHERE id::text=$2', [status, String(r.submission_id)]).catch(() => {});
      const sub = await loadSubmission(r.submission_id);
      if (sub) {
        const st = normalizeSubmissionStatus(sub.status);
        if (status === 'sent' && ['offer', 'offer_accepted'].includes(st)) await applySubmissionStatus(sub, 'contract_sent', { source: 'esign' });
        if (status === 'signed' && st !== 'hired') await applySubmissionStatus(sub, 'contract_signed', { source: 'esign', note: 'SOW signed. Record the placement.' });
      }
    }
    if (['signed', 'declined', 'expired'].includes(status)) {
      await notifyOwners({ owners: [r.created_by], type: `esign.${status}`, title: `${K} ${status}: ${r.signer_name || r.signer_email}`, body: note || `${esign.KINDS[r.kind].label} was ${status} by ${r.signer_email}.`, entity_type: r.entity_type, entity_id: r.entity_id });
      if (status !== 'signed') await events.exception({ kind: `esign.${status}`, entity_type: 'signature_request', entity_id: r.id, message: `${K} for ${r.signer_email} was ${status}`, assigned_to: r.created_by });
    }
  }

  // ---------- Client review link ----------
  async function latestProfile(submissionId) { return one('SELECT * FROM candidate_profiles WHERE submission_id=$1 AND redacted=TRUE ORDER BY created_at DESC, id DESC LIMIT 1', [submissionId]); }
  async function createClientLink(sub, body, req) {
    const rtr = sub.rtr_status === 'signed';
    if (!rtr && !body.override) { const e = new Error('No signed Right to Represent on file for this candidate and role. Send the RTR first, or pass override with a reason.'); e.status = 409; e.code = 'RTR_REQUIRED'; throw e; }
    if (!rtr) await events.record({ type: 'gate.override', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { gate: 'rtr', reason: body.override_reason || null } });
    // NDA gate: no candidate details go to a client without a signed NDA on the account.
    const gateJob = await loadJobOrder(sub.job_order_id); const gateAcct = await accountForJob(gateJob);
    const ndaOk = !gateAcct || gateAcct.nda_status === 'signed' || process.env.NDA_GATE === 'off';
    if (!ndaOk && !body.override) { const e = new Error(`No signed NDA on file for ${gateAcct.name}. Send the NDA first, or pass override with a reason.`); e.status = 409; e.code = 'NDA_REQUIRED'; e.account_id = String(gateAcct.id); throw e; }
    if (!ndaOk) await events.record({ type: 'gate.override', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { gate: 'nda', account_id: String(gateAcct.id), reason: body.override_reason || null } });
    let profile = await latestProfile(sub.id);
    if (!profile) {
      if (!isProfileAIConfigured()) { const e = new Error('Generate the redacted candidate profile first (AI is not configured to generate it automatically).'); e.status = 409; e.code = 'PROFILE_REQUIRED'; throw e; }
      const cand = await loadCandidate(sub.candidate_id); const job = await loadJobOrder(sub.job_order_id);
      const built = await buildCandidateProfile({ candidate: cand, jobOrder: job, redacted: true });
      profile = (await pool.query('INSERT INTO candidate_profiles (submission_id, candidate_id, job_order_id, redacted, label, content, markdown, model) VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7) RETURNING *', [sub.id, cand.id, job ? job.id : null, built.label, JSON.stringify(built.profile), built.markdown, built.model])).rows[0];
    }
    const token = Events.token(24);
    const link = await one('INSERT INTO client_links (token, submission_id, job_order_id, candidate_id, profile_id, sent_to, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [token, String(sub.id), sub.job_order_id == null ? null : String(sub.job_order_id), String(sub.candidate_id), String(profile.id), body.to || null, String(req.user.id), days(body.expires_days || 21)]);
    const url = tokenUrl('client', token);
    const updated = await applySubmissionStatus(sub, 'client_review', { req, note: `Sent to ${body.to || 'client'} via review link` });
    await pool.query('UPDATE submissions SET submitted_to=COALESCE($1, submitted_to) WHERE id::text=$2', [body.to || null, String(sub.id)]).catch(() => {});
    await events.record({ type: 'submission.sent_to_client', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { to: body.to || null, link_id: link.id, profile_id: profile.id } });
    let emailed = false;
    if (body.to && body.send !== false) {
      const job = await loadJobOrder(sub.job_order_id);
      const subject = body.subject || `Candidate for ${job ? job.title : 'your opening'}: ${profile.label}`;
      const html = `${body.message ? `<p>${nl2br(body.message)}</p>` : `<p>Hello,</p><p>Please find a candidate profile for <strong>${esc(job ? job.title : 'your opening')}</strong>.</p>`}<p><a href="${esc(url)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Review candidate and respond</a></p><p>From the page you can request an interview, ask for more information, put the candidate on hold, select them for an offer, or decline. The link is personal to you and expires in ${body.expires_days || 21} days.</p><p>${esc(COMPANY)}</p>`;
      const text = `${body.message || `Please review a candidate profile for ${job ? job.title : 'your opening'}.`}\n\nReview and respond: ${url}\n\n${COMPANY}`;
      const j = await events.enqueue('email.send', { to: body.to, subject, html, text, entity_type: 'submission', entity_id: sub.id }, { dedupeKey: `client.email:${link.id}`, maxAttempts: 4 });
      emailed = !!j;
      await pool.query('UPDATE client_links SET sent_at=CURRENT_TIMESTAMP WHERE id=$1', [link.id]);
      await events.enqueue('client.reminder', { client_link_id: link.id }, { runAt: days(3), dedupeKey: `client.reminder:${link.id}` });
    }
    await pool.query('INSERT INTO activities (type, title, contact, candidate_id, account_id, status, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7)', ['Email', `Candidate profile sent to client: ${profile.label}`, body.to || null, String(sub.candidate_id), null, 'completed', String(req.user.id)]).catch(() => {});
    return { link: { id: link.id, token, url, expires_at: link.expires_at, to: body.to || null }, emailed, profile_id: profile.id, submission: updated };
  }
  async function clientLinkByToken(token) {
    const l = await one('SELECT * FROM client_links WHERE token=$1', [String(token)]);
    if (!l) return null;
    if (l.expires_at && new Date(l.expires_at) < new Date() && l.status === 'active') { await pool.query("UPDATE client_links SET status='expired' WHERE id=$1", [l.id]); l.status = 'expired'; }
    return l;
  }
  async function clientView(l, { markViewed = true } = {}) {
    const sub = await loadSubmission(l.submission_id);
    const job = sub ? await loadJobOrder(sub.job_order_id) : null;
    const profile = await one('SELECT * FROM candidate_profiles WHERE id::text=$1', [String(l.profile_id)]);
    if (markViewed && !l.first_viewed_at && l.status === 'active') {
      await pool.query('UPDATE client_links SET first_viewed_at=CURRENT_TIMESTAMP WHERE id=$1', [l.id]);
      await events.record({ type: 'client.viewed', entity_type: 'submission', entity_id: l.submission_id, actor: `client:${l.sent_to || 'link'}`, payload: { link_id: l.id } });
      await notifyOwners({ owners: [l.created_by], type: 'client.viewed', title: `Client opened the profile: ${profile ? profile.label : 'candidate'}`, body: `${l.sent_to || 'The client'} opened the candidate profile for ${job ? job.title : 'the role'}.`, entity_type: 'submission', entity_id: l.submission_id, email: false });
    }
    const status = sub ? normalizeSubmissionStatus(sub.status) : null;
    const actions = l.status !== 'active' || !sub || ['declined', 'withdrawn', 'hired'].includes(status) ? [] : Object.keys(CLIENT_ACTIONS);
    return { company: COMPANY, candidate_label: profile ? profile.label : 'Candidate', job_title: job ? job.title : null, client_company: job ? job.company : null, profile_html: profile ? markdownToHtml(profile.markdown) : '<p>The profile is no longer available.</p>', status: l.status, submission_status: status, last_action: l.last_action, last_action_at: l.last_action_at, expires_at: l.expires_at, actions: actions.map((a) => ({ id: a, label: CLIENT_ACTIONS[a] })) };
  }
  async function clientAct(l, body) {
    const action = String(body.action || '');
    if (!CLIENT_ACTIONS[action]) { const e = new Error(`action must be one of ${Object.keys(CLIENT_ACTIONS).join(', ')}`); e.status = 400; throw e; }
    if (l.status !== 'active') { const e = new Error('This link is no longer active'); e.status = 410; throw e; }
    const sub = await loadSubmission(l.submission_id);
    if (!sub) { const e = new Error('Submission no longer exists'); e.status = 410; throw e; }
    const cand = await loadCandidate(sub.candidate_id); const job = await loadJobOrder(sub.job_order_id);
    const actor = `client:${body.email || l.sent_to || 'link'}`;
    await pool.query('INSERT INTO client_actions (client_link_id, submission_id, action, note, availability, actor_name, actor_email) VALUES ($1,$2,$3,$4,$5,$6,$7)', [l.id, String(sub.id), action, body.note || null, body.availability || null, body.name || null, body.email || l.sent_to || null]);
    await pool.query('UPDATE client_links SET last_action=$1, last_action_at=CURRENT_TIMESTAMP, status=$2 WHERE id=$3', [action, action === 'decline' ? 'used' : 'active', l.id]);
    await events.record({ type: 'client.action', entity_type: 'submission', entity_id: sub.id, actor, payload: { action, note: body.note || null, availability: body.availability || null, link_id: l.id } });
    await events.cancelJobs(`client.reminder:${l.id}`);
    const label = cand ? cand.name : 'Candidate';
    let result = {};
    if (action === 'request_interview') {
      const n = await one('SELECT COALESCE(MAX(round),0)+1 AS r FROM interview_rounds WHERE submission_id=$1', [String(sub.id)]);
      const ir = await one('INSERT INTO interview_rounds (submission_id, round, type, status, feedback, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [String(sub.id), Number(n.r), body.interview_type || 'Client interview', 'requested', [body.availability ? `Client availability: ${body.availability}` : '', body.note || ''].filter(Boolean).join('\n') || null, 'client']);
      await applySubmissionStatus(sub, 'interview_requested', { source: 'client', note: `Client requested an interview (round ${ir.round})${body.availability ? `: ${body.availability}` : ''}` });
      await pool.query('INSERT INTO activities (type, title, contact, candidate_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['Task', `Schedule interview round ${ir.round}: ${label} for ${job ? job.title : 'role'}`, l.sent_to || null, String(sub.candidate_id), 'pending', days(1), sub.created_by || null]).catch(() => {});
      result = { interview: ir };
    } else if (action === 'decline') {
      await applySubmissionStatus(sub, 'declined', { source: 'client', note: body.note ? `Client declined: ${body.note}` : 'Client declined' });
    } else if (action === 'more_info') {
      await events.exception({ kind: 'client.more_info', entity_type: 'submission', entity_id: sub.id, message: `${l.sent_to || 'Client'} asked for more information on ${label}: ${body.note || '(no detail given)'}`, assigned_to: sub.created_by });
      await notifyOwners({ owners: [sub.created_by], type: 'client.more_info', title: `Client wants more information: ${label}`, body: body.note || 'No detail given.', entity_type: 'submission', entity_id: sub.id });
    } else if (action === 'hold') {
      await applySubmissionStatus(sub, 'on_hold', { source: 'client', note: body.note ? `Client put on hold: ${body.note}` : 'Client put the candidate on hold' });
    } else if (action === 'select') {
      const offer = await one("INSERT INTO offers (submission_id, candidate_id, job_order_id, rate, status, terms, created_by) VALUES ($1,$2,$3,$4,'draft',$5,'client') RETURNING *", [String(sub.id), String(sub.candidate_id), sub.job_order_id == null ? null : String(sub.job_order_id), job ? job.salary_range : null, body.note || null]);
      await applySubmissionStatus(sub, 'offer', { source: 'client', note: 'Client selected the candidate. Prepare the offer.' });
      await pool.query('INSERT INTO activities (type, title, contact, candidate_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['Task', `Prepare offer: ${label} for ${job ? job.title : 'role'}`, l.sent_to || null, String(sub.candidate_id), 'pending', days(1), sub.created_by || null]).catch(() => {});
      result = { offer };
    }
    return { ok: true, action, ...result };
  }

  // ---------- Offers ----------
  async function setOfferStatus(offer, status, { req, note } = {}) {
    const allowed = ['draft', 'extended', 'accepted', 'declined', 'withdrawn'];
    if (!allowed.includes(status)) { const e = new Error(`status must be one of ${allowed.join(', ')}`); e.status = 400; throw e; }
    const stamps = status === 'extended' ? ', extended_at=CURRENT_TIMESTAMP' : ['accepted', 'declined'].includes(status) ? ', responded_at=CURRENT_TIMESTAMP' : '';
    const q = await pool.query(`UPDATE offers SET status=$1, updated_at=CURRENT_TIMESTAMP${stamps} WHERE id=$2 RETURNING *`, [status, offer.id]);
    const o = q.rows[0];
    await events.record({ type: `offer.${status}`, entity_type: 'submission', entity_id: o.submission_id, actor: actorOf(req), payload: { offer_id: o.id, rate: o.rate, start_date: o.start_date, note } });
    const sub = await loadSubmission(o.submission_id);
    if (sub) {
      if (status === 'extended') await applySubmissionStatus(sub, 'offer', { req, source: 'offer', note: 'Offer extended' });
      if (status === 'accepted') {
        await applySubmissionStatus(sub, 'offer_accepted', { req, source: 'offer', note: 'Offer accepted. Send the SOW / contract, then record the placement.' });
        const cand = await loadCandidate(sub.candidate_id); const job = await loadJobOrder(sub.job_order_id);
        await pool.query('INSERT INTO activities (type, title, contact, candidate_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['Task', `Send SOW / contract: ${cand ? cand.name : 'candidate'} for ${job ? job.title : 'role'}`, null, String(sub.candidate_id), 'pending', days(1), sub.created_by || null]).catch(() => {});
      }
      if (status === 'declined') await applySubmissionStatus(sub, 'on_hold', { req, source: 'offer', note: note ? `Offer declined: ${note}` : 'Offer declined by candidate' });
      if (status === 'withdrawn') await applySubmissionStatus(sub, 'on_hold', { req, source: 'offer', note: note ? `Offer withdrawn: ${note}` : 'Offer withdrawn' });
    }
    return o;
  }

  // ================= ROUTES =================
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code, txn_id: err.txn_id, account_id: err.account_id }); } };
  const publicHits = new Map();
  const memThrottle = (key, limit) => { const now = Date.now(); const h = publicHits.get(key) || { n: 0, at: now }; if (now - h.at > 3600000) { h.n = 0; h.at = now; } h.n += 1; publicHits.set(key, h); return h.n <= limit; };
  // Public-link throttle persisted in rate_limits (survives restarts and multiple instances); memory fallback.
  const throttle = async (key, limit = 60) => {
    try {
      const now = new Date();
      const cur = await one('SELECT * FROM rate_limits WHERE key=$1', [key]);
      if (!cur) { await pool.query('INSERT INTO rate_limits (key, window_start, count) VALUES ($1,$2,1)', [key, now]); return true; }
      if (now.getTime() - new Date(cur.window_start).getTime() > 3600000) { await pool.query('UPDATE rate_limits SET window_start=$1, count=1 WHERE key=$2', [now, key]); return true; }
      await pool.query('UPDATE rate_limits SET count=count+1 WHERE key=$1', [key]);
      return Number(cur.count) + 1 <= limit;
    } catch { return memThrottle(key, limit); }
  };

  // -- Authorize Search --
  app.post('/api/leads/:id/authorize-search', authenticateToken, wrap(async (req, res) => {
    const lead = await one('SELECT * FROM leads WHERE id::text=$1', [String(req.params.id)]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const body = req.body || {};
    const txn = await one('SELECT status FROM transactions WHERE txn_id=$1', [body.txn_id || `lead-authorize:${lead.id}`]).catch(() => null);
    if (lead.workflow_status === 'opportunity_created' && lead.job_order_id && !(txn && txn.status !== 'done')) return res.status(409).json({ code: 'ALREADY_AUTHORIZED', error: 'This lead has already been authorized', opportunity_id: lead.opportunity_id, job_order_id: lead.job_order_id });
    if (['declined', 'closed_no_response'].includes(lead.workflow_status) && !body.force) return res.status(409).json({ code: 'LEAD_CLOSED', error: `This lead is ${lead.workflow_status.replace(/_/g, ' ')}. Pass force to authorize anyway.` });
    res.status(201).json(await authorizeSearch(lead, body, req));
  }));
  app.get('/api/leads/:id/authorize-search', authenticateToken, wrap(async (req, res) => {
    const lead = await one('SELECT * FROM leads WHERE id::text=$1', [String(req.params.id)]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const missing = leadWorkflow.missingInfo(lead);
    const acct = lead.account_id ? await loadAccount(lead.account_id) : (lead.end_client || lead.company ? await one('SELECT * FROM accounts WHERE LOWER(name)=LOWER($1) ORDER BY id LIMIT 1', [lead.end_client || lead.company]) : null);
    const txn = await one('SELECT * FROM transactions WHERE txn_id=$1', [`lead-authorize:${lead.id}`]).catch(() => null);
    res.json({ lead_id: lead.id, workflow_status: lead.workflow_status, can_authorize: !(lead.workflow_status === 'opportunity_created' && lead.job_order_id), missing: missing.map((m) => m.key), will_create: { account: acct ? `existing: ${acct.name}` : `new: ${lead.end_client || lead.company || '(unnamed)'}`, opportunity: lead.opportunity_id ? 'existing' : `${lead.end_client || lead.company} - ${lead.job_title || 'Staffing request'}`, job_order: lead.job_title || 'Staffing request', intake_link: `sent to ${lead.email || 'the recruiter'} if requested` }, nda_status: acct ? (acct.nda_status || 'missing') : 'no_account', transaction: txn ? { status: txn.status, steps: Object.keys(parse(txn.steps) || {}) } : null });
  }));

  // -- Client intake (public) --
  app.get('/api/intake/:token', wrap(async (req, res) => {
    if (!(await throttle(`intake:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const l = await intakeByToken(req.params.token);
    if (!l) return res.status(404).json({ error: 'This intake link is not valid' });
    const job = await loadJobOrder(l.job_order_id);
    const lead = l.lead_id ? await one('SELECT name, company, end_client FROM leads WHERE id::text=$1', [String(l.lead_id)]) : null;
    res.json({ company: COMPANY, status: l.status, expires_at: l.expires_at, contact_name: lead ? lead.name : null, client_company: job ? job.company : null, job: jobPrefill(job), submitted: parse(l.submitted_data), fields: INTAKE_FIELDS });
  }));
  app.post('/api/intake/:token', wrap(async (req, res) => {
    if (!(await throttle(`intake:${req.ip}`, 30))) return res.status(429).json({ error: 'Too many requests' });
    const l = await intakeByToken(req.params.token);
    if (!l) return res.status(404).json({ error: 'This intake link is not valid' });
    if (l.status === 'expired') return res.status(410).json({ error: 'This intake link has expired. Ask your contact at ' + COMPANY + ' for a new one.' });
    if (l.status === 'approved') return res.status(409).json({ error: 'These requirements were already confirmed. Contact ' + COMPANY + ' to change them.' });
    const data = {}; for (const k of INTAKE_FIELDS) if (req.body && req.body[k] != null && String(req.body[k]).trim() !== '') data[k] = String(req.body[k]).slice(0, 8000);
    if (!data.title || !data.description) return res.status(400).json({ error: 'Job title and description are required' });
    await pool.query("UPDATE intake_links SET status='submitted', submitted_data=$1, submitted_by=$2, submitted_at=CURRENT_TIMESTAMP WHERE id=$3", [JSON.stringify(data), data.submitted_by_email || data.submitted_by_name || null, l.id]);
    await pool.query("UPDATE job_orders SET intake_status='submitted', intake_data=$1, updated_at=CURRENT_TIMESTAMP WHERE id::text=$2", [JSON.stringify(data), String(l.job_order_id)]).catch(() => {});
    await events.record({ type: 'job_order.intake_submitted', entity_type: 'job_order', entity_id: l.job_order_id, actor: `client:${data.submitted_by_email || 'link'}`, payload: { fields: Object.keys(data) } });
    await events.cancelJobs(`intake.reminder:${l.id}`);
    await events.resolveOpen('intake.overdue', 'job_order', l.job_order_id, 'intake submitted');
    await events.exception({ kind: 'intake.review', entity_type: 'job_order', entity_id: l.job_order_id, message: `Client intake submitted for "${data.title}". Review and approve it to make it the job order of record.`, assigned_to: l.created_by });
    await notifyOwners({ owners: [l.created_by], type: 'intake.submitted', title: `Client intake received: ${data.title}`, body: `${data.submitted_by_name || data.submitted_by_email || 'The client'} confirmed the requirements. Review and approve them on the job order.`, entity_type: 'job_order', entity_id: l.job_order_id, link: `${APP_URL}/?job=${l.job_order_id}` });
    res.json({ ok: true, message: `Thank you. ${COMPANY} will review the details and start the search.` });
  }));
  app.get('/api/job-orders/:id/intake', authenticateToken, wrap(async (req, res) => {
    const job = await loadJobOrder(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const links = (await pool.query('SELECT * FROM intake_links WHERE job_order_id=$1 ORDER BY id DESC', [String(job.id)])).rows;
    res.json({ job_order_id: job.id, intake_status: job.intake_status || 'none', source_of_truth: job.source_of_truth || 'recruiter', current: jobPrefill(job), submitted: parse(job.intake_data), links: links.map((l) => ({ id: l.id, url: tokenUrl('intake', l.token), status: l.status, sent_to: l.sent_to, sent_at: l.sent_at, submitted_at: l.submitted_at, expires_at: l.expires_at })) });
  }));
  app.post('/api/job-orders/:id/intake/link', authenticateToken, wrap(async (req, res) => {
    const job = await loadJobOrder(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const b = req.body || {};
    await pool.query("UPDATE intake_links SET status='expired' WHERE job_order_id=$1 AND status='pending'", [String(job.id)]);
    const token = Events.token(24);
    const l = await one('INSERT INTO intake_links (token, job_order_id, opportunity_id, lead_id, account_id, sent_to, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [token, String(job.id), job.opportunity_id || null, job.lead_id || null, job.account_id || null, b.to || null, String(req.user.id), days(14)]);
    const link = { id: l.id, token, url: tokenUrl('intake', token), expires_at: l.expires_at, to: b.to || null, job_order_id: String(job.id) };
    await pool.query("UPDATE job_orders SET intake_status=CASE WHEN intake_status IN ('approved') THEN intake_status ELSE 'pending' END WHERE id::text=$1", [String(job.id)]).catch(() => {});
    await events.record({ type: 'job_order.intake_link_created', entity_type: 'job_order', entity_id: job.id, actor: actorOf(req), payload: { to: b.to || null } });
    let emailed = false;
    if (b.to && b.send !== false) {
      const lead = job.lead_id ? await one('SELECT * FROM leads WHERE id::text=$1', [String(job.lead_id)]) : { name: b.name || '', email: b.to };
      const j = await events.enqueue('email.send', intakeEmail(link, job, lead || { name: '' }, b.message), { dedupeKey: `intake.email:${l.id}`, maxAttempts: 4 });
      emailed = !!j;
      await pool.query('UPDATE intake_links SET sent_at=CURRENT_TIMESTAMP WHERE id=$1', [l.id]);
      await events.enqueue('intake.reminder', { intake_link_id: l.id }, { runAt: days(3), dedupeKey: `intake.reminder:${l.id}` });
    }
    res.status(201).json({ link, emailed });
  }));
  app.post('/api/job-orders/:id/intake/approve', authenticateToken, wrap(async (req, res) => {
    const job = await loadJobOrder(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const data = { ...(parse(job.intake_data) || {}), ...((req.body && req.body.fields) || {}) };
    if (!Object.keys(data).length) return res.status(409).json({ error: 'Nothing submitted yet on the intake link', code: 'NO_INTAKE' });
    const row = await applyIntakeToJob(job, data, { req, approvedBy: req.user.id });
    await pool.query("UPDATE intake_links SET status='approved', approved_at=CURRENT_TIMESTAMP, approved_by=$1 WHERE job_order_id=$2 AND status='submitted'", [String(req.user.id), String(job.id)]);
    if (hooks.intakeApproved) { try { await hooks.intakeApproved(row, req); } catch (e) { console.error('⚠️ intake hook:', e.message); } }
    res.json({ ok: true, job_order: row });
  }));
  app.post('/api/job-orders/:id/intake/skip', authenticateToken, wrap(async (req, res) => {
    const job = await loadJobOrder(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const q = await pool.query("UPDATE job_orders SET intake_status='skipped', source_of_truth='recruiter', status=CASE WHEN status='intake_pending' THEN 'open' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id::text=$1 RETURNING *", [String(job.id)]);
    await pool.query("UPDATE intake_links SET status='expired' WHERE job_order_id=$1 AND status='pending'", [String(job.id)]);
    await events.record({ type: 'job_order.intake_skipped', entity_type: 'job_order', entity_id: job.id, actor: actorOf(req), payload: { reason: (req.body && req.body.reason) || null } });
    await events.resolveOpen('intake.overdue', 'job_order', job.id, 'intake skipped');
    await events.resolveOpen('intake.review', 'job_order', job.id, 'intake skipped');
    res.json({ ok: true, job_order: q.rows[0] });
  }));

  // -- Submission statuses / client link / timeline --
  app.get('/api/submission-statuses', authenticateToken, (req, res) => res.json({ statuses: SUBMISSION_STATUSES, client_actions: CLIENT_ACTIONS, placement_ready: PLACEMENT_READY }));
  app.post('/api/submissions/:id/status', authenticateToken, wrap(async (req, res) => {
    const sub = await loadSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const b = req.body || {};
    res.json(await applySubmissionStatus(sub, b.status, { req, note: b.note, override: !!b.override, reason: b.override_reason }));
  }));
  app.post('/api/submissions/:id/client-link', authenticateToken, wrap(async (req, res) => {
    const sub = await loadSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    res.status(201).json(await createClientLink(sub, req.body || {}, req));
  }));
  app.get('/api/submissions/:id/timeline', authenticateToken, wrap(async (req, res) => {
    const sub = await loadSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const id = String(sub.id);
    const [links, actions, interviews, offers, signatures, evs] = await Promise.all([
      pool.query('SELECT id, sent_to, status, sent_at, first_viewed_at, last_action, last_action_at, expires_at, token FROM client_links WHERE submission_id=$1 ORDER BY id DESC', [id]),
      pool.query('SELECT * FROM client_actions WHERE submission_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM interview_rounds WHERE submission_id=$1 ORDER BY round, id', [id]),
      pool.query('SELECT * FROM offers WHERE submission_id=$1 ORDER BY id', [id]),
      pool.query('SELECT id, kind, status, signer_name, signer_email, provider, sent_at, signed_at, created_at FROM signature_requests WHERE submission_id=$1 ORDER BY id', [id]),
      pool.query("SELECT * FROM events WHERE entity_type='submission' AND entity_id=$1 ORDER BY id DESC LIMIT 100", [id]),
    ]);
    res.json({ submission: { ...sub, status: normalizeSubmissionStatus(sub.status) || sub.status }, client_links: links.rows.map((l) => ({ ...l, url: tokenUrl('client', l.token), token: undefined })), client_actions: actions.rows, interviews: interviews.rows, offers: offers.rows, signatures: signatures.rows, events: evs.rows.map((e) => ({ ...e, payload: parse(e.payload) })) });
  }));

  // -- Client review (public) --
  app.get('/api/client/:token', wrap(async (req, res) => {
    if (!(await throttle(`client:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const l = await clientLinkByToken(req.params.token);
    if (!l) return res.status(404).json({ error: 'This review link is not valid' });
    res.json(await clientView(l));
  }));
  app.post('/api/client/:token/action', wrap(async (req, res) => {
    if (!(await throttle(`client:${req.ip}`, 30))) return res.status(429).json({ error: 'Too many requests' });
    const l = await clientLinkByToken(req.params.token);
    if (!l) return res.status(404).json({ error: 'This review link is not valid' });
    if (l.status === 'expired') return res.status(410).json({ error: 'This review link has expired. Contact ' + COMPANY + ' for a new one.' });
    res.json(await clientAct(l, req.body || {}));
  }));

  // -- Interviews --
  app.get('/api/submissions/:id/interviews', authenticateToken, wrap(async (req, res) => res.json((await pool.query('SELECT * FROM interview_rounds WHERE submission_id=$1 ORDER BY round, id', [String(req.params.id)])).rows)));
  app.post('/api/submissions/:id/interviews', authenticateToken, wrap(async (req, res) => {
    const sub = await loadSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const b = req.body || {};
    const n = await one('SELECT COALESCE(MAX(round),0)+1 AS r FROM interview_rounds WHERE submission_id=$1', [String(sub.id)]);
    const ir = await one('INSERT INTO interview_rounds (submission_id, round, type, scheduled_at, interviewer, interviewer_email, location, duration_minutes, status, feedback, created_by, feedback_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [String(sub.id), b.round || Number(n.r), b.type || 'Interview', b.scheduled_at ? new Date(b.scheduled_at) : null, b.interviewer || null, b.interviewer_email || null, b.location || null, b.duration_minutes ? Number(b.duration_minutes) : null, b.scheduled_at ? 'scheduled' : 'requested', b.feedback || null, String(req.user.id), Events.token(18)]);
    await events.record({ type: 'interview.created', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { round: ir.round, type: ir.type, scheduled_at: ir.scheduled_at } });
    if (b.scheduled_at) await scheduleInterviewComms(ir, { sendInvite: b.send_invite !== false });
    const st = normalizeSubmissionStatus(sub.status);
    if (!OFFER_OR_LATER.includes(st)) await applySubmissionStatus(sub, b.scheduled_at ? 'interviewing' : 'interview_requested', { req, note: `Interview round ${ir.round} ${b.scheduled_at ? 'scheduled' : 'added'}` });
    if (b.scheduled_at) await pool.query('INSERT INTO activities (type, title, contact, candidate_id, status, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['Meeting', `Interview round ${ir.round} (${ir.type})`, b.interviewer || null, String(sub.candidate_id), 'pending', ir.scheduled_at, String(req.user.id)]).catch(() => {});
    res.status(201).json(ir);
  }));
  async function updateInterview(ir, b, { req = null, actor = null } = {}) {
    const sets = {};
    for (const k of ['type', 'interviewer', 'interviewer_email', 'location', 'feedback', 'status', 'outcome', 'rating', 'recommendation']) if (b[k] !== undefined) sets[k] = b[k];
    if (b.duration_minutes !== undefined) sets.duration_minutes = b.duration_minutes ? Number(b.duration_minutes) : null;
    if (b.scheduled_at !== undefined) { sets.scheduled_at = b.scheduled_at ? new Date(b.scheduled_at) : null; if (b.scheduled_at && !b.status && ir.status === 'requested') sets.status = 'scheduled'; }
    if (b.outcome && !b.status) sets.status = 'completed';
    if (sets.status && !['requested', 'scheduled', 'completed', 'cancelled'].includes(sets.status)) { const e = new Error('status must be requested, scheduled, completed or cancelled'); e.status = 400; throw e; }
    if (sets.outcome && !['advance', 'reject', 'offer', 'pending'].includes(sets.outcome)) { const e = new Error('outcome must be advance, reject, offer or pending'); e.status = 400; throw e; }
    const cols = Object.keys(sets);
    if (!cols.length) return ir;
    const q = await pool.query(`UPDATE interview_rounds SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((c) => sets[c]), ir.id]);
    const row = q.rows[0];
    await events.record({ type: 'interview.updated', entity_type: 'submission', entity_id: ir.submission_id, actor: actor || actorOf(req), payload: { round: ir.round, ...sets } });
    const rescheduled = sets.scheduled_at && (!ir.scheduled_at || new Date(ir.scheduled_at).getTime() !== new Date(sets.scheduled_at).getTime());
    if (row.scheduled_at && row.status === 'scheduled' && (rescheduled || (sets.interviewer_email && !ir.interviewer_email))) await scheduleInterviewComms(row, { sendInvite: b.send_invite !== false });
    if (sets.status === 'cancelled') await events.cancelJobs(`interview.reminder:${ir.id}`);
    const sub = await loadSubmission(ir.submission_id);
    if (sub) {
      const st = normalizeSubmissionStatus(sub.status);
      if (sets.status === 'scheduled' && st === 'interview_requested') await applySubmissionStatus(sub, 'interviewing', { req, note: `Interview round ${ir.round} scheduled` });
      if (sets.outcome === 'reject') await applySubmissionStatus(sub, 'declined', { req, note: `Rejected after interview round ${ir.round}${b.feedback ? `: ${b.feedback}` : ''}` });
      if (sets.outcome === 'offer') {
        const cand = await loadCandidate(sub.candidate_id); const job = await loadJobOrder(sub.job_order_id);
        await one("INSERT INTO offers (submission_id, candidate_id, job_order_id, rate, status, created_by) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *", [String(sub.id), String(sub.candidate_id), sub.job_order_id == null ? null : String(sub.job_order_id), job ? job.salary_range : null, String(req.user.id)]);
        if (!OFFER_OR_LATER.includes(st)) await applySubmissionStatus(sub, 'offer', { req, note: `Selected for offer after interview round ${ir.round}` });
        await notifyOwners({ owners: [sub.created_by], exclude: req.user.id, type: 'offer.prepare', title: `Prepare offer: ${cand ? cand.name : 'candidate'}`, body: `Interview round ${ir.round} outcome: offer. A draft offer was created.`, entity_type: 'submission', entity_id: sub.id });
      }
      if (sets.outcome === 'advance') await notifyOwners({ owners: [sub.created_by], exclude: req ? req.user.id : null, type: 'interview.advance', title: `Advance to next round`, body: `Interview round ${ir.round} passed. Schedule the next round or prepare an offer.`, entity_type: 'submission', entity_id: sub.id, email: false });
    }
    return row;
  }
  app.put('/api/interviews/:id', authenticateToken, wrap(async (req, res) => {
    const ir = await one('SELECT * FROM interview_rounds WHERE id=$1', [req.params.id]);
    if (!ir) return res.status(404).json({ error: 'Interview not found' });
    res.json(await updateInterview(ir, req.body || {}, { req }));
  }));
  // Interviewer feedback (public link from the invite email).
  app.get('/api/feedback/:token', wrap(async (req, res) => {
    if (!(await throttle(`feedback:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const ir = await one('SELECT * FROM interview_rounds WHERE feedback_token=$1', [String(req.params.token)]);
    if (!ir) return res.status(404).json({ error: 'This feedback link is not valid' });
    const sub = await loadSubmission(ir.submission_id); const cand = sub ? await loadCandidate(sub.candidate_id) : null; const job = sub ? await loadJobOrder(sub.job_order_id) : null;
    res.json({ company: COMPANY, candidate: cand ? cand.name : 'Candidate', job_title: job ? job.title : null, round: ir.round, type: ir.type, scheduled_at: ir.scheduled_at, interviewer: ir.interviewer, submitted: !!ir.feedback_submitted_at, rating: ir.rating, recommendation: ir.recommendation });
  }));
  app.post('/api/feedback/:token', wrap(async (req, res) => {
    if (!(await throttle(`feedback:${req.ip}`, 30))) return res.status(429).json({ error: 'Too many requests' });
    const ir = await one('SELECT * FROM interview_rounds WHERE feedback_token=$1', [String(req.params.token)]);
    if (!ir) return res.status(404).json({ error: 'This feedback link is not valid' });
    if (ir.feedback_submitted_at) return res.status(409).json({ error: 'Feedback was already submitted for this round. Contact ' + COMPANY + ' to change it.' });
    const b = req.body || {};
    const rec = ['advance', 'reject', 'offer', 'undecided'].includes(b.recommendation) ? b.recommendation : 'undecided';
    const rating = b.rating != null ? Math.max(1, Math.min(5, Number(b.rating))) : null;
    const feedback = [b.name ? `Interviewer: ${b.name}` : '', rating ? `Rating: ${rating}/5` : '', `Recommendation: ${rec}`, b.comments || ''].filter(Boolean).join('\n');
    const row = await updateInterview(ir, { feedback, rating, recommendation: rec, status: 'completed', ...(rec !== 'undecided' ? { outcome: rec } : {}) }, { actor: `interviewer:${b.name || ir.interviewer_email || 'link'}` });
    await pool.query('UPDATE interview_rounds SET feedback_submitted_at=CURRENT_TIMESTAMP WHERE id=$1', [ir.id]);
    const sub = await loadSubmission(ir.submission_id); const cand = sub ? await loadCandidate(sub.candidate_id) : null;
    if (sub) await notifyOwners({ owners: [sub.created_by], type: 'interview.feedback', title: `Interview feedback: ${cand ? cand.name : 'candidate'} round ${ir.round} (${rec}${rating ? `, ${rating}/5` : ''})`, body: b.comments || 'No comments.', entity_type: 'submission', entity_id: sub.id });
    res.json({ ok: true, recommendation: rec, rating, status: row.status });
  }));

  // -- Offers --
  app.get('/api/submissions/:id/offers', authenticateToken, wrap(async (req, res) => res.json((await pool.query('SELECT * FROM offers WHERE submission_id=$1 ORDER BY id', [String(req.params.id)])).rows)));
  app.post('/api/submissions/:id/offers', authenticateToken, wrap(async (req, res) => {
    const sub = await loadSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const b = req.body || {};
    const o = await one("INSERT INTO offers (submission_id, candidate_id, job_order_id, rate, rate_type, start_date, end_date, terms, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) RETURNING *", [String(sub.id), String(sub.candidate_id), sub.job_order_id == null ? null : String(sub.job_order_id), b.rate || null, b.rate_type || null, b.start_date || null, b.end_date || null, b.terms || null, String(req.user.id)]);
    await events.record({ type: 'offer.draft', entity_type: 'submission', entity_id: sub.id, actor: actorOf(req), payload: { offer_id: o.id, rate: o.rate } });
    const row = b.status && b.status !== 'draft' ? await setOfferStatus(o, b.status, { req }) : o;
    res.status(201).json(row);
  }));
  app.put('/api/offers/:id', authenticateToken, wrap(async (req, res) => {
    const o = await one('SELECT * FROM offers WHERE id=$1', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const b = req.body || {};
    const sets = {}; for (const k of ['rate', 'rate_type', 'start_date', 'end_date', 'terms']) if (b[k] !== undefined) sets[k] = b[k] || null;
    let row = o;
    if (Object.keys(sets).length) { const cols = Object.keys(sets); row = (await pool.query(`UPDATE offers SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((c) => sets[c]), o.id])).rows[0]; }
    if (b.status && b.status !== row.status) row = await setOfferStatus(row, b.status, { req, note: b.note });
    res.json(row);
  }));

  // -- E-signature --
  app.get('/api/esign/status', authenticateToken, (req, res) => res.json({ configured: esign.isConfigured(), provider: esign.providerName(), countersigner: process.env.ESIGN_COUNTERSIGNER_EMAIL || null, webhook_url: `${(process.env.API_URL || 'https://velocitycrm-api.onrender.com').replace(/\/$/, '')}/api/esign/webhook`, kinds: esign.KINDS, company: COMPANY }));
  app.get('/api/esign/requests', authenticateToken, wrap(async (req, res) => {
    const where = []; const params = [];
    for (const k of ['entity_type', 'entity_id', 'kind', 'status', 'account_id', 'submission_id']) if (req.query[k]) { params.push(String(req.query[k])); where.push(`${k}=$${params.length}`); }
    const q = await pool.query(`SELECT id, kind, entity_type, entity_id, account_id, candidate_id, submission_id, signer_name, signer_email, provider, provider_agreement_id, status, last_event, error, created_by, sent_at, viewed_at, signed_at, created_at, updated_at FROM signature_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, params);
    res.json(q.rows);
  }));
  app.post('/api/esign/requests', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {};
    let row = await createSignatureRequest({ kind: b.kind, entity_type: b.entity_type, entity_id: b.entity_id, signer_email: b.signer_email, signer_name: b.signer_name, fields: b.fields || {}, req });
    if (b.send) row = await sendSignatureRequest(row, req);
    const { document_html, ...rest } = row;
    res.status(201).json({ ...rest, has_document: !!document_html });
  }));
  app.get('/api/esign/requests/:id', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT * FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    res.json({ ...r, fields: parse(r.fields) });
  }));
  app.get('/api/esign/requests/:id/document', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT document_html FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    res.type('html').send(r.document_html);
  }));
  app.post('/api/esign/requests/:id/send', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT * FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    if (['signed', 'cancelled'].includes(r.status)) return res.status(409).json({ error: `Already ${r.status}` });
    const { document_html, ...rest } = await sendSignatureRequest(r, req);
    res.json(rest);
  }));
  app.post('/api/esign/requests/:id/mark-signed', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT * FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    const note = (req.body && req.body.note) || null;
    if (r.provider === 'acrobat_sign' && !note) return res.status(400).json({ error: 'A note is required when overriding the e-signature provider status (e.g. "signed copy received by email")' });
    const { document_html, ...rest } = await applySignatureStatus(r, 'signed', { event: 'manual', actor: actorOf(req), note: note || 'Marked signed manually' });
    res.json(rest);
  }));
  app.post('/api/esign/requests/:id/cancel', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT * FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    if (r.provider === 'acrobat_sign' && r.provider_agreement_id && esign.isConfigured()) { try { await esign.cancelAgreement(r.provider_agreement_id); } catch (e) { await pool.query('UPDATE signature_requests SET error=$1 WHERE id=$2', [e.message, r.id]); } }
    const { document_html, ...rest } = await applySignatureStatus(r, 'cancelled', { event: 'manual', actor: actorOf(req), note: (req.body && req.body.note) || null });
    res.json(rest);
  }));
  app.post('/api/esign/requests/:id/refresh', authenticateToken, wrap(async (req, res) => {
    const r = await one('SELECT * FROM signature_requests WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Signature request not found' });
    if (!r.provider_agreement_id || !esign.isConfigured()) return res.json({ ...r, document_html: undefined, refreshed: false });
    const s = await esign.agreementStatus(r.provider_agreement_id);
    const row = s.status !== r.status ? await applySignatureStatus(r, s.status, { event: `poll:${s.provider_status}`, actor: actorOf(req) }) : r;
    res.json({ ...row, document_html: undefined, refreshed: true, provider_status: s.provider_status });
  }));
  const webhookEcho = (req, res) => { const id = req.headers['x-adobesign-clientid']; if (id) res.setHeader('X-AdobeSign-ClientId', id); };
  app.get('/api/esign/webhook', (req, res) => { webhookEcho(req, res); res.json({ ok: true }); });
  app.post('/api/esign/webhook', wrap(async (req, res) => {
    webhookEcho(req, res);
    const expected = process.env.ACROBAT_SIGN_CLIENT_ID;
    if (expected && req.headers['x-adobesign-clientid'] !== expected) { await events.record({ type: 'esign.webhook_rejected', result: 'error', error: 'client id mismatch' }); return res.status(401).json({ error: 'Unknown client id' }); }
    const p = esign.parseWebhook(req.body || {});
    if (!p) return res.status(400).json({ error: 'No agreement id in payload' });
    const r = await one('SELECT * FROM signature_requests WHERE provider_agreement_id=$1', [p.agreement_id]);
    await events.record({ type: 'esign.webhook', entity_type: r ? 'signature_request' : null, entity_id: r ? r.id : null, payload: { event: p.event, agreement_id: p.agreement_id, status: p.status, participant: p.participant } });
    if (!r) return res.json({ ok: true, matched: false });
    if (p.status && p.status !== r.status && !(r.status === 'signed' && p.status !== 'signed')) await applySignatureStatus(r, p.status, { event: p.event, actor: 'acrobat_sign' });
    res.json({ ok: true, matched: true });
  }));

  // -- Duplicate review queue --
  app.get('/api/duplicates', authenticateToken, wrap(async (req, res) => {
    const q = await pool.query("SELECT * FROM exceptions WHERE kind='duplicate.review' AND status=$1 ORDER BY id DESC LIMIT 300", [req.query.status || 'open']);
    res.json(q.rows.map((e) => ({ ...e, details: parse(e.details) })));
  }));
  app.post('/api/duplicates/:id/merge', authenticateToken, wrap(async (req, res) => {
    const exc = await one('SELECT * FROM exceptions WHERE id=$1', [req.params.id]);
    if (!exc) return res.status(404).json({ error: 'Not found' });
    const d = parse(exc.details) || {}; const b = req.body || {};
    const table = d.table || b.table;
    const keep = b.keep_id, remove = b.remove_id;
    if (!table || keep == null || remove == null) return res.status(400).json({ error: 'keep_id and remove_id are required' });
    const r = await dedupe.mergeRecords(pool, events, table, keep, remove, { actor: actorOf(req) });
    await events.resolveException(exc.id, { by: req.user.id, resolution: `merged ${remove} into ${keep}` });
    res.json(r);
  }));
  app.post('/api/duplicates/:id/dismiss', authenticateToken, wrap(async (req, res) => {
    const exc = await one('SELECT * FROM exceptions WHERE id=$1', [req.params.id]);
    if (!exc) return res.status(404).json({ error: 'Not found' });
    const d = parse(exc.details) || {};
    for (const m of d.matches || []) await dedupe.dismissPair(pool, events, d.table, d.record.id, m.id, { actor: actorOf(req) });
    res.json(await events.resolveException(exc.id, { by: req.user.id, resolution: 'not a duplicate' }));
  }));
  app.post('/api/duplicates/scan', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const tables = (req.body && req.body.tables) || ['candidates', 'contacts', 'accounts', 'leads'];
    const out = {}; for (const t of tables) if (dedupe.ENTITY[t]) out[t] = await dedupe.scanTable(pool, events, t);
    res.json(out);
  }));

  // -- Notifications --
  app.get('/api/notifications', authenticateToken, wrap(async (req, res) => {
    const uid = String(req.user.id);
    const q = await pool.query(`SELECT * FROM notifications WHERE user_id=$1 ${req.query.unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT $2`, [uid, Math.min(Number(req.query.limit) || 50, 200)]);
    const c = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [uid]);
    res.json({ unread: Number(c.rows[0].n), notifications: q.rows });
  }));
  app.post('/api/notifications/read-all', authenticateToken, wrap(async (req, res) => { await pool.query('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND read_at IS NULL', [String(req.user.id)]); res.json({ ok: true }); }));
  app.post('/api/notifications/:id/read', authenticateToken, wrap(async (req, res) => { const q = await pool.query('UPDATE notifications SET read_at=COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, String(req.user.id)]); if (!q.rows.length) return res.status(404).json({ error: 'Not found' }); res.json(q.rows[0]); }));

  // -- Audit: events, exceptions, jobs, summary --
  app.get('/api/events', authenticateToken, wrap(async (req, res) => {
    const where = []; const params = [];
    for (const k of ['entity_type', 'entity_id', 'type', 'txn_id', 'actor', 'result']) if (req.query[k]) { params.push(String(req.query[k])); where.push(`${k}=$${params.length}`); }
    if (req.query.type_prefix) { params.push(String(req.query.type_prefix) + '%'); where.push(`type LIKE $${params.length}`); }
    params.push(Math.min(Number(req.query.limit) || 100, 500));
    const q = await pool.query(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
    res.json(q.rows.map((e) => ({ ...e, payload: parse(e.payload) })));
  }));
  app.get('/api/exceptions', authenticateToken, wrap(async (req, res) => {
    const status = req.query.status || 'open';
    const q = status === 'all' ? await pool.query('SELECT * FROM exceptions ORDER BY id DESC LIMIT 300') : await pool.query('SELECT * FROM exceptions WHERE status=$1 ORDER BY id DESC LIMIT 300', [status]);
    res.json(q.rows.map((e) => ({ ...e, details: parse(e.details) })));
  }));
  app.post('/api/exceptions/:id/resolve', authenticateToken, wrap(async (req, res) => {
    const row = await events.resolveException(req.params.id, { by: req.user.id, resolution: (req.body && req.body.resolution) || null });
    if (!row) return res.status(404).json({ error: 'Exception not found' });
    res.json(row);
  }));
  app.post('/api/exceptions/:id/assign', authenticateToken, wrap(async (req, res) => {
    const q = await pool.query('UPDATE exceptions SET assigned_to=$1 WHERE id=$2 RETURNING *', [req.body && req.body.user_id ? String(req.body.user_id) : null, req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Exception not found' });
    if (q.rows[0].assigned_to) await notify({ user_ids: [q.rows[0].assigned_to], type: 'exception.assigned', title: `Exception assigned to you: ${q.rows[0].kind}`, body: q.rows[0].message, entity_type: q.rows[0].entity_type, entity_id: q.rows[0].entity_id, exclude: req.user.id });
    res.json(q.rows[0]);
  }));
  app.get('/api/jobs', authenticateToken, wrap(async (req, res) => {
    const status = req.query.status;
    const q = status ? await pool.query('SELECT * FROM jobs WHERE status=$1 ORDER BY id DESC LIMIT 200', [status]) : await pool.query('SELECT * FROM jobs ORDER BY id DESC LIMIT 200');
    res.json(q.rows.map((j) => ({ ...j, payload: parse(j.payload), result: parse(j.result) })));
  }));
  app.post('/api/jobs/:id/retry', authenticateToken, wrap(async (req, res) => {
    const q = await pool.query("UPDATE jobs SET status='queued', next_run_at=CURRENT_TIMESTAMP, attempts=0, finished_at=NULL, last_error=NULL WHERE id=$1 AND status IN ('dead','done','cancelled') RETURNING *", [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Job not found or still queued' });
    await events.record({ type: 'job.retried', entity_type: 'job', entity_id: req.params.id, actor: actorOf(req) });
    res.json(q.rows[0]);
  }));
  app.post('/api/jobs/run', authenticateToken, requireAdmin, wrap(async (req, res) => res.json(await events.runJobs(workers, { now: req.body && req.body.now ? new Date(req.body.now) : new Date(), limit: 100 }))));
  app.get('/api/automation/summary', authenticateToken, wrap(async (req, res) => {
    const uid = String(req.user.id);
    const n = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
    res.json({
      open_exceptions: await n("SELECT COUNT(*) AS n FROM exceptions WHERE status='open'"),
      my_exceptions: await n("SELECT COUNT(*) AS n FROM exceptions WHERE status='open' AND assigned_to=$1", [uid]),
      jobs: { queued: await n("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'"), dead: await n("SELECT COUNT(*) AS n FROM jobs WHERE status='dead'"), done_24h: await n("SELECT COUNT(*) AS n FROM jobs WHERE status='done' AND finished_at > $1", [new Date(Date.now() - 86400000)]) },
      unread_notifications: await n('SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [uid]),
      leads_ready_to_authorize: await n("SELECT COUNT(*) AS n FROM leads WHERE workflow_status='ready_to_authorize'"),
      intakes_to_review: await n("SELECT COUNT(*) AS n FROM job_orders WHERE intake_status='submitted'"),
      submissions_with_client: await n("SELECT COUNT(*) AS n FROM submissions WHERE status='client_review'"),
      offers_open: await n("SELECT COUNT(*) AS n FROM offers WHERE status IN ('draft','extended')"),
      signatures_pending: await n("SELECT COUNT(*) AS n FROM signature_requests WHERE status IN ('sent','viewed')"),
      duplicates_to_review: await n("SELECT COUNT(*) AS n FROM exceptions WHERE kind='duplicate.review' AND status='open'"),
      sla_breaches: await n("SELECT COUNT(*) AS n FROM exceptions WHERE kind LIKE 'sla.%' AND status='open'"),
      timesheets_open: await n("SELECT COUNT(*) AS n FROM timesheets WHERE status IN ('open','submitted')").catch(() => 0),
      invoices_unpaid: await n("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('draft','created','sent')").catch(() => 0),
      outreach_awaiting: await n("SELECT COUNT(*) AS n FROM candidate_outreach WHERE status='sent'").catch(() => 0),
      events_24h: await n('SELECT COUNT(*) AS n FROM events WHERE created_at > $1', [new Date(Date.now() - 86400000)]),
      esign: { configured: esign.isConfigured(), provider: esign.providerName() },
      email_configured: isEmailConfigured(),
    });
  }));

  return { events, ensureSchema, notify, notifyOwners, workers, registerWorkers, hooks, startJobRunner, applySubmissionStatus, placementGate, afterPlacement, onPlacementUpdated, onLeadReadyToAuthorize, authorizeSearch, normalizeSubmissionStatus, audit, createSignatureRequest, sendSignatureRequest, throttle, dedupeReview, loadJobOrder, accountForJob, scheduleInterviewComms };
}

module.exports = { install, SUBMISSION_STATUSES, STATUS_IDS, normalizeSubmissionStatus, INTERVIEW_OR_LATER, OFFER_OR_LATER, ACCEPTED_OR_LATER, PLACEMENT_READY, INTAKE_FIELDS, CLIENT_ACTIONS, SCHEMA };
