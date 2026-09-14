// SLA watchdog, weekly digest, daily maintenance and the post-placement
// cadence. All of it runs through the job queue in events.js so every run is
// recorded, retried and visible on the Automation screen.
const { parse } = require('./events');

const DAY = 86400000;
const COMPANY = process.env.ESIGN_COMPANY_NAME || 'Peek Talent Solutions';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function businessDaysAgo(n, from = new Date()) {
  const d = new Date(from); let left = n;
  while (left > 0) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) left -= 1; }
  return d;
}
function nextWeekday(weekday, hour, from = new Date()) { // weekday 0..6
  const d = new Date(from); d.setHours(hour, 0, 0, 0);
  while (d.getDay() !== weekday || d <= from) d.setDate(d.getDate() + 1);
  return d;
}
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
const dateOnly = (v) => { if (!v) return null; if (v instanceof Date) return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()); const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v); };

const SLA = {
  lead_unreviewed: { days: Number(process.env.SLA_LEAD_REVIEW_DAYS || 1), business: true, label: 'Lead not reviewed' },
  authorize_pending: { days: Number(process.env.SLA_AUTHORIZE_DAYS || 1), business: true, label: 'Authorize Search waiting' },
  client_silent: { days: Number(process.env.SLA_CLIENT_DAYS || 5), business: false, label: 'No client response' },
  offer_unanswered: { days: Number(process.env.SLA_OFFER_DAYS || 3), business: false, label: 'Offer unanswered' },
  interview_unscheduled: { days: Number(process.env.SLA_INTERVIEW_DAYS || 2), business: true, label: 'Interview request not scheduled' },
  intake_unapproved: { days: Number(process.env.SLA_INTAKE_DAYS || 2), business: true, label: 'Client intake awaiting approval' },
};

