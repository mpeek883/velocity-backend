// QuickBooks Online: OAuth2 connection and invoice creation.
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET   from developer.intuit.com (app keys)
//   QBO_ENV                              'sandbox' (default) or 'production'
//   QBO_REDIRECT_URI                     defaults to <API_URL>/api/quickbooks/callback
//   QBO_ITEM_NAME                        service item used on invoice lines (default "Staffing Services")
// Tokens live in integration_tokens; the refresh token is rotated on every refresh.

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || process.env.API_URL || 'https://velocitycrm-api.onrender.com').replace(/\/$/, '');

function isConfigured() { return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET); }
function baseUrl() { return process.env.QBO_ENV === 'production' ? 'https://quickbooks.api.intuit.com/v3/company' : 'https://sandbox-quickbooks.api.intuit.com/v3/company'; }
function redirectUri() { return process.env.QBO_REDIRECT_URI || `${API_PUBLIC_URL}/api/quickbooks/callback`; }
function authUrl(state) {
  const p = new URLSearchParams({ client_id: process.env.QBO_CLIENT_ID, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri(), state });
  return `${AUTH_URL}?${p}`;
}
function basicAuth() { return 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'); }

async function tokenRequest(params, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`QuickBooks token error ${res.status}: ${json.error_description || json.error || 'unknown'}`), { status: 502 });
  const now = Date.now();
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: new Date(now + (json.expires_in || 3600) * 1000), refresh_expires_at: new Date(now + (json.x_refresh_token_expires_in || 8726400) * 1000) };
}
const exchangeCode = (code, fetchImpl) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }, fetchImpl);
const refreshTokens = (refreshToken, fetchImpl) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);

/** Token store helpers (integration_tokens table). */
async function loadConnection(pool) { const q = await pool.query("SELECT * FROM integration_tokens WHERE provider='quickbooks' ORDER BY id DESC LIMIT 1"); return q.rows[0] || null; }
async function saveConnection(pool, { realm_id, tokens, connected_by }) {
  await pool.query("DELETE FROM integration_tokens WHERE provider='quickbooks'");
  const q = await pool.query("INSERT INTO integration_tokens (provider, realm_id, access_token, refresh_token, expires_at, refresh_expires_at, connected_by) VALUES ('quickbooks',$1,$2,$3,$4,$5,$6) RETURNING *", [realm_id, tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.refresh_expires_at, connected_by == null ? null : String(connected_by)]);
  return q.rows[0];
}
async function accessToken(pool, fetchImpl) {
  const c = await loadConnection(pool);
  if (!c) throw Object.assign(new Error('QuickBooks is not connected'), { status: 503, code: 'QBO_NOT_CONNECTED' });
  if (new Date(c.expires_at).getTime() - Date.now() > 120000) return { token: c.access_token, realm: c.realm_id };
  const t = await refreshTokens(c.refresh_token, fetchImpl);
  await pool.query('UPDATE integration_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, refresh_expires_at=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5', [t.access_token, t.refresh_token, t.expires_at, t.refresh_expires_at, c.id]);
  return { token: t.access_token, realm: c.realm_id };
}

