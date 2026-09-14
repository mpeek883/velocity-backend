// Role enforcement for every write on the API.
//
//   admin      everything, including user administration
//   recruiter  every record write
//   sales      every record write
//   viewer     read-only: any POST/PUT/PATCH/DELETE is refused with 403
//
// The JWT only carries id + email, so the role is looked up from the users
// table and cached briefly. Public endpoints (login, intake / client-review
// links, e-signature webhooks) are never gated here.

const PUBLIC_PREFIXES = ['/api/auth/', '/api/login', '/api/register', '/api/intake/', '/api/client/', '/api/candidate/', '/api/feedback/', '/api/timesheet/', '/api/timesheet-approval/', '/api/quickbooks/callback', '/api/esign/webhook', '/api/integrations/', '/api/setup/', '/api/health'];
const SELF_SERVICE = ['/api/users/me/password', '/api/notifications', '/api/ai/chat', '/api/logout'];

const ROLE_CAN_WRITE = { admin: true, recruiter: true, sales: true, viewer: false };
const PERMISSIONS = {
  admin: { write: true, manage_users: true, override_gates: true, label: 'Admin' },
  recruiter: { write: true, manage_users: false, override_gates: true, label: 'Recruiter' },
  sales: { write: true, manage_users: false, override_gates: true, label: 'Sales' },
  viewer: { write: false, manage_users: false, override_gates: false, label: 'Viewer (read-only)' },
};
// Write paths each non-admin role may NOT touch. Everything else a writing role can write.
const DENY = {
  sales: [/^\/api\/(candidates|submissions|placements|timesheets|interviews|offers|invoices|outreach|sourcing)(\/|$)/, /^\/api\/job-orders\/[^/]+\/outreach/, /^\/api\/esign\/requests$/],
  recruiter: [/^\/api\/invoices\/[^/]+\/(mark-paid|push)$/, /^\/api\/quickbooks\/(connect|connection)(\/|$)/, /^\/api\/digest\/send/, /^\/api\/maintenance/, /^\/api\/duplicates\/scan/],
  viewer: [/^\/api\//],
};
// Human-readable matrix for the Users & Roles screen.
const MATRIX = {
  admin: { label: 'Admin', can: ['Everything', 'Add users and change roles', 'Edit or delete any record', 'QuickBooks connection, invoices, digests, maintenance'] },
  recruiter: { label: 'Recruiter', can: ['Leads, opportunities, accounts, contacts, activities', 'Candidates, job orders, submissions, interviews, offers, placements', 'Client links, outreach, e-signature, timesheets', 'Edit or delete only records they own (assigned or created)'], cannot: ['See leads assigned to others, or submissions and placements created by others', 'Users & roles', 'QuickBooks connection, marking invoices paid', 'Weekly digest and maintenance runs'] },
  sales: { label: 'Sales', can: ['Leads, opportunities, accounts, contacts, activities, contracts', 'Job orders and client intake', 'NDA and SOW e-signature', 'Edit or delete only records they own'], cannot: ['See leads assigned to others, or submissions and placements created by others', 'Candidates, submissions, interviews, offers, placements, outreach', 'Timesheets and invoices', 'Users & roles'] },
  viewer: { label: 'Viewer', can: ['Read every screen'], cannot: ['Any change'] },
};
// Record ownership: non-admins can only change records they own (when an owner is set).
const OWNED = { leads: ['leads', 'assigned_to'], activities: ['activities', 'created_by'], submissions: ['submissions', 'created_by'], 'job-orders': ['job_orders', 'created_by'], placements: ['placements', 'created_by'] };
const OWNED_RE = /^\/api\/(leads|activities|submissions|job-orders|placements)\/([^/]+)(\/assign)?$/;
// Hard visibility scoping (SCOPE_MODE!=off): recruiters and sales see only the
// leads assigned to them and the submissions / placements they created.
// Admins and viewers see everything; reports and dashboards stay team-wide.
const SCOPED = { leads: ['leads', 'assigned_to'], submissions: ['submissions', 'created_by'], placements: ['placements', 'created_by'] };
const SCOPED_LIST_RE = /^\/api\/(leads|submissions|placements)\/?$/;
const SCOPED_ITEM_RE = /^\/api\/(leads|submissions|placements)\/([^/]+)(\/.*)?$/;
const SCOPE_ROLES = ['recruiter', 'sales'];

function createRoleCache(pool, ttlMs = 60000) {
  const cache = new Map();
  return {
    async roleFor(userId) {
      const key = String(userId);
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) return hit.role;
      let role = 'recruiter';
      try {
        const q = await pool.query('SELECT role, is_active FROM users WHERE id::text=$1', [key]);
        if (q.rows.length) {
          if (q.rows[0].is_active === false) role = 'inactive';
          else if (q.rows[0].role) role = q.rows[0].role;
          else {
            // Legacy row with no role: the first user is the admin.
            const first = await pool.query('SELECT MIN(id) AS id FROM users');
            role = String(first.rows[0].id) === key ? 'admin' : 'recruiter';
          }
        }
      } catch { /* default */ }
      cache.set(key, { role, until: Date.now() + ttlMs });
      return role;
    },
    forget(userId) { cache.delete(String(userId)); },
    clear() { cache.clear(); },
  };
}

