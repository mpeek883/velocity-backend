// Fair, automatic lead assignment.
//
// Eligible team members are active users who take leads. A new lead goes to
// the member with the FEWEST open leads; ties go to whoever was assigned a
// lead least recently (a rotating round-robin). Nobody can be skipped or
// favored by timing, and manual reassignment is always possible.

const OPEN_WORKFLOW = ['new', 'reviewed', 'replied', 'awaiting_info', 'interested'];

async function listTeam(pool) {
  const q = await pool.query('SELECT id, email, name, role, is_active, takes_leads, can_personal_reply, last_assigned_at FROM users ORDER BY name, id');
  const loads = await pool.query(
    `SELECT assigned_to, COUNT(*) AS open_leads FROM leads
      WHERE assigned_to IS NOT NULL AND COALESCE(workflow_status,'new') = ANY($1) AND COALESCE(status,'new') <> 'unqualified'
      GROUP BY assigned_to`, [OPEN_WORKFLOW]);
  const byUser = new Map(loads.rows.map((r) => [String(r.assigned_to), parseInt(r.open_leads, 10)]));
  return q.rows.map((u) => ({
    ...u,
    is_active: u.is_active !== false,
    takes_leads: u.takes_leads !== false,
    open_leads: byUser.get(String(u.id)) || 0,
  }));
}

/** Choose the next assignee, or null when nobody is eligible. */
async function pickAssignee(pool) {
  const team = (await listTeam(pool)).filter((u) => u.is_active && u.takes_leads);
  if (!team.length) return null;
  team.sort((a, b) =>
    a.open_leads - b.open_leads ||
    (a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0) - (b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0) ||
    String(a.id).localeCompare(String(b.id)));
  return team[0];
}

async function assignLead(pool, lead, userId = null) {
  let user = null;
  if (userId) {
    const q = await pool.query('SELECT id, email, name FROM users WHERE id::text=$1', [String(userId)]);
    if (!q.rows.length) throw Object.assign(new Error('User not found'), { status: 404 });
    user = q.rows[0];
  } else {
    user = await pickAssignee(pool);
    if (!user) return { lead, user: null, reason: 'no eligible team members' };
  }
  const now = new Date();
  const upd = await pool.query('UPDATE leads SET assigned_to=$1, assigned_at=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *', [String(user.id), now, String(lead.id)]);
  await pool.query('UPDATE users SET last_assigned_at=$1 WHERE id::text=$2', [now, String(user.id)]);
  return { lead: upd.rows[0], user };
}

/** Assign every unassigned lead, spreading them fairly. */
async function assignUnassigned(pool) {
  const q = await pool.query("SELECT * FROM leads WHERE assigned_to IS NULL AND COALESCE(status,'new') <> 'unqualified' ORDER BY created_at, id");
  const result = { assigned: 0, skipped: 0, by_user: {} };
  for (const lead of q.rows) {
    const r = await assignLead(pool, lead);
    if (r.user) { result.assigned += 1; result.by_user[r.user.name || r.user.email] = (result.by_user[r.user.name || r.user.email] || 0) + 1; }
    else result.skipped += 1;
  }
  return result;
}

module.exports = { listTeam, pickAssignee, assignLead, assignUnassigned, OPEN_WORKFLOW };
