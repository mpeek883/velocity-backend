// Fuzzy duplicate detection: review, never block. "Jon Smith" and
// "Jonathan Smith" at the same company become a duplicate.review exception
// with a merge / not-a-duplicate decision for a person.

const NICKNAMES = {
  jon: 'jonathan', john: 'john', jonny: 'jonathan', mike: 'michael', mikey: 'michael', bill: 'william', will: 'william', billy: 'william', bob: 'robert', rob: 'robert', bobby: 'robert', robbie: 'robert',
  dick: 'richard', rick: 'richard', ricky: 'richard', rich: 'richard', jim: 'james', jimmy: 'james', jamie: 'james', tom: 'thomas', tommy: 'thomas', dave: 'david', davey: 'david', dan: 'daniel', danny: 'daniel',
  matt: 'matthew', andy: 'andrew', drew: 'andrew', tony: 'anthony', joe: 'joseph', joey: 'joseph', steve: 'steven', stephen: 'steven', ed: 'edward', eddie: 'edward', ted: 'edward', ben: 'benjamin', benny: 'benjamin',
  sam: 'samuel', sammy: 'samuel', liz: 'elizabeth', beth: 'elizabeth', betty: 'elizabeth', eliza: 'elizabeth', kate: 'katherine', katie: 'katherine', kathy: 'katherine', kat: 'katherine', catherine: 'katherine',
  sue: 'susan', suzy: 'susan', peggy: 'margaret', maggie: 'margaret', meg: 'margaret', jen: 'jennifer', jenny: 'jennifer', nick: 'nicholas', alex: 'alexander', pat: 'patrick', chuck: 'charles', charlie: 'charles',
  greg: 'gregory', jeff: 'jeffrey', geoff: 'jeffrey', ken: 'kenneth', kenny: 'kenneth', larry: 'lawrence', ron: 'ronald', ronnie: 'ronald', don: 'donald', donny: 'donald', ray: 'raymond', frank: 'francis',
  fred: 'frederick', hank: 'henry', harry: 'henry', jerry: 'gerald', terry: 'terrence', tim: 'timothy', timmy: 'timothy', vince: 'vincent', walt: 'walter', zack: 'zachary', zach: 'zachary',
  abby: 'abigail', allie: 'alison', becky: 'rebecca', cathy: 'catherine', chris: 'christopher', debbie: 'deborah', deb: 'deborah', ellie: 'eleanor', jess: 'jessica', jessie: 'jessica', kim: 'kimberly',
  mandy: 'amanda', nikki: 'nicole', pam: 'pamela', patty: 'patricia', trish: 'patricia', sandy: 'sandra', steph: 'stephanie', tina: 'christina', vicky: 'victoria', priya: 'priya', sam_f: 'samantha',
};
const COMPANY_NOISE = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|group|holdings|the|technologies|technology|solutions|services|staffing|consulting)\b/g;

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@. ]+/g, ' ').replace(/\s+/g, ' ').trim();
function normalizePerson(name) {
  const parts = clean(name).replace(/[.]/g, '').split(' ').filter(Boolean);
  if (!parts.length) return { full: '', first: '', last: '' };
  const first = NICKNAMES[parts[0]] || parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return { full: [first, ...parts.slice(1)].join(' '), first, last };
}
function normalizeCompany(name) { return clean(name).replace(COMPANY_NOISE, ' ').replace(/[.]/g, '').replace(/\s+/g, ' ').trim(); }
function domainOf(v) { const s = clean(v); if (!s) return ''; if (s.includes('@')) return s.split('@')[1]; return s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }
const digits = (v) => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