function install(deps) {
  const { pool, events, notify, notifyOwners, sendEmail, isEmailConfigured, matching, roleCache, jwt, jwtSecret, port, app, authenticateToken, requireAdmin } = deps;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const rows = async (sql, p) => (await pool.query(sql, p)).rows;
  const cutoff = (rule, now) => (rule.business ? businessDaysAgo(rule.days, now) : new Date(now.getTime() - rule.days * DAY));

  async function slaCheck(now = new Date()) {
    const found = {};
    const flag = async (kind, list) => {
      found[kind] = list;
      for (const x of list) await events.exception({ kind: `sla.${kind}`, entity_type: x.entity_type, entity_id: x.entity_id, message: x.message, assigned_to: x.assigned_to || null, details: { rule: SLA[kind], since: x.since } });
      // Auto-resolve exceptions whose condition has cleared.
      const open = await rows("SELECT id, entity_type, entity_id FROM exceptions WHERE kind=$1 AND status='open'", [`sla.${kind}`]);
      for (const o of open) if (!list.some((x) => String(x.entity_id) === String(o.entity_id))) await pool.query("UPDATE exceptions SET status='resolved', resolution='condition cleared', resolved_at=CURRENT_TIMESTAMP WHERE id=$1", [o.id]);
    };
    const leads = await rows("SELECT id, lead_no, name, company, job_title, assigned_to, created_at, updated_at, workflow_status, reviewed_at FROM leads WHERE COALESCE(workflow_status,'new') IN ('new','ready_to_authorize') AND COALESCE(status,'new') NOT IN ('unqualified','converted')");
    await flag('lead_unreviewed', leads.filter((l) => (l.workflow_status || 'new') === 'new' && !l.reviewed_at && new Date(l.created_at) < cutoff(SLA.lead_unreviewed, now)).map((l) => ({ entity_type: 'lead', entity_id: l.id, assigned_to: l.assigned_to, since: l.created_at, message: `L-${String(l.lead_no || '').padStart(5, '0')} ${l.name} (${l.company}) has not been reviewed for ${SLA.lead_unreviewed.days} business day(s).` })));
    await flag('authorize_pending', leads.filter((l) => l.workflow_status === 'ready_to_authorize' && new Date(l.updated_at || l.created_at) < cutoff(SLA.authorize_pending, now)).map((l) => ({ entity_type: 'lead', entity_id: l.id, assigned_to: l.assigned_to, since: l.updated_at, message: `${l.name} confirmed interest in ${l.job_title || 'a role'}; Authorize Search has been waiting ${SLA.authorize_pending.days}+ business day(s).` })));
    const subs = await rows("SELECT s.id, s.candidate_id, s.created_by, s.stage_changed_at, s.updated_at, c.name AS candidate_name FROM submissions s LEFT JOIN candidates c ON c.id::text=s.candidate_id::text WHERE s.status='client_review'");
    await flag('client_silent', subs.filter((s) => new Date(s.stage_changed_at || s.updated_at) < cutoff(SLA.client_silent, now)).map((s) => ({ entity_type: 'submission', entity_id: s.id, assigned_to: s.created_by, since: s.stage_changed_at, message: `No client response on ${s.candidate_name || 'candidate'} for ${SLA.client_silent.days}+ days. Call the client.` })));
    const offers = await rows("SELECT o.id, o.submission_id, o.extended_at, o.created_by, c.name AS candidate_name FROM offers o LEFT JOIN candidates c ON c.id::text=o.candidate_id::text WHERE o.status='extended'");
    await flag('offer_unanswered', offers.filter((o) => o.extended_at && new Date(o.extended_at) < cutoff(SLA.offer_unanswered, now)).map((o) => ({ entity_type: 'submission', entity_id: o.submission_id, assigned_to: o.created_by !== 'client' ? o.created_by : null, since: o.extended_at, message: `Offer to ${o.candidate_name || 'candidate'} extended ${SLA.offer_unanswered.days}+ days ago with no answer.` })));
    const ivs = await rows("SELECT i.id, i.submission_id, i.round, i.created_at, s.created_by FROM interview_rounds i LEFT JOIN submissions s ON s.id::text=i.submission_id WHERE i.status='requested'");
    await flag('interview_unscheduled', ivs.filter((i) => new Date(i.created_at) < cutoff(SLA.interview_unscheduled, now)).map((i) => ({ entity_type: 'submission', entity_id: i.submission_id, assigned_to: i.created_by, since: i.created_at, message: `Interview round ${i.round} was requested ${SLA.interview_unscheduled.days}+ business days ago and is not scheduled.` })));
    const jobs = await rows("SELECT id, title, updated_at, created_by FROM job_orders WHERE intake_status='submitted'");
    await flag('intake_unapproved', jobs.filter((j) => new Date(j.updated_at) < cutoff(SLA.intake_unapproved, now)).map((j) => ({ entity_type: 'job_order', entity_id: j.id, assigned_to: j.created_by, since: j.updated_at, message: `Client intake for "${j.title}" is waiting for approval.` })));
    const summary = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length]));
    await events.record({ type: 'sla.checked', payload: summary });
    return summary;
  }

  // ---- Weekly digest ----
  async function systemToken() {
    const admin = await one("SELECT id, email FROM users WHERE role='admin' ORDER BY id LIMIT 1") || await one('SELECT id, email FROM users ORDER BY id LIMIT 1');
    if (!admin) return null;
    return jwt.sign({ id: admin.id, email: admin.email, system: true }, jwtSecret, { expiresIn: '5m' });
  }
  async function buildDigest(now = new Date()) {
    const token = await systemToken();
    let metrics = null;
    if (token) { try { const r = await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: { Authorization: `Bearer ${token}` } }); if (r.ok) metrics = await r.json(); } catch { /* */ } }
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const n = async (sql, p = []) => Number((await one(sql, p) || { n: 0 }).n);
    const exc = await rows("SELECT kind, COUNT(*) AS n FROM exceptions WHERE status='open' GROUP BY kind ORDER BY n DESC");
    const d = {
      period_end: now.toISOString(), period_start: weekAgo.toISOString(),
      leads_new: await n('SELECT COUNT(*) AS n FROM leads WHERE created_at > $1', [weekAgo]),
      leads_ready: await n("SELECT COUNT(*) AS n FROM leads WHERE workflow_status='ready_to_authorize'"),
      searches_authorized: await n("SELECT COUNT(*) AS n FROM events WHERE type='lead.search_authorized' AND created_at > $1", [weekAgo]),
      submissions_new: await n('SELECT COUNT(*) AS n FROM submissions WHERE created_at > $1', [weekAgo]),
      with_client: await n("SELECT COUNT(*) AS n FROM submissions WHERE status='client_review'"),
      interviews_scheduled: await n("SELECT COUNT(*) AS n FROM interview_rounds WHERE scheduled_at > $1", [weekAgo]),
      offers_open: await n("SELECT COUNT(*) AS n FROM offers WHERE status IN ('draft','extended')"),
      placements_new: await n('SELECT COUNT(*) AS n FROM placements WHERE created_at > $1', [weekAgo]),
      signatures_pending: await n("SELECT COUNT(*) AS n FROM signature_requests WHERE status IN ('sent','viewed')"),
      exceptions_open: exc.reduce((a, e) => a + Number(e.n), 0), exceptions_by_kind: exc.map((e) => ({ kind: e.kind, n: Number(e.n) })),
      jobs_dead: await n("SELECT COUNT(*) AS n FROM jobs WHERE status='dead'"),
      events_week: await n('SELECT COUNT(*) AS n FROM events WHERE created_at > $1', [weekAgo]),
      metrics: metrics ? { open_pipeline: metrics.pipeline.open_pipeline_value.value, win_rate: metrics.pipeline.win_rate.value, hours_to_first_response: metrics.speed.hours_to_first_response.value, days_to_fill: metrics.speed.days_to_fill.value, submission_to_interview: metrics.volume.submission_to_interview_rate.value, offer_acceptance: metrics.volume.offer_acceptance_rate.value, overdue_followups: metrics.activity.overdue_followups.value } : null,
    };
    const row = (l, v) => `<tr><td style="padding:4px 10px 4px 0;color:#475569">${esc(l)}</td><td style="padding:4px 0;font-weight:700">${esc(v == null ? '-' : v)}</td></tr>`;
    d.html = `<h2 style="font-family:Arial,sans-serif">VelocityCRM weekly digest</h2><p style="font-family:Arial,sans-serif;color:#475569">${weekAgo.toLocaleDateString()} to ${now.toLocaleDateString()}</p>
      <table style="font-family:Arial,sans-serif;font-size:14px">${row('New leads', d.leads_new)}${row('Leads waiting for Authorize Search', d.leads_ready)}${row('Searches authorized', d.searches_authorized)}${row('New submissions', d.submissions_new)}${row('Submissions with clients now', d.with_client)}${row('Interviews scheduled', d.interviews_scheduled)}${row('Open offers', d.offers_open)}${row('New placements', d.placements_new)}${row('Documents out for signature', d.signatures_pending)}${row('Open exceptions', d.exceptions_open)}${row('Dead jobs', d.jobs_dead)}</table>
      ${d.metrics ? `<h3 style="font-family:Arial,sans-serif">Metrics</h3><table style="font-family:Arial,sans-serif;font-size:14px">${row('Open pipeline ($)', d.metrics.open_pipeline)}${row('Win rate (%)', d.metrics.win_rate)}${row('Hours to first response', d.metrics.hours_to_first_response)}${row('Days to fill', d.metrics.days_to_fill)}${row('Submission to interview (%)', d.metrics.submission_to_interview)}${row('Offer acceptance (%)', d.metrics.offer_acceptance)}${row('Overdue follow-ups', d.metrics.overdue_followups)}</table>` : ''}
      ${d.exceptions_by_kind.length ? `<h3 style="font-family:Arial,sans-serif">Open exceptions</h3><ul style="font-family:Arial,sans-serif;font-size:14px">${d.exceptions_by_kind.map((e) => `<li>${esc(e.kind)}: ${e.n}</li>`).join('')}</ul>` : '<p style="font-family:Arial,sans-serif">No open exceptions.</p>'}
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#94a3b8">Sent by VelocityCRM for ${esc(COMPANY)}.</p>`;
    return d;
  }
  async function sendDigest({ now = new Date(), to = null } = {}) {
    const d = await buildDigest(now);
    const wantRoles = String(process.env.DIGEST_ROLES || 'admin').split(',').map((s) => s.trim());
    let recipients = to ? [to] : [];
    if (!recipients.length) { const users = await rows("SELECT id, email FROM users WHERE COALESCE(is_active, TRUE) = TRUE"); for (const u of users) if (u.email && wantRoles.includes(await roleCache.roleFor(u.id))) recipients.push(u.email); }
    if (!recipients.length) return { sent: 0, reason: 'no recipients' };
    if (!isEmailConfigured()) return { sent: 0, reason: 'email not configured', digest: d };
    for (const r of recipients) await sendEmail({ to: r, subject: `VelocityCRM weekly digest: ${d.leads_new} new leads, ${d.submissions_new} submissions, ${d.exceptions_open} open exceptions`, html: d.html, text: 'Weekly digest' });
    await events.record({ type: 'digest.sent', payload: { recipients, leads_new: d.leads_new, exceptions_open: d.exceptions_open } });
    return { sent: recipients.length, recipients };
  }

  // ---- Maintenance ----
  async function maintenance(now = new Date()) {
    const keepDays = Number(process.env.EVENTS_RETENTION_DAYS || 365);
    const out = { events_archived: 0, jobs_pruned: 0, notifications_pruned: 0, rate_limits_pruned: 0 };
    const old = new Date(now.getTime() - keepDays * DAY);
    try {
      const moved = await pool.query('INSERT INTO events_archive (id, type, entity_type, entity_id, actor, txn_id, result, error, payload, created_at) SELECT id, type, entity_type, entity_id, actor, txn_id, result, error, payload, created_at FROM events WHERE created_at < $1 RETURNING id', [old]);
      if (moved.rows.length) await pool.query('DELETE FROM events WHERE created_at < $1', [old]);
      out.events_archived = moved.rows.length;
    } catch (e) { out.events_error = e.message; }
    try { out.jobs_pruned = (await pool.query("DELETE FROM jobs WHERE status IN ('done','cancelled') AND COALESCE(finished_at, updated_at) < $1 RETURNING id", [new Date(now.getTime() - 30 * DAY)])).rows.length; } catch { /* */ }
    try { out.notifications_pruned = (await pool.query('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < $1 RETURNING id', [new Date(now.getTime() - 90 * DAY)])).rows.length; } catch { /* */ }
    try { out.rate_limits_pruned = (await pool.query('DELETE FROM rate_limits WHERE window_start < $1 RETURNING key', [new Date(now.getTime() - DAY)])).rows.length; } catch { /* */ }
    await events.record({ type: 'maintenance.ran', payload: out });
    return out;
  }

  // ---- Post-placement cadence ----
  const CHECKINS = [1, 7, 30, 60, 90];
  const isActive = (p) => ['active', 'extended'].includes(p.placement_status || 'active');
  async function schedulePlacementJobs(p) {
    const start = dateOnly(p.start_date); const end = dateOnly(p.end_date);
    const now = new Date();
    const keys = [];
    const put = async (type, key, runAt, payload) => { keys.push(key); await events.cancelJobs(key); if (runAt > now) await events.enqueue(type, payload, { runAt, dedupeKey: key, maxAttempts: 3 }); };
    if (start) {
      await put('placement.start_confirm', `placement.start_confirm:${p.id}`, addDays(start, -2), { placement_id: p.id });
      for (const d of CHECKINS) await put('placement.checkin', `placement.checkin:${p.id}:${d}`, addDays(start, d), { placement_id: p.id, day: d });
    }
    if (end) {
      await put('placement.extension', `placement.extension:${p.id}`, addDays(end, -30), { placement_id: p.id });
      await put('placement.ended', `placement.ended:${p.id}`, addDays(end, 1), { placement_id: p.id });
    }
    return keys;
  }
  async function placementContext(id) {
    const p = await one('SELECT * FROM placements WHERE id::text=$1', [String(id)]);
    if (!p) return null;
    const cand = p.candidate_id ? await one('SELECT * FROM candidates WHERE id::text=$1', [String(p.candidate_id)]) : null;
    const job = p.job_order_id ? await one('SELECT * FROM job_orders WHERE id::text=$1', [String(p.job_order_id)]) : null;
    return { p, cand, job, label: `${cand ? cand.name : 'Consultant'} at ${job ? job.company || job.title : 'client'}` };
  }
  async function placementTask(ctx, title, dueAt, extra = {}) {
    await pool.query('INSERT INTO activities (type, title, contact, account, candidate_id, account_id, status, due_at, created_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', ['Task', title, ctx.cand ? ctx.cand.name : null, ctx.job ? ctx.job.company : null, ctx.p.candidate_id == null ? null : String(ctx.p.candidate_id), ctx.job && ctx.job.account_id ? String(ctx.job.account_id) : null, 'pending', dueAt, ctx.p.created_by || null, extra.notes || null]).catch(() => {});
    await notifyOwners({ owners: [ctx.p.created_by], type: extra.type || 'placement.task', title, body: extra.body || '', entity_type: 'placement', entity_id: ctx.p.id, email: extra.email !== false });
  }

  const workers = {
    'sla.check': async (payload, job) => { const r = await slaCheck(); await events.enqueue('sla.check', {}, { runAt: new Date(Date.now() + Number(process.env.SLA_INTERVAL_MIN || 60) * 60000), dedupeKey: 'sla.check', maxAttempts: 2 }); return r; },
    'digest.weekly': async () => { const r = await sendDigest(); await events.enqueue('digest.weekly', {}, { runAt: nextWeekday(Number(process.env.DIGEST_WEEKDAY || 1), Number(process.env.DIGEST_HOUR || 8)), dedupeKey: 'digest.weekly', maxAttempts: 3 }); return r; },
    'maintenance.daily': async () => { const r = await maintenance(); await events.enqueue('maintenance.daily', {}, { runAt: new Date(Date.now() + DAY), dedupeKey: 'maintenance.daily', maxAttempts: 2 }); return r; },
    'placement.start_confirm': async ({ placement_id }) => { const ctx = await placementContext(placement_id); if (!ctx || !isActive(ctx.p)) return 'skipped'; await placementTask(ctx, `Confirm start: ${ctx.label} starts ${dateOnly(ctx.p.start_date).toLocaleDateString()}`, new Date(), { type: 'placement.start_confirm', body: 'Confirm the start date, first-day logistics and timesheet approver with the client and the consultant.' }); return 'task'; },
    'placement.checkin': async ({ placement_id, day }) => {
      const ctx = await placementContext(placement_id); if (!ctx || !isActive(ctx.p)) return 'skipped';
      await placementTask(ctx, `Day ${day} check-in: ${ctx.label}`, new Date(), { type: 'placement.checkin', body: `Call the consultant and the client manager. Log the outcome on the placement.`, email: day === 1 || day === 30 || day === 90 });
      if (process.env.PLACEMENT_CHECKIN_EMAIL === 'true' && ctx.cand && ctx.cand.email) await events.enqueue('email.send', { to: ctx.cand.email, subject: `How is it going at ${ctx.job ? ctx.job.company : 'your assignment'}?`, html: `<p>Hi ${esc(ctx.cand.name.split(' ')[0])},</p><p>You are ${day} day(s) into your assignment${ctx.job ? ` at ${esc(ctx.job.company)}` : ''}. Reply to this email with anything we should know: access, workload, pay, anything at all.</p><p>${esc(COMPANY)}</p>`, entity_type: 'placement', entity_id: ctx.p.id }, { dedupeKey: `placement.checkin.email:${ctx.p.id}:${day}` });
      return 'task';
    },
    'placement.extension': async ({ placement_id }) => { const ctx = await placementContext(placement_id); if (!ctx || !isActive(ctx.p)) return 'skipped'; await events.exception({ kind: 'placement.ending', entity_type: 'placement', entity_id: ctx.p.id, message: `${ctx.label} ends ${dateOnly(ctx.p.end_date).toLocaleDateString()}. Discuss an extension with the client now, or plan the roll-off.`, assigned_to: ctx.p.created_by }); await placementTask(ctx, `Extension decision: ${ctx.label} ends in 30 days`, new Date(), { type: 'placement.extension', body: 'Ask the client about extending. Update the placement end date if they extend.' }); return 'flagged'; },
    'placement.ended': async ({ placement_id }) => {
      const ctx = await placementContext(placement_id); if (!ctx) return 'gone';
      if (isActive(ctx.p)) {
        await pool.query("UPDATE placements SET placement_status='completed', updated_at=CURRENT_TIMESTAMP WHERE id::text=$1", [String(ctx.p.id)]);
        await events.record({ type: 'placement.completed', entity_type: 'placement', entity_id: ctx.p.id, payload: { end_date: ctx.p.end_date } });
      }
      await events.resolveOpen('placement.ending', 'placement', ctx.p.id, 'placement ended');
      if (ctx.cand) {
        await pool.query("UPDATE candidates SET status='available', availability='Available', updated_at=CURRENT_TIMESTAMP WHERE id::text=$1", [String(ctx.cand.id)]).catch(() => pool.query("UPDATE candidates SET status='available', updated_at=CURRENT_TIMESTAMP WHERE id::text=$1", [String(ctx.cand.id)]).catch(() => {}));
        // Re-match the bench candidate against every open job order.
        const open = await rows("SELECT * FROM job_orders WHERE COALESCE(status,'open') IN ('open','intake_pending') ORDER BY updated_at DESC LIMIT 25");
        const hits = [];
        for (const j of open) {
          try { const det = matching.deterministicScore(ctx.cand, matching.targetFromJobOrder(j)); if (det.score >= Number(process.env.REMATCH_MIN_SCORE || 55)) hits.push({ job_order_id: j.id, title: j.title, company: j.company, score: det.score }); } catch { /* */ }
        }
        hits.sort((a, b) => b.score - a.score);
        await events.record({ type: 'candidate.rematched', entity_type: 'candidate', entity_id: ctx.cand.id, payload: { hits: hits.slice(0, 5) } });
        await notifyOwners({ owners: [ctx.p.created_by], type: 'placement.ended', title: `${ctx.cand.name} is back on the bench`, body: hits.length ? `Placement ended. Possible fits: ${hits.slice(0, 3).map((h) => `${h.title} at ${h.company} (${h.score})`).join('; ')}.` : 'Placement ended. No open job order scores above the re-match threshold yet.', entity_type: 'candidate', entity_id: ctx.cand.id });
        return { hits: hits.length };
      }
      return 'completed';
    },
  };

  function bootstrap() {
    const soon = new Date(Date.now() + 60000);
    return Promise.all([
      events.enqueue('sla.check', {}, { runAt: soon, dedupeKey: 'sla.check', maxAttempts: 2 }),
      events.enqueue('digest.weekly', {}, { runAt: nextWeekday(Number(process.env.DIGEST_WEEKDAY || 1), Number(process.env.DIGEST_HOUR || 8)), dedupeKey: 'digest.weekly', maxAttempts: 3 }),
      events.enqueue('maintenance.daily', {}, { runAt: new Date(Date.now() + 5 * 60000), dedupeKey: 'maintenance.daily', maxAttempts: 2 }),
    ]).catch((e) => console.error('⚠️ watchdog bootstrap:', e.message));
  }

  // Routes
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); } };
  app.post('/api/sla/check', authenticateToken, wrap(async (req, res) => res.json(await slaCheck(req.body && req.body.now ? new Date(req.body.now) : new Date()))));
  app.get('/api/sla/rules', authenticateToken, (req, res) => res.json(SLA));
  app.get('/api/digest/preview', authenticateToken, wrap(async (req, res) => res.json(await buildDigest())));
  app.post('/api/digest/send', authenticateToken, requireAdmin, wrap(async (req, res) => res.json(await sendDigest({ to: req.body && req.body.to }))));
  app.post('/api/maintenance/run', authenticateToken, requireAdmin, wrap(async (req, res) => res.json(await maintenance(req.body && req.body.now ? new Date(req.body.now) : new Date()))));
  app.get('/api/placements/:id/schedule', authenticateToken, wrap(async (req, res) => { const id = String(req.params.id); const re = (k) => { const m = k.match(/^(placement|timesheet)[.][a-z_]+:([^:]+)(?::\d+)?$/); return !!m && m[2] === id; }; res.json((await rows("SELECT id, type, status, next_run_at, payload, dedupe_key FROM jobs WHERE dedupe_key LIKE $1 AND status='queued' ORDER BY next_run_at", [`%:${req.params.id}%`])).filter((j) => re(j.dedupe_key)).map((j) => ({ ...j, payload: parse(j.payload) }))); }));

  return { workers, bootstrap, slaCheck, buildDigest, sendDigest, maintenance, schedulePlacementJobs, SLA, businessDaysAgo };
}

module.exports = { install, businessDaysAgo, nextWeekday, SLA, SCHEMA: [
  `CREATE TABLE IF NOT EXISTS events_archive (id INTEGER, type VARCHAR(80), entity_type VARCHAR(40), entity_id TEXT, actor VARCHAR(120), txn_id VARCHAR(120), result VARCHAR(20), error TEXT, payload TEXT, created_at TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key VARCHAR(200) PRIMARY KEY, window_start TIMESTAMP, count INTEGER DEFAULT 0)`,
] };
