// Automation foundation: event log, audit trail, exception queue, durable
// job queue with retry/backoff, and idempotent transactions.
//
//   events        every significant status change or automated action, with
//                 trigger, actor, result and payload (the audit trail)
//   exceptions    things automation could not complete; a person resolves them
//   jobs          durable queue for work that may fail transiently (emails,
//                 reminders, e-signature status refresh); retried with backoff
//   transactions  transaction ids so a retried multi-step action never creates
//                 the same records twice
//
// Nothing here throws into the caller's flow: logging failures are swallowed so
// a broken log never blocks a placement.

const crypto = require('crypto');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    type VARCHAR(80) NOT NULL,
    entity_type VARCHAR(40),
    entity_id TEXT,
    actor VARCHAR(120),
    txn_id VARCHAR(120),
    result VARCHAR(20) DEFAULT 'ok',
    error TEXT,
    payload TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS exceptions (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(80) NOT NULL,
    entity_type VARCHAR(40),
    entity_id TEXT,
    message TEXT,
    details TEXT,
    status VARCHAR(20) DEFAULT 'open',
    assigned_to TEXT,
    resolved_by TEXT,
    resolution TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    type VARCHAR(80) NOT NULL,
    payload TEXT,
    dedupe_key VARCHAR(200),
    status VARCHAR(20) DEFAULT 'queued',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 6,
    next_run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,
    result TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    txn_id VARCHAR(120) PRIMARY KEY,
    status VARCHAR(20) DEFAULT 'started',
    steps TEXT,
    result TEXT,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
];

const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
const parse = (v) => { if (v == null || v === '') return null; try { return JSON.parse(v); } catch { return v; } };

class Events {
  constructor(pool) { this.pool = pool; this.handlers = {}; }

  async ensureSchema() { for (const sql of SCHEMA) { try { await this.pool.query(sql); } catch (e) { if (!/not supported|parts have not been read/i.test(e.message)) console.error('⚠️ events schema:', e.message.split('\n')[0]); } } }

