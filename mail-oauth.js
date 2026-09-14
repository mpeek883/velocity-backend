// Direct mailbox integrations (OAuth) for the lead scanner.
//
//   Google  : Gmail API, scope gmail.readonly (+ email to learn the address)
//   Microsoft: Graph delegated Mail.Read (+ offline_access, User.Read)
//
// Tokens are stored in the mail_connections table; a refresh token lets the
// scheduler read the mailbox without anyone signing in again. No account
// passwords are ever involved.
//
// Environment (API service):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth client (Web application) from Google Cloud Console
//   MS_CLIENT_ID / MS_CLIENT_SECRET           existing app registration; add the redirect URI and
//                                             delegated Mail.Read + offline_access + User.Read
//   MS_OAUTH_TENANT                           'common' for personal + any work account (default MS_TENANT_ID)
//   API_PUBLIC_URL                            https://velocitycrm-api.onrender.com (redirect base)
//   APP_URL                                   https://velocity-i5hx.onrender.com (where to return the user)

const jwt = require('jsonwebtoken');

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://velocitycrm-api.onrender.com').replace(/\/$/, '');
const APP_URL = (process.env.APP_URL || 'https://velocity-i5hx.onrender.com').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const PROVIDERS = {
  google: {
    label: 'Gmail',
    configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    label: 'Outlook / Microsoft 365',
    configured: () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
    scopes: 'offline_access User.Read Mail.Read',
    authUrl: () => `https://login.microsoftonline.com/${process.env.MS_OAUTH_TENANT || process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${process.env.MS_OAUTH_TENANT || process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    clientId: () => process.env.MS_CLIENT_ID,
    clientSecret: () => process.env.MS_CLIENT_SECRET,
  },
};
const redirectUri = (provider) => `${API_PUBLIC_URL}/api/integrations/${provider}/callback`;
const resolve = (v) => (typeof v === 'function' ? v() : v);

function providerStatus() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({ provider: key, label: p.label, configured: p.configured(), redirect_uri: redirectUri(key), scopes: p.scopes }));
}

/** URL the browser should open to connect a mailbox. state carries the user id. */
function buildAuthUrl(provider, userId) {
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error('Unknown provider'), { status: 400 });
  if (!p.configured()) throw Object.assign(new Error(`${p.label} is not configured on the API service (client id/secret missing)`), { status: 503 });
  const state = jwt.sign({ uid: String(userId), provider, purpose: 'mail-connect' }, JWT_SECRET, { expiresIn: '15m' });
  const url = new URL(resolve(p.authUrl));
  url.searchParams.set('client_id', resolve(p.clientId));
  url.searchParams.set('redirect_uri', redirectUri(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scopes);
  url.searchParams.set('state', state);
  if (provider === 'google') { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); }
  if (provider === 'microsoft') url.searchParams.set('response_mode', 'query');
  return url.toString();
}

async function tokenRequest(provider, params, fetchImpl = global.fetch) {
  const p = PROVIDERS[provider];
  const resp = await fetchImpl(resolve(p.tokenUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: resolve(p.clientId), client_secret: resolve(p.clientSecret), ...params }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(`${p.label} token request failed: ${data.error_description || data.error || resp.status}`);
  return data;
}

async function whoAmI(provider, accessToken, fetchImpl = global.fetch) {
  if (provider === 'google') {
    const r = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gmail profile lookup failed (${r.status}): ${(d.error && d.error.message) || ''}`);
    return d.emailAddress;
  }
  const r = await fetchImpl('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Microsoft profile lookup failed (${r.status}): ${(d.error && d.error.message) || ''}`);
  return d.mail || d.userPrincipalName;
}

/** Exchange the callback code, learn the mailbox address, and store the connection. */
async function completeConnection(pool, { provider, code, state }, fetchImpl = global.fetch) {
  let claims;
  try { claims = jwt.verify(state, JWT_SECRET); } catch { throw Object.assign(new Error('Connection request expired or invalid; start again from Settings'), { status: 400 }); }
  if (claims.purpose !== 'mail-connect' || claims.provider !== provider) throw Object.assign(new Error('State mismatch'), { status: 400 });
  const tok = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(provider) }, fetchImpl);
  const address = (await whoAmI(provider, tok.access_token, fetchImpl) || '').toLowerCase();
  if (!address) throw new Error('Could not determine the mailbox address');
  if (!tok.refresh_token) {
    // Google only returns a refresh token on the first consent; if it is missing keep any stored one.
    const prev = await pool.query('SELECT refresh_token FROM mail_connections WHERE provider=$1 AND address=$2', [provider, address]);
    tok.refresh_token = prev.rows[0] && prev.rows[0].refresh_token;
    if (!tok.refresh_token) throw new Error('No refresh token returned. Remove the app from your account\'s third-party access list and connect again.');
  }
  const expires = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  const q = await pool.query(
    `INSERT INTO mail_connections (provider, address, refresh_token, access_token, expires_at, scopes, connected_by, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'connected',NULL)
     ON CONFLICT (provider, address) DO UPDATE SET refresh_token=EXCLUDED.refresh_token, access_token=EXCLUDED.access_token, expires_at=EXCLUDED.expires_at,
       scopes=EXCLUDED.scopes, connected_by=EXCLUDED.connected_by, status='connected', last_error=NULL, updated_at=CURRENT_TIMESTAMP
     RETURNING id, provider, address, status, created_at`,
    [provider, address, tok.refresh_token, tok.access_token, expires, tok.scope || PROVIDERS[provider].scopes, claims.uid]);
  return q.rows[0];
}