function enforce({ pool, jwt, secret, cache }) {
  const roles = cache || createRoleCache(pool);
  const mw = async (req, res, next) => {
    const p = req.path || '';
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.method !== 'GET' || process.env.SCOPE_MODE === 'off' || !(SCOPED_LIST_RE.test(p) || SCOPED_ITEM_RE.test(p))) return next();
      const auth = req.headers['authorization']; const token = auth && auth.split(' ')[1];
      if (!token) return next();
      let user; try { user = jwt.verify(token, typeof secret === 'function' ? secret() : secret); } catch { return next(); }
      const role = await roles.roleFor(user.id);
      req.userRole = role;
      if (!SCOPE_ROLES.includes(role)) return next();
      const lm = p.match(SCOPED_LIST_RE);
      if (lm) { req.scopeOwner = { table: SCOPED[lm[1]][0], column: SCOPED[lm[1]][1], user_id: String(user.id) }; return next(); }
      const im = p.match(SCOPED_ITEM_RE);
      if (im) {
        const [table, col] = SCOPED[im[1]];
        try {
          const q = await pool.query(`SELECT ${col} AS owner FROM ${table} WHERE id::text=$1`, [String(im[2])]);
          const owner = q.rows.length ? q.rows[0].owner : null;
          if (owner != null && String(owner) !== String(user.id)) return res.status(403).json({ error: 'This record belongs to another team member.', code: 'NOT_OWNER' });
        } catch { /* not a record id (e.g. /api/leads/scan): allow */ }
      }
      return next();
    }
    if (!p.startsWith('/api/')) return next();
    if (PUBLIC_PREFIXES.some((x) => p.startsWith(x)) || SELF_SERVICE.some((x) => p.startsWith(x))) return next();
    const auth = req.headers['authorization'];
    const token = auth && auth.split(' ')[1];
    if (!token) return next(); // the route's own authenticateToken answers 401
    let user;
    try { user = jwt.verify(token, typeof secret === 'function' ? secret() : secret); } catch { return next(); }
    const role = await roles.roleFor(user.id);
    if (role === 'inactive') return res.status(403).json({ error: 'This account has been deactivated', code: 'INACTIVE' });
    if (ROLE_CAN_WRITE[role] === false) return res.status(403).json({ error: 'Your role is read-only. Ask an admin for recruiter or sales access to make changes.', code: 'READ_ONLY_ROLE', role });
    req.userRole = role;
    if (role !== 'admin') {
      if ((DENY[role] || []).some((re) => re.test(p))) return res.status(403).json({ error: `Your role (${role}) cannot change this. ${role === 'sales' ? 'Candidate, submission and placement changes belong to recruiters.' : 'Ask an admin.'}`, code: 'ROLE_DENIED', role });
      const m = p.match(OWNED_RE);
      if (m && process.env.OWNERSHIP_MODE !== 'off' && (['PUT', 'DELETE', 'PATCH'].includes(req.method) || m[3])) {
        const [table, col] = OWNED[m[1]];
        try {
          const q = await pool.query(`SELECT ${col} AS owner FROM ${table} WHERE id::text=$1`, [String(m[2])]);
          const owner = q.rows.length ? q.rows[0].owner : null;
          if (owner != null && String(owner) !== String(user.id)) return res.status(403).json({ error: 'This record belongs to another team member. Ask them or an admin to change it.', code: 'NOT_OWNER' });
        } catch { /* unknown column (legacy schema): allow */ }
      }
    }
    next();
  };
  mw.roles = roles;
  return mw;
}

module.exports = { enforce, createRoleCache, PERMISSIONS, ROLE_CAN_WRITE, PUBLIC_PREFIXES, DENY, MATRIX, OWNED, SCOPED, SCOPE_ROLES };