async function api(pool, path, { method = 'GET', body, query } = {}, fetchImpl = fetch) {
  const { token, realm } = await accessToken(pool, fetchImpl);
  const url = `${baseUrl()}/${realm}${path}${path.includes('?') ? '&' : '?'}minorversion=73${query ? `&query=${encodeURIComponent(query)}` : ''}`;
  const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  if (!res.ok) { const detail = json && json.Fault && json.Fault.Error && json.Fault.Error[0] ? `${json.Fault.Error[0].Message}: ${json.Fault.Error[0].Detail || ''}` : text.slice(0, 200); throw Object.assign(new Error(`QuickBooks ${method} ${path} -> ${res.status}: ${detail}`), { status: 502 }); }
  return json;
}
const q = (s) => String(s || '').replace(/'/g, "\\'");

async function findOrCreateCustomer(pool, { name, email }, fetchImpl) {
  const found = await api(pool, '/query', { query: `select * from Customer where DisplayName = '${q(name)}'` }, fetchImpl);
  const list = (found.QueryResponse && found.QueryResponse.Customer) || [];
  if (list.length) return list[0];
  const created = await api(pool, '/customer', { method: 'POST', body: { DisplayName: name, ...(email ? { PrimaryEmailAddr: { Address: email } } : {}) } }, fetchImpl);
  return created.Customer;
}
async function findOrCreateItem(pool, fetchImpl) {
  const name = process.env.QBO_ITEM_NAME || 'Staffing Services';
  const found = await api(pool, '/query', { query: `select * from Item where Name = '${q(name)}'` }, fetchImpl);
  const list = (found.QueryResponse && found.QueryResponse.Item) || [];
  if (list.length) return list[0];
  const accts = await api(pool, '/query', { query: "select * from Account where AccountType = 'Income' maxresults 1" }, fetchImpl);
  const income = (accts.QueryResponse && accts.QueryResponse.Account && accts.QueryResponse.Account[0]) || null;
  if (!income) throw Object.assign(new Error('No income account found in QuickBooks to attach the service item to'), { status: 502 });
  const created = await api(pool, '/item', { method: 'POST', body: { Name: name, Type: 'Service', IncomeAccountRef: { value: income.Id } } }, fetchImpl);
  return created.Item;
}
async function createInvoice(pool, { customer_name, customer_email, hours, rate, description, due_date, memo, doc_number }, fetchImpl) {
  const customer = await findOrCreateCustomer(pool, { name: customer_name, email: customer_email }, fetchImpl);
  const item = await findOrCreateItem(pool, fetchImpl);
  const amount = Math.round(Number(hours) * Number(rate) * 100) / 100;
  const body = { CustomerRef: { value: customer.Id }, ...(customer_email ? { BillEmail: { Address: customer_email } } : {}), ...(due_date ? { DueDate: due_date } : {}), ...(doc_number ? { DocNumber: doc_number } : {}), ...(memo ? { CustomerMemo: { value: memo } } : {}),
    Line: [{ Amount: amount, DetailType: 'SalesItemLineDetail', Description: description, SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: Number(hours), UnitPrice: Number(rate) } }] };
  const created = await api(pool, '/invoice', { method: 'POST', body }, fetchImpl);
  return { id: created.Invoice.Id, doc_number: created.Invoice.DocNumber, total: created.Invoice.TotalAmt, customer_id: customer.Id };
}
async function sendInvoice(pool, id, email, fetchImpl) { return api(pool, `/invoice/${encodeURIComponent(id)}/send${email ? `?sendTo=${encodeURIComponent(email)}` : ''}`, { method: 'POST' }, fetchImpl); }
async function invoiceStatus(pool, id, fetchImpl) { const r = await api(pool, `/invoice/${encodeURIComponent(id)}`, {}, fetchImpl); const inv = r.Invoice; return { balance: Number(inv.Balance), total: Number(inv.TotalAmt), paid: Number(inv.Balance) === 0 }; }
async function companyInfo(pool, fetchImpl) { const c = await loadConnection(pool); if (!c) return null; const r = await api(pool, `/companyinfo/${c.realm_id}`, {}, fetchImpl); return r.CompanyInfo ? { name: r.CompanyInfo.CompanyName, realm: c.realm_id } : null; }

const SCHEMA = ['CREATE TABLE IF NOT EXISTS integration_tokens (id SERIAL PRIMARY KEY, provider VARCHAR(40), realm_id VARCHAR(80), access_token TEXT, refresh_token TEXT, expires_at TIMESTAMP, refresh_expires_at TIMESTAMP, connected_by TEXT, connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'];

module.exports = { isConfigured, authUrl, redirectUri, exchangeCode, refreshTokens, loadConnection, saveConnection, accessToken, api, findOrCreateCustomer, findOrCreateItem, createInvoice, sendInvoice, invoiceStatus, companyInfo, baseUrl, SCHEMA, TOKEN_URL };