/** A valid access token for a stored connection (refreshing when needed). */
async function accessTokenFor(pool, conn, fetchImpl = global.fetch) {
  if (conn.access_token && conn.expires_at && new Date(conn.expires_at).getTime() - Date.now() > 2 * 60 * 1000) return conn.access_token;
  const tok = await tokenRequest(conn.provider, { grant_type: 'refresh_token', refresh_token: conn.refresh_token, ...(conn.provider === 'microsoft' ? { scope: PROVIDERS.microsoft.scopes } : {}) }, fetchImpl);
  const expires = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  await pool.query('UPDATE mail_connections SET access_token=$1, expires_at=$2, refresh_token=COALESCE($3, refresh_token), status=\'connected\', last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$4',
    [tok.access_token, expires, tok.refresh_token || null, conn.id]);
  return tok.access_token;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
const b64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function gmailBodyText(payload) {
  const parts = []; const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); }; walk(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body && p.body.data);
  if (plain) return b64url(plain.body.data);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body && p.body.data);
  return html ? htmlToText(b64url(html.body.data)) : '';
}

/** Gmail API: recent inbox messages in the scanner's message shape. */
async function fetchGmailMessages(pool, conn, { since, max = 50 } = {}, fetchImpl = global.fetch) {
  const token = await accessTokenFor(pool, conn, fetchImpl);
  const H = { Authorization: `Bearer ${token}` };
  const d = new Date(since || Date.now() - 14 * 86400000);
  const q = `in:inbox -in:spam -in:trash after:${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const ids = []; let pageToken = null;
  while (ids.length < max) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', q); url.searchParams.set('maxResults', String(Math.min(100, max - ids.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetchImpl(url.toString(), { headers: H });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gmail list failed (${r.status}): ${(data.error && data.error.message) || ''}`);
    for (const m of data.messages || []) ids.push(m.id);
    pageToken = data.nextPageToken;
    if (!pageToken || !(data.messages || []).length) break;
  }
  const out = [];
  for (const id of ids) {
    const r = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: H });
    const m = await r.json().catch(() => ({}));
    if (!r.ok) continue;
    const h = (name) => ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    const from = (h('From') || {}).value || '';
    const fm = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    out.push({
      message_id: (h('Message-ID') || {}).value || m.id,
      subject: (h('Subject') || {}).value || '',
      from_name: fm ? fm[1].trim() : '',
      from_email: (fm ? fm[2] : from).trim().toLowerCase(),
      received_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      text: gmailBodyText(m.payload) || m.snippet || '',
    });
  }
  return out;
}

/** Graph (delegated): the connected user's own inbox. */
async function fetchOutlookMessages(pool, conn, { since, max = 50 } = {}, fetchImpl = global.fetch) {
  const token = await accessTokenFor(pool, conn, fetchImpl);
  const out = []; let url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$top', String(Math.min(max, 100)));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$select', 'id,internetMessageId,subject,from,receivedDateTime,body,bodyPreview');
  if (since) url.searchParams.set('$filter', `receivedDateTime ge ${new Date(since).toISOString()}`);
  url = url.toString();
  while (url && out.length < max) {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Outlook read failed (${r.status}): ${(data.error && data.error.message) || r.statusText}`);
    for (const m of data.value || []) {
      out.push({
        message_id: m.internetMessageId || m.id, subject: m.subject || '',
        from_name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
        from_email: ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase(),
        received_at: m.receivedDateTime || null,
        text: (m.body && (m.body.contentType === 'html' ? htmlToText(m.body.content) : m.body.content)) || m.bodyPreview || '',
      });
    }
    url = data['@odata.nextLink'] || null;
  }
  return out.slice(0, max);
}

async function listConnections(pool) {
  const q = await pool.query('SELECT id, provider, address, status, last_error, scopes, connected_by, created_at, updated_at, last_scanned_at FROM mail_connections ORDER BY provider, address');
  return q.rows;
}
/** Mailbox descriptors for the scanner. */
async function connectedMailboxes(pool) {
  const q = await pool.query("SELECT * FROM mail_connections WHERE status='connected'");
  return q.rows.map((c) => ({ address: c.address, provider: c.provider === 'google' ? 'gmail_oauth' : 'outlook_oauth', connection: c }));
}
async function fetchConnectedMessages(pool, box, opts, fetchImpl = global.fetch) {
  try {
    const rows = box.provider === 'gmail_oauth' ? await fetchGmailMessages(pool, box.connection, opts, fetchImpl) : await fetchOutlookMessages(pool, box.connection, opts, fetchImpl);
    await pool.query('UPDATE mail_connections SET last_scanned_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=$1', [box.connection.id]).catch(() => {});
    return rows;
  } catch (err) {
    await pool.query('UPDATE mail_connections SET last_error=$1, status=CASE WHEN $1 ILIKE \'%invalid_grant%\' THEN \'reconnect\' ELSE status END WHERE id=$2', [err.message, box.connection.id]).catch(() => {});
    throw err;
  }
}

module.exports = { PROVIDERS, providerStatus, buildAuthUrl, completeConnection, accessTokenFor, fetchGmailMessages, fetchOutlookMessages, listConnections, connectedMailboxes, fetchConnectedMessages, redirectUri, APP_URL, gmailBodyText };