/** Jaro-Winkler similarity, 0..1. */
function jaroWinkler(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const m = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) { for (let j = Math.max(0, i - m); j < Math.min(b.length, i + m + 1); j++) { if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; } } }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) { if (!am[i]) continue; while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let l = 0; while (l < 4 && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

/** Score two person-like rows (leads, contacts, candidates). Returns { score, reason } or null. */
function personSimilarity(a, b) {
  const ea = clean(a.email), eb = clean(b.email);
  if (ea && eb && ea === eb) return { score: 1, reason: 'same email' };
  const na = normalizePerson(a.name), nb = normalizePerson(b.name);
  if (!na.full || !nb.full) return null;
  const nameSim = jaroWinkler(na.full, nb.full);
  const lastEq = na.last && na.last === nb.last;
  const firstSim = jaroWinkler(na.first, nb.first);
  const pa = digits(a.phone), pb = digits(b.phone);
  if (pa && pb && pa === pb && (nameSim >= 0.6 || lastEq)) return { score: 0.95, reason: 'same phone and similar name' };
  const ca = normalizeCompany(a.company), cb = normalizeCompany(b.company);
  const companyEq = ca && cb && (ca === cb || jaroWinkler(ca, cb) >= 0.92);
  const strongName = nameSim >= 0.92 || (lastEq && firstSim >= 0.85);
  if (strongName && companyEq) return { score: 0.92, reason: 'same name and company' };
  if (strongName && ea && eb && domainOf(ea) === domainOf(eb)) return { score: 0.9, reason: 'same name and email domain' };
  if (strongName) return { score: 0.75, reason: 'same or nickname-equivalent name' };
  if (lastEq && firstSim >= 0.7 && companyEq) return { score: 0.72, reason: 'similar name at the same company' };
  return null;
}
function accountSimilarity(a, b) {
  const da = domainOf(a.website), db = domainOf(b.website);
  if (da && db && da === db) return { score: 0.95, reason: 'same website' };
  const na = normalizeCompany(a.name), nb = normalizeCompany(b.name);
  if (!na || !nb) return null;
  const sim = jaroWinkler(na, nb);
  if (na === nb) return { score: 0.9, reason: 'same name ignoring Inc/LLC/Corp' };
  if (sim >= 0.93) return { score: 0.8, reason: 'very similar name' };
  return null;
}

const THRESHOLD = Number(process.env.DEDUPE_THRESHOLD || 0.7);
const ENTITY = { leads: 'lead', contacts: 'contact', candidates: 'candidate', accounts: 'account' };

async function findFuzzyDuplicates(pool, table, row, { limit = 5 } = {}) {
  const sim = table === 'accounts' ? accountSimilarity : personSimilarity;
  let rows;
  try { rows = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows; } catch { return []; }
  let dismissed = [];
  try { dismissed = (await pool.query('SELECT id_a, id_b FROM duplicate_dismissals WHERE table_name=$1', [table])).rows; } catch { /* */ }
  const dis = new Set(dismissed.map((d) => `${d.id_a}|${d.id_b}`));
  const out = [];
  for (const r of rows) {
    if (String(r.id) === String(row.id)) continue;
    if (dis.has(`${row.id}|${r.id}`) || dis.has(`${r.id}|${row.id}`)) continue;
    // Leads: the same recruiter with a different role is a separate lead by design.
    if (table === 'leads' && clean(r.email) === clean(row.email) && clean(r.job_title) !== clean(row.job_title)) continue;
    const s = sim(row, r);
    if (s && s.score >= THRESHOLD) out.push({ id: r.id, name: r.name, email: r.email || null, company: r.company || null, score: s.score, reason: s.reason });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** After a create: open a duplicate.review exception when the new row looks like an existing one. */
async function reviewRecord(pool, events, table, row) {
  if (!row || !ENTITY[table]) return null;
  const matches = await findFuzzyDuplicates(pool, table, row);
  if (!matches.length) return null;
  const top = matches[0];
  return events.exception({ kind: 'duplicate.review', entity_type: ENTITY[table], entity_id: row.id, message: `${row.name} may duplicate ${top.name}${top.company ? ` (${top.company})` : ''}: ${top.reason}. Merge or mark as not a duplicate.`, details: { table, record: { id: row.id, name: row.name, email: row.email || null, company: row.company || null }, matches } });
}

const CHILD_LINKS = {
  candidates: [['submissions', 'candidate_id'], ['placements', 'candidate_id'], ['candidate_matches', 'candidate_id'], ['candidate_outreach', 'candidate_id'], ['activities', 'candidate_id'], ['signature_requests', 'candidate_id'], ['client_links', 'candidate_id'], ['offers', 'candidate_id'], ['timesheets', 'candidate_id'], ['candidate_profiles', 'candidate_id']],
  contacts: [['activities', 'contact_id']],
  accounts: [['opportunities', 'account_id'], ['leads', 'account_id'], ['contacts', 'account_id'], ['job_orders', 'account_id'], ['activities', 'account_id'], ['intake_links', 'account_id'], ['signature_requests', 'account_id'], ['timesheets', 'account_id'], ['invoices', 'account_id'], ['contracts', 'account_id']],
  leads: [['lead_emails', 'lead_id'], ['activities', 'lead_id'], ['opportunities', 'lead_id'], ['job_orders', 'lead_id'], ['intake_links', 'lead_id']],
};
const FILL_COLS = { candidates: ['email', 'phone', 'title', 'company', 'location', 'skills', 'linkedin', 'work_auth', 'resume_text', 'notes'], contacts: ['email', 'phone', 'company', 'title', 'skills', 'notes'], accounts: ['industry', 'website', 'billing_contact', 'city', 'state', 'description', 'size', 'tier'], leads: ['email', 'phone', 'company', 'title', 'linkedin', 'job_description', 'rate_or_salary', 'job_location', 'end_client', 'notes'] };

/** Merge `removeId` into `keepId`: re-point children, fill blanks on the kept row, delete the duplicate. */
async function mergeRecords(pool, events, table, keepId, removeId, { actor = 'system' } = {}) {
  if (!ENTITY[table]) throw Object.assign(new Error('table must be leads, contacts, candidates or accounts'), { status: 400 });
  if (String(keepId) === String(removeId)) throw Object.assign(new Error('keep and remove must differ'), { status: 400 });
  const keep = (await pool.query(`SELECT * FROM ${table} WHERE id::text=$1`, [String(keepId)])).rows[0];
  const remove = (await pool.query(`SELECT * FROM ${table} WHERE id::text=$1`, [String(removeId)])).rows[0];
  if (!keep || !remove) throw Object.assign(new Error('Record not found'), { status: 404 });
  const repointed = {};
  for (const [child, col] of CHILD_LINKS[table]) {
    try { const q = await pool.query(`UPDATE ${child} SET ${col}=$1 WHERE ${col}::text=$2 RETURNING id`, [String(keep.id), String(remove.id)]); if (q.rows.length) repointed[child] = q.rows.length; } catch { /* table or column may not exist */ }
  }
  // Mirrored contacts: the duplicate's own contact row goes away with it.
  if (table === 'candidates' || table === 'leads') { try { await pool.query(`DELETE FROM contacts WHERE ${table === 'candidates' ? 'candidate_id' : 'lead_id'}::text=$1`, [String(remove.id)]); } catch { /* */ } }
  const fills = {};
  for (const c of FILL_COLS[table]) if ((keep[c] == null || keep[c] === '') && remove[c] != null && remove[c] !== '') fills[c] = remove[c];
  if (Object.keys(fills).length) {
    const cols = Object.keys(fills);
    await pool.query(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')} WHERE id::text=$${cols.length + 1}`, [...cols.map((c) => fills[c]), String(keep.id)]).catch(() => {});
  }
  await pool.query(`DELETE FROM ${table} WHERE id::text=$1`, [String(remove.id)]);
  await events.record({ type: 'duplicate.merged', entity_type: ENTITY[table], entity_id: keep.id, actor, payload: { removed: { id: remove.id, name: remove.name }, repointed, filled: Object.keys(fills) } });
  await events.resolveOpen('duplicate.review', ENTITY[table], remove.id, 'merged');
  await events.resolveOpen('duplicate.review', ENTITY[table], keep.id, 'merged');
  return { kept: (await pool.query(`SELECT * FROM ${table} WHERE id::text=$1`, [String(keep.id)])).rows[0], removed: remove.id, repointed, filled: Object.keys(fills) };
}

async function dismissPair(pool, events, table, idA, idB, { actor = 'system' } = {}) {
  try { await pool.query('INSERT INTO duplicate_dismissals (table_name, id_a, id_b, dismissed_by) VALUES ($1,$2,$3,$4)', [table, String(idA), String(idB), actor]); } catch { /* */ }
  await events.record({ type: 'duplicate.dismissed', entity_type: ENTITY[table], entity_id: idA, actor, payload: { other: idB } });
}

/** Backfill: review every row of a table (bounded). */
async function scanTable(pool, events, table, { max = 2000 } = {}) {
  const rows = (await pool.query(`SELECT * FROM ${table} ORDER BY id LIMIT $1`, [max])).rows;
  let flagged = 0; const seen = new Set();
  for (const r of rows) {
    const matches = await findFuzzyDuplicates(pool, table, r, { limit: 3 });
    const fresh = matches.filter((m) => !seen.has(`${m.id}|${r.id}`));
    if (!fresh.length) continue;
    for (const m of fresh) seen.add(`${r.id}|${m.id}`);
    const top = fresh[0];
    await events.exception({ kind: 'duplicate.review', entity_type: ENTITY[table], entity_id: r.id, message: `${r.name} may duplicate ${top.name}${top.company ? ` (${top.company})` : ''}: ${top.reason}. Merge or mark as not a duplicate.`, details: { table, record: { id: r.id, name: r.name, email: r.email || null, company: r.company || null }, matches: fresh } });
    flagged += 1;
  }
  return { scanned: rows.length, flagged };
}

const SCHEMA = ['CREATE TABLE IF NOT EXISTS duplicate_dismissals (id SERIAL PRIMARY KEY, table_name VARCHAR(40), id_a TEXT, id_b TEXT, dismissed_by VARCHAR(120), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'];

module.exports = { jaroWinkler, normalizePerson, normalizeCompany, personSimilarity, accountSimilarity, findFuzzyDuplicates, reviewRecord, mergeRecords, dismissPair, scanTable, SCHEMA, ENTITY, THRESHOLD };
