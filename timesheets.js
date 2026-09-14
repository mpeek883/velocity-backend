// Timesheets to invoice: weekly consultant timesheet link, client approval
// link, invoice record, QuickBooks Online push (or a manual HTML invoice when
// QuickBooks is not connected).
const qbo = require('./quickbooks');

const COMPANY = process.env.ESIGN_COMPANY_NAME || 'Peek Talent Solutions';
const APP_URL = (process.env.APP_URL || 'https://velocity-i5hx.onrender.com').replace(/\/$/, '');
const DAY = 86400000;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymd = (d) => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const dateOnly = (v) => { if (!v) return null; if (v instanceof Date) return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()); const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v); };
const fmt = (v) => { const d = dateOnly(v); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
/** Monday..Sunday containing `d`. */
function weekOf(d) { const x = dateOnly(d) || new Date(); const day = (x.getDay() + 6) % 7; const start = new Date(x); start.setDate(x.getDate() - day); const end = new Date(start); end.setDate(start.getDate() + 6); return { start, end }; }
function parseRate(v) { const m = String(v || '').replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS timesheets (id SERIAL PRIMARY KEY, placement_id TEXT, candidate_id TEXT, job_order_id TEXT, account_id TEXT, period_start DATE, period_end DATE, entries TEXT, hours NUMERIC(8,2), rate NUMERIC(10,2), rate_type VARCHAR(30), amount NUMERIC(12,2), status VARCHAR(20) DEFAULT 'open', consultant_token VARCHAR(80), approval_token VARCHAR(80), approver_email VARCHAR(255), consultant_email VARCHAR(255), submitted_at TIMESTAMP, approved_at TIMESTAMP, approved_by VARCHAR(255), rejected_reason TEXT, invoice_id TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, number VARCHAR(40), timesheet_id TEXT, placement_id TEXT, account_id TEXT, customer_name VARCHAR(255), customer_email VARCHAR(255), description TEXT, hours NUMERIC(8,2), rate NUMERIC(10,2), amount NUMERIC(12,2), status VARCHAR(20) DEFAULT 'draft', provider VARCHAR(20) DEFAULT 'manual', qbo_invoice_id VARCHAR(80), qbo_doc_number VARCHAR(80), error TEXT, issued_at TIMESTAMP, due_date DATE, sent_at TIMESTAMP, paid_at TIMESTAMP, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS bill_rate NUMERIC(10,2)',
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS bill_rate_type VARCHAR(30)',
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS client_approver_email VARCHAR(255)',
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS consultant_email VARCHAR(255)',
  'ALTER TABLE placements ADD COLUMN IF NOT EXISTS timesheet_cycle VARCHAR(20)',
  ...qbo.SCHEMA,
];

function install(deps) {
  const { app, pool, events, authenticateToken, requireAdmin, notifyOwners, sendEmail, isEmailConfigured, throttle, jwt, jwtSecret } = deps;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const rows = async (sql, p) => (await pool.query(sql, p)).rows;
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); } };
  const token = () => require('crypto').randomBytes(24).toString('base64url');

  async function ctxFor(placementId) {
    const p = await one('SELECT * FROM placements WHERE id::text=$1', [String(placementId)]);
    if (!p) return null;
    const cand = p.candidate_id ? await one('SELECT * FROM candidates WHERE id::text=$1', [String(p.candidate_id)]) : null;
    const job = p.job_order_id ? await one('SELECT * FROM job_orders WHERE id::text=$1', [String(p.job_order_id)]) : null;
    const acct = job && job.account_id ? await one('SELECT * FROM accounts WHERE id::text=$1', [String(job.account_id)]) : (job && job.company ? await one('SELECT * FROM accounts WHERE LOWER(name)=LOWER($1) ORDER BY id LIMIT 1', [job.company]) : null);
    const offer = p.submission_id ? await one("SELECT * FROM offers WHERE submission_id=$1 AND status='accepted' ORDER BY id DESC LIMIT 1", [String(p.submission_id)]) : null;
    const rate = p.bill_rate != null ? Number(p.bill_rate) : parseRate(offer && offer.rate) ?? parseRate(job && job.salary_range);
    const rateType = p.bill_rate_type || (offer && offer.rate_type) || 'per hour';
    const consultantEmail = p.consultant_email || (cand && cand.email) || null;
    const approverEmail = p.client_approver_email || (acct && acct.billing_contact && /@/.test(acct.billing_contact) ? acct.billing_contact : null);
    return { p, cand, job, acct, offer, rate, rateType, consultantEmail, approverEmail, label: `${cand ? cand.name : 'Consultant'} - ${job ? job.title : 'assignment'}${job && job.company ? ` at ${job.company}` : ''}` };
  }

  async function openTimesheet(ctx, { start, end, send = true, createdBy = null }) {
    const existing = await one('SELECT * FROM timesheets WHERE placement_id=$1 AND period_start=$2', [String(ctx.p.id), ymd(start)]);
    if (existing) return { timesheet: existing, created: false };
    const ts = await one('INSERT INTO timesheets (placement_id, candidate_id, job_order_id, account_id, period_start, period_end, entries, hours, rate, rate_type, status, consultant_token, approval_token, approver_email, consultant_email, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
      [String(ctx.p.id), ctx.p.candidate_id == null ? null : String(ctx.p.candidate_id), ctx.p.job_order_id == null ? null : String(ctx.p.job_order_id), ctx.acct ? String(ctx.acct.id) : null, ymd(start), ymd(end), '[]', ctx.rate, ctx.rateType, 'open', token(), token(), ctx.approverEmail, ctx.consultantEmail, createdBy == null ? null : String(createdBy)]);
    await events.record({ type: 'timesheet.opened', entity_type: 'placement', entity_id: ctx.p.id, payload: { timesheet_id: ts.id, period_start: ymd(start), period_end: ymd(end) } });
    if (send && ctx.consultantEmail) {
      const url = `${APP_URL}/?timesheet=${ts.consultant_token}`;
      await events.enqueue('email.send', { to: ctx.consultantEmail, subject: `Timesheet for ${fmt(start)} to ${fmt(end)}: ${ctx.job ? ctx.job.title : 'your assignment'}`, html: `<p>Hi ${esc(ctx.cand ? ctx.cand.name.split(' ')[0] : '')},</p><p>Please enter your hours for the week of ${esc(fmt(start))} to ${esc(fmt(end))} and submit them for approval:</p><p><a href="${esc(url)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Enter my hours</a></p><p>${esc(COMPANY)}</p>`, text: `Enter your hours for ${fmt(start)} to ${fmt(end)}: ${url}`, entity_type: 'placement', entity_id: ctx.p.id }, { dedupeKey: `timesheet.email:${ts.id}`, maxAttempts: 4 });
      await events.enqueue('timesheet.reminder', { timesheet_id: ts.id }, { runAt: new Date(end.getTime() + 2 * DAY), dedupeKey: `timesheet.reminder:${ts.id}`, maxAttempts: 2 });
    } else if (send && !ctx.consultantEmail) {
      await events.exception({ kind: 'timesheet.no_email', entity_type: 'placement', entity_id: ctx.p.id, message: `No consultant email on the placement for ${ctx.label}; the timesheet link could not be sent.`, assigned_to: ctx.p.created_by });
    }
    return { timesheet: ts, created: true };
  }

  async function submitTimesheet(ts, body) {
    const entries = Array.isArray(body.entries) ? body.entries.map((e) => ({ date: String(e.date || '').slice(0, 10), hours: Math.max(0, Math.min(24, Number(e.hours) || 0)), notes: String(e.notes || '').slice(0, 500) })).filter((e) => e.date) : [];
    const hours = Math.round(entries.reduce((a, e) => a + e.hours, 0) * 100) / 100;
    if (body.submit && hours <= 0) throw Object.assign(new Error('Enter at least one day of hours before submitting'), { status: 400 });
    const amount = ts.rate != null ? Math.round(hours * Number(ts.rate) * 100) / 100 : null;
    const status = body.submit ? 'submitted' : ts.status;
    const upd = await one(`UPDATE timesheets SET entries=$1, hours=$2, amount=$3, status=$4, submitted_at=${body.submit ? 'CURRENT_TIMESTAMP' : 'submitted_at'}, rejected_reason=${body.submit ? 'NULL' : 'rejected_reason'}, updated_at=CURRENT_TIMESTAMP WHERE id=$5 RETURNING *`, [JSON.stringify(entries), hours, amount, status, ts.id]);
    if (body.submit) {
      await events.record({ type: 'timesheet.submitted', entity_type: 'placement', entity_id: ts.placement_id, actor: `consultant:${ts.consultant_email || 'link'}`, payload: { timesheet_id: ts.id, hours } });
      await events.cancelJobs(`timesheet.reminder:${ts.id}`);
      const ctx = await ctxFor(ts.placement_id);
      if (ctx && (ts.approver_email || ctx.approverEmail)) {
        const to = ts.approver_email || ctx.approverEmail;
        const url = `${APP_URL}/?approve=${ts.approval_token}`;
        await events.enqueue('email.send', { to, subject: `Timesheet approval: ${ctx.cand ? ctx.cand.name : 'consultant'}, ${fmt(ts.period_start)} to ${fmt(ts.period_end)} (${hours} h)`, html: `<p>Hello,</p><p>${esc(ctx.cand ? ctx.cand.name : 'The consultant')} submitted ${hours} hours for ${esc(fmt(ts.period_start))} to ${esc(fmt(ts.period_end))}${ctx.job ? ` on ${esc(ctx.job.title)}` : ''}. Please review and approve:</p><p><a href="${esc(url)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Review and approve</a></p><p>${esc(COMPANY)}</p>`, text: `Review and approve: ${url}`, entity_type: 'placement', entity_id: ts.placement_id }, { dedupeKey: `timesheet.approval:${ts.id}:${Date.now()}`, maxAttempts: 4 });
        await pool.query('UPDATE timesheets SET approver_email=COALESCE(approver_email,$1) WHERE id=$2', [to, ts.id]);
      } else {
        await events.exception({ kind: 'timesheet.no_approver', entity_type: 'placement', entity_id: ts.placement_id, message: `Timesheet ${ts.id} submitted but the placement has no client approver email. Add one on the placement and resend.`, assigned_to: ctx ? ctx.p.created_by : null });
      }
      if (ctx) await notifyOwners({ owners: [ctx.p.created_by], type: 'timesheet.submitted', title: `Timesheet submitted: ${ctx.label} (${hours} h)`, body: `Sent to ${ts.approver_email || ctx.approverEmail || 'no approver on file'} for approval.`, entity_type: 'placement', entity_id: ts.placement_id, email: false });
    }
    return upd;
  }

  async function decideTimesheet(ts, { action, note, name, actor = 'client' }) {
    if (!['approve', 'reject'].includes(action)) throw Object.assign(new Error('action must be approve or reject'), { status: 400 });
    if (ts.status !== 'submitted') throw Object.assign(new Error(`This timesheet is ${ts.status}, not awaiting approval`), { status: 409 });
    const ctx = await ctxFor(ts.placement_id);
    if (action === 'approve') {
      const upd = await one("UPDATE timesheets SET status='approved', approved_at=CURRENT_TIMESTAMP, approved_by=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *", [name || ts.approver_email || actor, ts.id]);
      await events.record({ type: 'timesheet.approved', entity_type: 'placement', entity_id: ts.placement_id, actor: `${actor}:${name || ts.approver_email || ''}`, payload: { timesheet_id: ts.id, hours: ts.hours, note: note || null } });
      await events.enqueue('invoice.create', { timesheet_id: ts.id }, { dedupeKey: `invoice.create:${ts.id}`, maxAttempts: 4 });
      if (ctx) await notifyOwners({ owners: [ctx.p.created_by], type: 'timesheet.approved', title: `Timesheet approved: ${ctx.label} (${ts.hours} h)`, body: 'The invoice is being prepared.', entity_type: 'placement', entity_id: ts.placement_id, email: false });
      return upd;
    }
    const upd = await one("UPDATE timesheets SET status='open', rejected_reason=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *", [note || 'Rejected by the client', ts.id]);
    await events.record({ type: 'timesheet.rejected', entity_type: 'placement', entity_id: ts.placement_id, actor: `${actor}:${name || ts.approver_email || ''}`, payload: { timesheet_id: ts.id, note: note || null } });
    await events.exception({ kind: 'timesheet.rejected', entity_type: 'placement', entity_id: ts.placement_id, message: `Timesheet for ${fmt(ts.period_start)} rejected${note ? `: ${note}` : ''}. The consultant can correct and resubmit from the same link.`, assigned_to: ctx ? ctx.p.created_by : null });
    if (ts.consultant_email) await events.enqueue('email.send', { to: ts.consultant_email, subject: `Timesheet needs a correction: ${fmt(ts.period_start)} to ${fmt(ts.period_end)}`, html: `<p>Your timesheet was returned${note ? ` with this note: <em>${esc(note)}</em>` : ''}. Please correct and resubmit:</p><p><a href="${esc(`${APP_URL}/?timesheet=${ts.consultant_token}`)}">Open my timesheet</a></p><p>${esc(COMPANY)}</p>`, text: `Please correct and resubmit: ${APP_URL}/?timesheet=${ts.consultant_token}`, entity_type: 'placement', entity_id: ts.placement_id }, { maxAttempts: 3 });
    return upd;
  }

  // ---- Invoices ----
  async function nextInvoiceNumber() {
    const year = new Date().getFullYear();
    const c = await one("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE $1", [`INV-${year}-%`]);
    return `INV-${year}-${String(Number(c.n) + 1).padStart(4, '0')}`;
  }
  function invoiceHtml(inv, ctx) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>body{font-family:Arial,sans-serif;color:#111;margin:40px}h1{font-size:22px;margin:0}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f3f4f6}.tot{text-align:right;font-weight:700}.meta{color:#555;font-size:13px}</style></head><body>
      <h1>${esc(COMPANY)}</h1><p class="meta">Invoice <strong>${esc(inv.number)}</strong> · issued ${esc(fmt(inv.issued_at || new Date()))}${inv.due_date ? ` · due ${esc(fmt(inv.due_date))}` : ''}</p>
      <p><strong>Bill to:</strong> ${esc(inv.customer_name)}${inv.customer_email ? ` (${esc(inv.customer_email)})` : ''}</p>
      <table><thead><tr><th>Description</th><th>Hours</th><th>Rate</th><th>Amount</th></tr></thead><tbody><tr><td>${esc(inv.description)}</td><td>${esc(inv.hours)}</td><td>${money(inv.rate)}</td><td>${money(inv.amount)}</td></tr></tbody>
      <tfoot><tr><td colspan="3" class="tot">Total due</td><td class="tot">${money(inv.amount)}</td></tr></tfoot></table>
      <p class="meta">Payment terms ${esc(process.env.INVOICE_TERMS || 'net 30')}. Thank you for your business.</p></body></html>`;
  }
  async function createInvoiceForTimesheet(ts, { actor = 'system' } = {}) {
    const existing = await one('SELECT * FROM invoices WHERE timesheet_id=$1', [String(ts.id)]);
    if (existing) return existing;
    const ctx = await ctxFor(ts.placement_id);
    if (!ctx) throw new Error('Placement not found for the timesheet');
    if (ts.rate == null) { await events.exception({ kind: 'invoice.no_rate', entity_type: 'placement', entity_id: ts.placement_id, message: `No bill rate on the placement for ${ctx.label}; set bill_rate and retry the invoice job.`, assigned_to: ctx.p.created_by }); throw new Error('No bill rate on the placement'); }
    const number = await nextInvoiceNumber();
    const due = new Date(Date.now() + Number(process.env.INVOICE_DUE_DAYS || 30) * DAY);
    const desc = `${ctx.cand ? ctx.cand.name : 'Consultant'} - ${ctx.job ? ctx.job.title : 'services'}, ${fmt(ts.period_start)} to ${fmt(ts.period_end)}`;
    const inv = await one('INSERT INTO invoices (number, timesheet_id, placement_id, account_id, customer_name, customer_email, description, hours, rate, amount, status, provider, issued_at, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP,$13,$14) RETURNING *',
      [number, String(ts.id), String(ts.placement_id), ts.account_id, ctx.acct ? ctx.acct.name : (ctx.job ? ctx.job.company : 'Client'), ts.approver_email || ctx.approverEmail, desc, ts.hours, ts.rate, ts.amount, 'draft', 'manual', ymd(due), ctx.p.created_by]);
    await pool.query("UPDATE timesheets SET status='invoiced', invoice_id=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [String(inv.id), ts.id]);
    await events.record({ type: 'invoice.created', entity_type: 'invoice', entity_id: inv.id, actor, payload: { number, amount: inv.amount, timesheet_id: ts.id } });
    const connected = await qbo.loadConnection(pool);
    if (connected) {
      try {
        const r = await qbo.createInvoice(pool, { customer_name: inv.customer_name, customer_email: inv.customer_email, hours: inv.hours, rate: inv.rate, description: desc, due_date: ymd(due), memo: `VelocityCRM ${number}`, doc_number: number });
        const upd = await one("UPDATE invoices SET provider='quickbooks', qbo_invoice_id=$1, qbo_doc_number=$2, status='created', updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *", [String(r.id), r.doc_number || null, inv.id]);
        await events.record({ type: 'invoice.pushed', entity_type: 'invoice', entity_id: inv.id, actor, payload: { qbo_invoice_id: r.id, doc_number: r.doc_number, total: r.total } });
        if (process.env.INVOICE_AUTO_SEND === 'true' && inv.customer_email) { await qbo.sendInvoice(pool, r.id, inv.customer_email); await pool.query("UPDATE invoices SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=$1", [inv.id]); }
        await notifyOwners({ owners: [ctx.p.created_by], type: 'invoice.created', title: `Invoice ${number} created in QuickBooks: ${money(inv.amount)}`, body: `${desc}. ${process.env.INVOICE_AUTO_SEND === 'true' ? 'Sent to the client from QuickBooks.' : 'Open QuickBooks (or the QuickBooks screen) to send it.'}`, entity_type: 'invoice', entity_id: inv.id });
        return upd;
      } catch (e) {
        await pool.query("UPDATE invoices SET error=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [e.message.slice(0, 2000), inv.id]);
        await events.exception({ kind: 'invoice.qbo_failed', entity_type: 'invoice', entity_id: inv.id, message: `Invoice ${number} was created locally but QuickBooks refused it: ${e.message}. Fix and use "Push to QuickBooks".`, assigned_to: ctx.p.created_by });
        return one('SELECT * FROM invoices WHERE id=$1', [inv.id]);
      }
    }
    await notifyOwners({ owners: [ctx.p.created_by], type: 'invoice.created', title: `Invoice ${number} ready: ${money(inv.amount)}`, body: `${desc}. QuickBooks is not connected, so send it from the QuickBooks screen (emailed as an HTML invoice) or connect QuickBooks first.`, entity_type: 'invoice', entity_id: inv.id });
    return inv;
  }
  async function sendInvoiceManual(inv, req) {
    if (!inv.customer_email) throw Object.assign(new Error('The invoice has no customer email'), { status: 400 });
    const ctx = await ctxFor(inv.placement_id);
    await events.enqueue('email.send', { to: inv.customer_email, subject: `${COMPANY} invoice ${inv.number}: ${money(inv.amount)}`, html: invoiceHtml(inv, ctx), text: `Invoice ${inv.number} for ${money(inv.amount)}: ${inv.description}`, entity_type: 'invoice', entity_id: inv.id }, { dedupeKey: `invoice.email:${inv.id}:${Date.now()}`, maxAttempts: 4 });
    const upd = await one("UPDATE invoices SET status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [inv.id]);
    await events.record({ type: 'invoice.sent', entity_type: 'invoice', entity_id: inv.id, actor: `user:${req.user.id}`, payload: { to: inv.customer_email, provider: 'manual' } });
    return upd;
  }

  const workers = {
    'timesheet.open': async ({ placement_id }) => {
      const ctx = await ctxFor(placement_id); if (!ctx) return 'gone';
      if (!['active', 'extended'].includes(ctx.p.placement_status || 'active')) return 'not active';
      const end = dateOnly(ctx.p.end_date); const start = dateOnly(ctx.p.start_date);
      const wk = weekOf(new Date());
      if (start && wk.end < start) { await scheduleNextOpen(ctx.p, wk.end); return 'before start'; }
      if (end && wk.start > end) return 'after end';
      const r = await openTimesheet(ctx, { start: wk.start, end: wk.end, send: true });
      await scheduleNextOpen(ctx.p, wk.end);
      return r.created ? `opened ${r.timesheet.id}` : 'exists';
    },
    'timesheet.reminder': async ({ timesheet_id }) => {
      const ts = await one('SELECT * FROM timesheets WHERE id=$1', [timesheet_id]);
      if (!ts || ts.status !== 'open' || !ts.consultant_email) return 'skip';
      await events.enqueue('email.send', { to: ts.consultant_email, subject: `Reminder: timesheet for ${fmt(ts.period_start)} to ${fmt(ts.period_end)}`, html: `<p>Your hours for last week have not been submitted yet:</p><p><a href="${esc(`${APP_URL}/?timesheet=${ts.consultant_token}`)}">Enter my hours</a></p><p>${esc(COMPANY)}</p>`, text: `Enter your hours: ${APP_URL}/?timesheet=${ts.consultant_token}`, entity_type: 'placement', entity_id: ts.placement_id }, { maxAttempts: 3 });
      const ctx = await ctxFor(ts.placement_id);
      if (ctx) await notifyOwners({ owners: [ctx.p.created_by], type: 'timesheet.late', title: `Timesheet late: ${ctx.label}`, body: `No hours submitted for ${fmt(ts.period_start)} to ${fmt(ts.period_end)}. Reminder sent to the consultant.`, entity_type: 'placement', entity_id: ts.placement_id, email: false });
      return 'reminded';
    },
    'invoice.create': async ({ timesheet_id }) => { const ts = await one('SELECT * FROM timesheets WHERE id=$1', [timesheet_id]); if (!ts) return 'gone'; if (ts.status !== 'approved' && ts.status !== 'invoiced') return `status ${ts.status}`; const inv = await createInvoiceForTimesheet(ts); return { invoice_id: inv.id, number: inv.number, provider: inv.provider }; },
  };
  async function scheduleNextOpen(p, afterDate) {
    // Open the next week's timesheet on the Friday of that week (a Sunday period end -> Friday before).
    const wkEnd = new Date(afterDate); wkEnd.setDate(wkEnd.getDate() + 7);
    const friday = new Date(wkEnd); friday.setDate(wkEnd.getDate() - 2); friday.setHours(15, 0, 0, 0);
    const end = dateOnly(p.end_date);
    if (end && wkEnd.getTime() - 6 * DAY > end.getTime()) return null;
    await events.cancelJobs(`timesheet.open:${p.id}`);
    return events.enqueue('timesheet.open', { placement_id: p.id }, { runAt: friday, dedupeKey: `timesheet.open:${p.id}`, maxAttempts: 3 });
  }
  /** Called when a placement is created or its dates change. */
  async function schedulePlacement(p) {
    if ((p.timesheet_cycle || 'weekly') === 'none') { await events.cancelJobs(`timesheet.open:${p.id}`); return null; }
    const start = dateOnly(p.start_date) || new Date();
    const first = weekOf(start); // first week's Friday
    const friday = new Date(first.start); friday.setDate(first.start.getDate() + 4); friday.setHours(15, 0, 0, 0);
    const runAt = friday > new Date() ? friday : new Date(Date.now() + 60000);
    await events.cancelJobs(`timesheet.open:${p.id}`);
    return events.enqueue('timesheet.open', { placement_id: p.id }, { runAt, dedupeKey: `timesheet.open:${p.id}`, maxAttempts: 3 });
  }

  // ---- Routes: public ----
  app.get('/api/timesheet/:token', wrap(async (req, res) => {
    if (!(await throttle(`timesheet:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const ts = await one('SELECT * FROM timesheets WHERE consultant_token=$1', [String(req.params.token)]);
    if (!ts) return res.status(404).json({ error: 'This timesheet link is not valid' });
    const ctx = await ctxFor(ts.placement_id);
    res.json({ company: COMPANY, consultant: ctx && ctx.cand ? ctx.cand.name : '', role: ctx && ctx.job ? ctx.job.title : '', client: ctx && ctx.job ? ctx.job.company : '', period_start: ymd(dateOnly(ts.period_start)), period_end: ymd(dateOnly(ts.period_end)), entries: JSON.parse(ts.entries || '[]'), hours: Number(ts.hours || 0), status: ts.status, rejected_reason: ts.rejected_reason, submitted_at: ts.submitted_at });
  }));
  app.post('/api/timesheet/:token', wrap(async (req, res) => {
    if (!(await throttle(`timesheet:${req.ip}`, 60))) return res.status(429).json({ error: 'Too many requests' });
    const ts = await one('SELECT * FROM timesheets WHERE consultant_token=$1', [String(req.params.token)]);
    if (!ts) return res.status(404).json({ error: 'This timesheet link is not valid' });
    if (!['open', 'submitted'].includes(ts.status)) return res.status(409).json({ error: `This timesheet is already ${ts.status}` });
    if (ts.status === 'submitted' && req.body && req.body.submit) return res.status(409).json({ error: 'Already submitted and awaiting approval' });
    const upd = await submitTimesheet(ts, req.body || {});
    res.json({ ok: true, status: upd.status, hours: Number(upd.hours) });
  }));
  app.get('/api/timesheet-approval/:token', wrap(async (req, res) => {
    if (!(await throttle(`approve:${req.ip}`))) return res.status(429).json({ error: 'Too many requests' });
    const ts = await one('SELECT * FROM timesheets WHERE approval_token=$1', [String(req.params.token)]);
    if (!ts) return res.status(404).json({ error: 'This approval link is not valid' });
    const ctx = await ctxFor(ts.placement_id);
    res.json({ company: COMPANY, consultant: ctx && ctx.cand ? ctx.cand.name : '', role: ctx && ctx.job ? ctx.job.title : '', period_start: ymd(dateOnly(ts.period_start)), period_end: ymd(dateOnly(ts.period_end)), entries: JSON.parse(ts.entries || '[]'), hours: Number(ts.hours || 0), status: ts.status, approved_at: ts.approved_at, approved_by: ts.approved_by });
  }));
  app.post('/api/timesheet-approval/:token', wrap(async (req, res) => {
    if (!(await throttle(`approve:${req.ip}`, 30))) return res.status(429).json({ error: 'Too many requests' });
    const ts = await one('SELECT * FROM timesheets WHERE approval_token=$1', [String(req.params.token)]);
    if (!ts) return res.status(404).json({ error: 'This approval link is not valid' });
    const b = req.body || {};
    const upd = await decideTimesheet(ts, { action: b.action, note: b.note, name: b.name, actor: 'client' });
    res.json({ ok: true, status: upd.status });
  }));

  // ---- Routes: internal ----
  app.get('/api/timesheets', authenticateToken, wrap(async (req, res) => {
    const where = []; const params = [];
    if (req.query.placement_id) { params.push(String(req.query.placement_id)); where.push(`placement_id=$${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`status=$${params.length}`); }
    const list = await rows(`SELECT * FROM timesheets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY period_start DESC, id DESC LIMIT 300`, params);
    res.json(list.map((t) => ({ ...t, entries: JSON.parse(t.entries || '[]'), consultant_url: `${APP_URL}/?timesheet=${t.consultant_token}`, approval_url: `${APP_URL}/?approve=${t.approval_token}`, consultant_token: undefined, approval_token: undefined })));
  }));
  app.post('/api/placements/:id/timesheets', authenticateToken, wrap(async (req, res) => {
    const ctx = await ctxFor(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Placement not found' });
    const b = req.body || {};
    const wk = b.period_start ? { start: dateOnly(b.period_start), end: b.period_end ? dateOnly(b.period_end) : (() => { const e = dateOnly(b.period_start); e.setDate(e.getDate() + 6); return e; })() } : weekOf(new Date());
    const r = await openTimesheet(ctx, { start: wk.start, end: wk.end, send: b.send !== false, createdBy: req.user.id });
    res.status(r.created ? 201 : 200).json({ ...r.timesheet, entries: JSON.parse(r.timesheet.entries || '[]'), created: r.created, consultant_url: `${APP_URL}/?timesheet=${r.timesheet.consultant_token}`, approval_url: `${APP_URL}/?approve=${r.timesheet.approval_token}` });
  }));
  app.post('/api/timesheets/:id/remind', authenticateToken, wrap(async (req, res) => { const r = await workers['timesheet.reminder']({ timesheet_id: req.params.id }); res.json({ result: r }); }));
  app.post('/api/timesheets/:id/decide', authenticateToken, wrap(async (req, res) => {
    const ts = await one('SELECT * FROM timesheets WHERE id=$1', [req.params.id]);
    if (!ts) return res.status(404).json({ error: 'Timesheet not found' });
    const b = req.body || {};
    if (!b.note) return res.status(400).json({ error: 'A note is required when approving or rejecting on the client\'s behalf' });
    res.json(await decideTimesheet(ts, { action: b.action, note: b.note, name: req.user.email, actor: `user:${req.user.id}` }));
  }));
  app.get('/api/invoices', authenticateToken, wrap(async (req, res) => res.json(await rows(`SELECT * FROM invoices ${req.query.status ? 'WHERE status=$1' : ''} ORDER BY id DESC LIMIT 300`, req.query.status ? [String(req.query.status)] : []))));
  app.get('/api/invoices/:id/document', authenticateToken, wrap(async (req, res) => { const inv = await one('SELECT * FROM invoices WHERE id=$1', [req.params.id]); if (!inv) return res.status(404).json({ error: 'Invoice not found' }); res.type('html').send(invoiceHtml(inv, await ctxFor(inv.placement_id))); }));
  app.post('/api/invoices/:id/send', authenticateToken, wrap(async (req, res) => {
    const inv = await one('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.provider === 'quickbooks' && inv.qbo_invoice_id) { await qbo.sendInvoice(pool, inv.qbo_invoice_id, inv.customer_email); const upd = await one("UPDATE invoices SET status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [inv.id]); await events.record({ type: 'invoice.sent', entity_type: 'invoice', entity_id: inv.id, actor: `user:${req.user.id}`, payload: { provider: 'quickbooks' } }); return res.json(upd); }
    res.json(await sendInvoiceManual(inv, req));
  }));
  app.post('/api/invoices/:id/push', authenticateToken, wrap(async (req, res) => {
    const inv = await one('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.qbo_invoice_id) return res.status(409).json({ error: 'Already in QuickBooks' });
    const r = await qbo.createInvoice(pool, { customer_name: inv.customer_name, customer_email: inv.customer_email, hours: inv.hours, rate: inv.rate, description: inv.description, due_date: inv.due_date ? ymd(dateOnly(inv.due_date)) : undefined, memo: `VelocityCRM ${inv.number}`, doc_number: inv.number });
    const upd = await one("UPDATE invoices SET provider='quickbooks', qbo_invoice_id=$1, qbo_doc_number=$2, status='created', error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *", [String(r.id), r.doc_number || null, inv.id]);
    await events.record({ type: 'invoice.pushed', entity_type: 'invoice', entity_id: inv.id, actor: `user:${req.user.id}`, payload: { qbo_invoice_id: r.id } });
    await events.resolveOpen('invoice.qbo_failed', 'invoice', inv.id, 'pushed');
    res.json(upd);
  }));
  app.post('/api/invoices/:id/mark-paid', authenticateToken, wrap(async (req, res) => {
    const upd = await one("UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [req.params.id]);
    if (!upd) return res.status(404).json({ error: 'Invoice not found' });
    await events.record({ type: 'invoice.paid', entity_type: 'invoice', entity_id: upd.id, actor: `user:${req.user.id}`, payload: { note: (req.body && req.body.note) || null } });
    res.json(upd);
  }));
  app.post('/api/invoices/:id/refresh', authenticateToken, wrap(async (req, res) => {
    const inv = await one('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv || !inv.qbo_invoice_id) return res.status(404).json({ error: 'Not a QuickBooks invoice' });
    const s = await qbo.invoiceStatus(pool, inv.qbo_invoice_id);
    const upd = s.paid ? await one("UPDATE invoices SET status='paid', paid_at=COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [inv.id]) : inv;
    res.json({ ...upd, balance: s.balance });
  }));

  // ---- QuickBooks connection ----
  app.get('/api/quickbooks/status', authenticateToken, wrap(async (req, res) => {
    const c = await qbo.loadConnection(pool);
    let company = null;
    if (c && req.query.verify === '1') { try { company = await qbo.companyInfo(pool); } catch (e) { company = { error: e.message }; } }
    res.json({ configured: qbo.isConfigured(), connected: !!c, realm_id: c ? c.realm_id : null, connected_at: c ? c.connected_at : null, refresh_expires_at: c ? c.refresh_expires_at : null, env: process.env.QBO_ENV || 'sandbox', redirect_uri: qbo.redirectUri(), company, auto_send: process.env.INVOICE_AUTO_SEND === 'true' });
  }));
  app.get('/api/quickbooks/connect', authenticateToken, requireAdmin, wrap(async (req, res) => {
    if (!qbo.isConfigured()) return res.status(503).json({ error: 'Set QBO_CLIENT_ID and QBO_CLIENT_SECRET on the API service first', code: 'QBO_NOT_CONFIGURED' });
    const state = jwt.sign({ purpose: 'qbo-connect', user_id: req.user.id }, jwtSecret, { expiresIn: '15m' });
    res.json({ url: qbo.authUrl(state) });
  }));
  app.get('/api/quickbooks/callback', wrap(async (req, res) => {
    const back = (params) => res.redirect(`${APP_URL}/?${new URLSearchParams(params)}`);
    try {
      const { code, state, realmId, error } = req.query;
      if (error) return back({ connect_error: String(error) });
      const st = jwt.verify(String(state || ''), jwtSecret);
      if (st.purpose !== 'qbo-connect') throw new Error('bad state');
      const tokens = await qbo.exchangeCode(String(code));
      await qbo.saveConnection(pool, { realm_id: String(realmId), tokens, connected_by: st.user_id });
      await events.record({ type: 'quickbooks.connected', actor: `user:${st.user_id}`, payload: { realm_id: realmId, env: process.env.QBO_ENV || 'sandbox' } });
      back({ connected: 'QuickBooks', provider: 'quickbooks' });
    } catch (e) { back({ connect_error: e.message }); }
  }));
  app.delete('/api/quickbooks/connection', authenticateToken, requireAdmin, wrap(async (req, res) => { await pool.query("DELETE FROM integration_tokens WHERE provider='quickbooks'"); await events.record({ type: 'quickbooks.disconnected', actor: `user:${req.user.id}` }); res.json({ ok: true }); }));

  return { workers, schedulePlacement, openTimesheet, submitTimesheet, decideTimesheet, createInvoiceForTimesheet, ctxFor, weekOf };
}

module.exports = { install, SCHEMA, weekOf, parseRate };
