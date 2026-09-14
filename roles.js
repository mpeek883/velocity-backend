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

const PUBLIC_PREFIXES = ['/api/auth/', '/api/login', '/api/register', '/api/intake/', '/api/client/', '/api/esign/webhook', '/api/integrations/', '/api/setup/', '/api/health'];
const SELF_SERVICE = ['/api/users/me/password', '/api/notifications', '/api/ai/chat', '/api/logout'];

const ROLE_CAN_WRITE = { admin: true, recruiter: true, sales: true, viewer: false };
const PERMISSIONS = {
  admin: { write: true, manage_users: true, override_gates: true, label: 'Admin' },
  recruiter: { write: true, manage_users: false, override_gates: true, label: 'Recruiter' },
  sales: { write: true, manage_users: false, override_gates: true, label: 'Sales' },
  viewer: { write: false, manage_users: false, override_gates: false, label: 'Viewer (read-only)' },
};

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
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const p = req.path || '';
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
    next();
  };
  mw.roles = roles;
  return mw;
}

module.exports = { enforce, createRoleCache, PERMISSIONS, ROLE_CAN_WRITE, PUBLIC_PREFIXES };