  /** Record an event (the audit trail). Returns the row or null. */
  async record({ type, entity_type = null, entity_id = null, actor = 'system', txn_id = null, result = 'ok', error = null, payload = null }) {
    try {
      const q = await this.pool.query(
        'INSERT INTO events (type, entity_type, entity_id, actor, txn_id, result, error, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [type, entity_type, entity_id == null ? null : String(entity_id), String(actor), txn_id, result, error ? String(error).slice(0, 2000) : null, asText(payload)]);
      const row = q.rows[0];
      for (const h of this.handlers[type] || []) { try { await h(row); } catch (e) { console.error(`⚠️ event handler ${type}:`, e.message); } }
      return row;
    } catch (e) { console.error('⚠️ event not recorded:', type, e.message.split('\n')[0]); return null; }
  }
  on(type, handler) { (this.handlers[type] = this.handlers[type] || []).push(handler); }

  /** Something automation could not finish; a person picks it up from the exception queue. */
  async exception({ kind, entity_type = null, entity_id = null, message, details = null, assigned_to = null }) {
    try {
      // One open exception per kind + entity: repeats update the message instead of piling up.
      const existing = await this.pool.query("SELECT id FROM exceptions WHERE kind=$1 AND COALESCE(entity_type,'')=$2 AND COALESCE(entity_id,'')=$3 AND status='open' LIMIT 1", [kind, entity_type || '', entity_id == null ? '' : String(entity_id)]);
      if (existing.rows.length) {
        const q = await this.pool.query('UPDATE exceptions SET message=$1, details=$2 WHERE id=$3 RETURNING *', [message, asText(details), existing.rows[0].id]);
        return q.rows[0];
      }
      const q = await this.pool.query('INSERT INTO exceptions (kind, entity_type, entity_id, message, details, assigned_to) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [kind, entity_type, entity_id == null ? null : String(entity_id), message, asText(details), assigned_to == null ? null : String(assigned_to)]);
      await this.record({ type: 'exception.opened', entity_type, entity_id, payload: { kind, message } });
      return q.rows[0];
    } catch (e) { console.error('⚠️ exception not recorded:', kind, e.message.split('\n')[0]); return null; }
  }
  async resolveException(id, { by, resolution }) {
    const q = await this.pool.query("UPDATE exceptions SET status='resolved', resolved_by=$1, resolution=$2, resolved_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *", [by == null ? null : String(by), resolution || null, id]);
    if (q.rows[0]) await this.record({ type: 'exception.resolved', entity_type: q.rows[0].entity_type, entity_id: q.rows[0].entity_id, actor: `user:${by}`, payload: { kind: q.rows[0].kind, resolution } });
    return q.rows[0] || null;
  }
  async resolveOpen(kind, entity_type, entity_id, resolution = 'resolved automatically') {
    try { await this.pool.query("UPDATE exceptions SET status='resolved', resolution=$4, resolved_at=CURRENT_TIMESTAMP WHERE kind=$1 AND COALESCE(entity_type,'')=$2 AND COALESCE(entity_id,'')=$3 AND status='open'", [kind, entity_type || '', entity_id == null ? '' : String(entity_id), resolution]); } catch { /* best effort */ }
  }

  /** Queue durable work. dedupe_key prevents the same job being queued twice while one is pending. */
  async enqueue(type, payload = {}, { runAt = null, dedupeKey = null, maxAttempts = 6 } = {}) {
    try {
      if (dedupeKey) {
        const dup = await this.pool.query("SELECT id FROM jobs WHERE dedupe_key=$1 AND status IN ('queued','running') LIMIT 1", [dedupeKey]);
        if (dup.rows.length) return dup.rows[0];
      }
      const q = await this.pool.query('INSERT INTO jobs (type, payload, dedupe_key, next_run_at, max_attempts) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [type, asText(payload), dedupeKey, runAt ? new Date(runAt) : new Date(), maxAttempts]);
      return q.rows[0];
    } catch (e) { console.error('⚠️ job not queued:', type, e.message.split('\n')[0]); return null; }
  }
  async cancelJobs(dedupeKey) { try { await this.pool.query("UPDATE jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP WHERE dedupe_key=$1 AND status='queued'", [dedupeKey]); } catch { /* */ } }

  /** Run due jobs once. workers: { [type]: async (payload, job) => result }. Backoff: 1, 5, 15, 60, 240 minutes. */
  async runJobs(workers, { limit = 25, now = new Date() } = {}) {
    const out = { ran: 0, ok: 0, failed: 0, dead: 0 };
    let due;
    try { due = await this.pool.query("SELECT * FROM jobs WHERE status='queued' AND next_run_at <= $1 ORDER BY next_run_at, id LIMIT $2", [now, limit]); } catch (e) { return out; }
    for (const job of due.rows) {
      const worker = workers[job.type];
      out.ran += 1;
      if (!worker) { await this.pool.query("UPDATE jobs SET status='dead', last_error='no worker for this job type', finished_at=CURRENT_TIMESTAMP WHERE id=$1", [job.id]); out.dead += 1; continue; }
      await this.pool.query("UPDATE jobs SET status='running', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [job.id]);
      try {
        const result = await worker(parse(job.payload) || {}, job);
        await this.pool.query("UPDATE jobs SET status='done', result=$1, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [asText(result), job.id]);
        out.ok += 1;
      } catch (e) {
        const attempts = job.attempts + 1;
        const backoffMin = [1, 5, 15, 60, 240, 720][Math.min(attempts - 1, 5)];
        if (attempts >= job.max_attempts) {
          await this.pool.query("UPDATE jobs SET status='dead', last_error=$1, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [String(e.message).slice(0, 2000), job.id]);
          await this.exception({ kind: `job.${job.type}.failed`, entity_type: 'job', entity_id: job.id, message: `${job.type} gave up after ${attempts} attempts: ${e.message}`, details: parse(job.payload) });
          out.dead += 1;
        } else {
          await this.pool.query("UPDATE jobs SET status='queued', last_error=$1, next_run_at=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3", [String(e.message).slice(0, 2000), new Date(now.getTime() + backoffMin * 60000), job.id]);
          out.failed += 1;
        }
        await this.record({ type: `job.${job.type}`, entity_type: 'job', entity_id: job.id, result: 'error', error: e.message, payload: { attempt: attempts } });
      }
    }
    return out;
  }

  /**
   * Idempotent multi-step action. `steps` is an ordered list of { name, run(ctx) }.
   * Completed step results are stored under txn_id; a retry skips them and
   * continues from the first unfinished step, so records are never duplicated.
   */
  async transaction(txnId, steps, { actor = 'system', entity_type = null, entity_id = null } = {}) {
    let state = { steps: {}, status: 'started' };
    try {
      const cur = await this.pool.query('SELECT * FROM transactions WHERE txn_id=$1', [txnId]);
      if (cur.rows.length) {
        state = { steps: parse(cur.rows[0].steps) || {}, status: cur.rows[0].status };
        if (state.status === 'done') return { replayed: true, ...(parse(cur.rows[0].result) || {}), ctx: state.steps };
      } else {
        await this.pool.query('INSERT INTO transactions (txn_id, status, steps) VALUES ($1,$2,$3)', [txnId, 'started', '{}']);
      }
    } catch (e) { /* no transaction table: still run, just not idempotent */ }
    const ctx = { ...state.steps };
    for (const step of steps) {
      if (ctx[step.name] !== undefined) continue; // already done in an earlier attempt
      try {
        ctx[step.name] = (await step.run(ctx)) ?? true;
        await this.pool.query('UPDATE transactions SET steps=$1, updated_at=CURRENT_TIMESTAMP WHERE txn_id=$2', [JSON.stringify(ctx), txnId]).catch(() => {});
        await this.record({ type: `txn.step`, entity_type, entity_id, actor, txn_id: txnId, payload: { step: step.name } });
      } catch (e) {
        await this.pool.query("UPDATE transactions SET status='failed', error=$1, updated_at=CURRENT_TIMESTAMP WHERE txn_id=$2", [String(e.message).slice(0, 2000), txnId]).catch(() => {});
        await this.record({ type: 'txn.failed', entity_type, entity_id, actor, txn_id: txnId, result: 'error', error: e.message, payload: { step: step.name } });
        await this.exception({ kind: 'transaction.failed', entity_type, entity_id, message: `Step "${step.name}" of ${txnId} failed: ${e.message}. Retry the action; completed steps will not be repeated.`, details: { txn_id: txnId, step: step.name } });
        const err = new Error(`${step.name}: ${e.message}`); err.status = e.status || 500; err.txn_id = txnId; throw err;
      }
    }
    const result = { ok: true };
    await this.pool.query("UPDATE transactions SET status='done', result=$1, updated_at=CURRENT_TIMESTAMP WHERE txn_id=$2", [JSON.stringify(result), txnId]).catch(() => {});
    await this.resolveOpen('transaction.failed', entity_type, entity_id, 'completed on retry');
    return { replayed: false, ...result, ctx };
  }

  static token(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
}

module.exports = { Events, SCHEMA, parse };
