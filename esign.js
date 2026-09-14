// E-signature: NDA, Right to Represent (RTR) and Statement of Work (SOW).
//
// Provider: Adobe Acrobat Sign REST v6. Configure on the API service:
//   ACROBAT_SIGN_BASE_URL         e.g. https://api.na1.adobesign.com/api/rest/v6  (your shard: see Acrobat Sign > Account > API)
//   ACROBAT_SIGN_INTEGRATION_KEY  an integration key with agreement_read/write, agreement_send, user_read scopes
//                                 (Acrobat Sign > Account > Acrobat Sign API > API Information > Integration Key)
//   ACROBAT_SIGN_CLIENT_ID        the application's client id; echoed back on webhook calls so Acrobat Sign trusts us
//   ESIGN_COUNTERSIGNER_EMAIL     optional: Peek Talent Solutions signer added as the second participant
//   ESIGN_COMPANY_NAME            defaults to "Peek Talent Solutions"
//
// Register the webhook in Acrobat Sign (Account > Webhooks) pointing at
//   https://<api host>/api/esign/webhook   with events AGREEMENT_ALL
//
// Without credentials the module runs in "manual" mode: the document is
// generated, emailed to the signer for wet/return signature, and a recruiter
// records the signed copy with "Mark as signed". Every status change is
// audited either way, so the workflow gates (NDA before sharing candidates,
// RTR before submission, SOW before placement) work today.

const COMPANY = process.env.ESIGN_COMPANY_NAME || 'Peek Talent Solutions';
const KINDS = {
  nda: { label: 'Mutual Non-Disclosure Agreement', short: 'NDA', party: 'account' },
  rtr: { label: 'Right to Represent', short: 'RTR', party: 'candidate' },
  sow: { label: 'Statement of Work', short: 'SOW', party: 'account' },
};
const STATUSES = ['draft', 'sent', 'viewed', 'signed', 'declined', 'cancelled', 'expired', 'error'];

function isConfigured() { return !!(process.env.ACROBAT_SIGN_INTEGRATION_KEY || process.env.ACROBAT_SIGN_ACCESS_TOKEN); }
function providerName() { return isConfigured() ? 'acrobat_sign' : 'manual'; }
function baseUrl() { return (process.env.ACROBAT_SIGN_BASE_URL || 'https://api.na1.adobesign.com/api/rest/v6').replace(/\/$/, ''); }
function authHeader() { return { Authorization: `Bearer ${process.env.ACROBAT_SIGN_INTEGRATION_KEY || process.env.ACROBAT_SIGN_ACCESS_TOKEN}` }; }

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (d) => {
  if (!d) return '____________';
  // Date-only strings are calendar dates, not instants: parse them as local so they do not shift a day.
  const m = typeof d === 'string' && d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const x = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  // A Date sitting exactly at UTC midnight is a DATE column value: format it in UTC so it keeps its calendar day.
  const utcMidnight = !m && x.getUTCHours() === 0 && x.getUTCMinutes() === 0 && x.getUTCSeconds() === 0 && x.getUTCMilliseconds() === 0;
  return x.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', ...(utcMidnight ? { timeZone: 'UTC' } : {}) });
};

/** Build the agreement as self-contained HTML with Acrobat Sign text tags for the signature blocks. */
function buildDocument(kind, f = {}) {
  const meta = KINDS[kind];
  if (!meta) throw Object.assign(new Error(`Unknown document kind "${kind}" (nda, rtr, sow)`), { status: 400 });
  const today = fmtDate(f.effective_date || new Date());
  const counter = process.env.ESIGN_COUNTERSIGNER_EMAIL ? `
    <table class="sig"><tr>
      <td><p><strong>${esc(COMPANY)}</strong></p><p>Signature: {{Sig_es_:signer2:signature}}</p><p>Name: {{N_es_:signer2:fullname}}</p><p>Date: {{Dte_es_:signer2:date}}</p></td>
    </tr></table>` : `
    <table class="sig"><tr><td><p><strong>${esc(COMPANY)}</strong></p><p>Signature: ____________________________</p><p>Name: ${esc(f.company_signer || '')}</p><p>Date: ____________</p></td></tr></table>`;
  const signer = (label) => `
    <table class="sig"><tr>
      <td><p><strong>${esc(label)}</strong></p><p>Signature: {{Sig_es_:signer1:signature}}</p><p>Name: {{N_es_:signer1:fullname}}</p><p>Title: {{Ttl_es_:signer1:title}}</p><p>Date: {{Dte_es_:signer1:date}}</p></td>
    </tr></table>`;
  let body = '';
  if (kind === 'nda') {
    body = `
      <h1>Mutual Non-Disclosure Agreement</h1>
      <p>This Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of ${today} between <strong>${esc(COMPANY)}</strong> ("${esc(COMPANY)}") and <strong>${esc(f.client_name)}</strong> ("Client"), each a "Party".</p>
      <h2>1. Purpose</h2><p>The Parties wish to exchange confidential information in connection with staffing and recruiting services, including candidate profiles, job requirements, rates and business terms (the "Purpose").</p>
      <h2>2. Confidential Information</h2><p>"Confidential Information" means any non-public information disclosed by either Party, including candidate identities, resumes, compensation, client requirements, pricing and business plans, whether disclosed orally, in writing or electronically.</p>
      <h2>3. Obligations</h2><p>Each Party will (a) use the other Party's Confidential Information only for the Purpose, (b) protect it with at least the care it uses for its own confidential information and no less than reasonable care, and (c) not disclose it to third parties except to employees and contractors who need to know it and are bound by written obligations at least as protective.</p>
      <h2>4. Candidate Non-Circumvention</h2><p>Client will not, for twelve (12) months after ${esc(COMPANY)} introduces a candidate, engage that candidate directly or through another agency without a placement fee to ${esc(COMPANY)} under the applicable services agreement.</p>
      <h2>5. Exclusions</h2><p>Confidential Information does not include information that is or becomes public through no fault of the receiving Party, was already known to it, is independently developed, or is rightfully received from a third party without restriction.</p>
      <h2>6. Term</h2><p>This Agreement is effective on the date above and continues for two (2) years. Obligations of confidentiality survive for three (3) years after disclosure.</p>
      <h2>7. General</h2><p>This Agreement is governed by the laws of the State of ${esc(f.governing_state || 'Florida')}. It is the entire agreement on its subject and may be signed electronically in counterparts.</p>
      ${signer(`${f.client_name} (Client)`)}${counter}`;
  } else if (kind === 'rtr') {
    body = `
      <h1>Right to Represent</h1>
      <p>Date: ${today}</p>
      <p>I, <strong>${esc(f.candidate_name)}</strong>, authorize <strong>${esc(COMPANY)}</strong> to represent me exclusively for the position below and to submit my qualifications to the client named.</p>
      <table class="facts">
        <tr><th>Position</th><td>${esc(f.job_title)}</td></tr>
        <tr><th>Client</th><td>${esc(f.client_name)}</td></tr>
        <tr><th>Location</th><td>${esc(f.location || 'As described in the job order')}</td></tr>
        <tr><th>Rate / compensation</th><td>${esc(f.rate || 'As discussed')}</td></tr>
        <tr><th>Employment type</th><td>${esc(f.employment_type || 'As described in the job order')}</td></tr>
      </table>
      <h2>Terms</h2>
      <p>1. I have not been submitted to this client for this position by any other agency or directly in the last six (6) months, and I will not authorize another party to submit me for it while this authorization is in effect.</p>
      <p>2. I confirm that the information in my resume is accurate and that I am legally authorized to work in the United States for any employer${f.work_authorization ? ` (${esc(f.work_authorization)})` : ''}.</p>
      <p>3. This authorization is valid for ninety (90) days from the date above or until the position is filled or withdrawn, whichever comes first.</p>
      <p>4. I consent to ${esc(COMPANY)} sharing a candidate profile with the client. Personal contact details are withheld until the client requests an interview.</p>
      ${signer(`${f.candidate_name} (Candidate)`)}`;
  } else {
    body = `
      <h1>Statement of Work</h1>
      <p>This Statement of Work ("SOW") is entered into as of ${today} between <strong>${esc(COMPANY)}</strong> and <strong>${esc(f.client_name)}</strong> ("Client") under the Parties' services agreement.</p>
      <table class="facts">
        <tr><th>Role</th><td>${esc(f.job_title)}</td></tr>
        <tr><th>Consultant / candidate</th><td>${esc(f.candidate_name)}</td></tr>
        <tr><th>Start date</th><td>${fmtDate(f.start_date)}</td></tr>
        <tr><th>End date / term</th><td>${f.end_date ? fmtDate(f.end_date) : esc(f.term || 'Ongoing until terminated with 2 weeks notice')}</td></tr>
        <tr><th>Rate</th><td>${esc(f.rate || '')}${f.rate_type ? ` (${esc(f.rate_type)})` : ''}</td></tr>
        <tr><th>Work location</th><td>${esc(f.location || '')}</td></tr>
        ${f.fee ? `<tr><th>Placement fee</th><td>${esc(f.fee)}</td></tr>` : ''}
      </table>
      <h2>1. Services</h2><p>${esc(COMPANY)} will provide the consultant named above to perform the services described in the job order for the Client. ${esc(f.scope || '')}</p>
      <h2>2. Invoicing and payment</h2><p>${esc(COMPANY)} invoices ${esc(f.invoice_cycle || 'semi-monthly')} based on approved timesheets. Payment is due ${esc(f.payment_terms || 'net 30')} from the invoice date.</p>
      <h2>3. Conversion</h2><p>If the Client hires the consultant directly within twelve (12) months of the start date, a conversion fee applies as set out in the services agreement.</p>
      <h2>4. Termination</h2><p>Either Party may terminate this SOW with ${esc(f.notice || 'two (2) weeks')} written notice. Fees accrued through the termination date remain payable.</p>
      ${signer(`${f.client_name} (Client)`)}${counter}`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(meta.label)}</title>
<style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.5;margin:48px;color:#111}h1{font-size:20pt;margin:0 0 12px}h2{font-size:13pt;margin:18px 0 6px}table.facts{border-collapse:collapse;margin:12px 0}table.facts th,table.facts td{border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top}table.facts th{background:#f0f0f0;width:180px}table.sig{margin-top:36px;width:100%}table.sig td{vertical-align:top;padding:0}.foot{margin-top:36px;font-size:9pt;color:#555}</style></head>
<body>${body}<p class="foot">Generated by VelocityCRM for ${esc(COMPANY)} on ${today}. Reference: ${esc(f.reference || '')}</p></body></html>`;
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl()}${path}`, { method, headers: { ...authHeader(), ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) { const e = new Error(`Acrobat Sign ${method} ${path} -> ${res.status}: ${(json && (json.message || json.code)) || text.slice(0, 200)}`); e.status = 502; e.provider_status = res.status; throw e; }
  return json;
}

/** Upload the HTML and create an agreement. Returns { agreement_id, provider }. */
async function sendAgreement({ kind, name, html, signer_email, signer_name, message }, fetchImpl = fetch) {
  if (!isConfigured()) throw Object.assign(new Error('Acrobat Sign is not configured (ACROBAT_SIGN_INTEGRATION_KEY)'), { status: 503, code: 'ESIGN_NOT_CONFIGURED' });
  const form = new FormData();
  form.append('File-Name', `${name}.html`);
  form.append('Mime-Type', 'text/html');
  form.append('File', new Blob([html], { type: 'text/html' }), `${name}.html`);
  const t = await api('/transientDocuments', { method: 'POST', body: form, raw: true }, fetchImpl);
  const participantSetsInfo = [{ order: 1, role: 'SIGNER', memberInfos: [{ email: signer_email, name: signer_name || undefined }] }];
  if (process.env.ESIGN_COUNTERSIGNER_EMAIL) participantSetsInfo.push({ order: 2, role: 'SIGNER', memberInfos: [{ email: process.env.ESIGN_COUNTERSIGNER_EMAIL }] });
  const a = await api('/agreements', { method: 'POST', body: {
    fileInfos: [{ transientDocumentId: t.transientDocumentId }],
    name, participantSetsInfo, signatureType: 'ESIGN', state: 'IN_PROCESS',
    message: message || `Please review and sign the ${KINDS[kind].label} from ${COMPANY}.`,
    externalId: { id: `velocity-${kind}` },
  } }, fetchImpl);
  return { agreement_id: a.id, provider: 'acrobat_sign' };
}

const PROVIDER_STATUS = {
  OUT_FOR_SIGNATURE: 'sent', OUT_FOR_APPROVAL: 'sent', OUT_FOR_ACCEPTANCE: 'sent', OUT_FOR_FORM_FILLING: 'sent', OUT_FOR_DELIVERY: 'sent', AUTHORING: 'draft', DRAFT: 'draft', DOCUMENTS_NOT_YET_PROCESSED: 'sent',
  SIGNED: 'signed', APPROVED: 'signed', ACCEPTED: 'signed', DELIVERED: 'signed', FORM_FILLED: 'signed', WAITING_FOR_MY_SIGNATURE: 'sent', WAITING_FOR_MY_APPROVAL: 'sent',
  CANCELLED: 'cancelled', EXPIRED: 'expired', ARCHIVED: 'signed', PREFILL: 'draft', WAITING_FOR_NOTARIZATION: 'sent',
};
function mapProviderStatus(s) { return PROVIDER_STATUS[String(s || '').toUpperCase()] || null; }

async function agreementStatus(agreementId, fetchImpl = fetch) {
  const a = await api(`/agreements/${encodeURIComponent(agreementId)}`, {}, fetchImpl);
  return { status: mapProviderStatus(a.status) || 'sent', provider_status: a.status, raw: a };
}
async function cancelAgreement(agreementId, fetchImpl = fetch) {
  await api(`/agreements/${encodeURIComponent(agreementId)}/state`, { method: 'PUT', body: { state: 'CANCELLED', agreementCancellationInfo: { comment: 'Cancelled from VelocityCRM', notifyOthers: true } } }, fetchImpl);
  return { status: 'cancelled' };
}

/** Interpret a webhook payload from Acrobat Sign. Returns { agreement_id, status, event } or null. */
function parseWebhook(body = {}) {
  const event = body.event || body.eventType || (body.agreement && body.agreement.status) || '';
  const agreement = body.agreement || {};
  const id = agreement.id || body.agreementId || null;
  if (!id) return null;
  const E = String(event).toUpperCase();
  let status = null;
  if (/AGREEMENT_WORKFLOW_COMPLETED|AGREEMENT_ACTION_COMPLETED|AGREEMENT_SIGNED/.test(E) || (agreement.status === 'SIGNED')) status = 'signed';
  else if (/REJECTED|DECLINED/.test(E)) status = 'declined';
  else if (/EXPIRED/.test(E)) status = 'expired';
  else if (/RECALLED|CANCELLED/.test(E)) status = 'cancelled';
  else if (/EMAIL_VIEWED|ACTION_REQUESTED|VIEWED/.test(E)) status = 'viewed';
  else if (/CREATED|SENT|ACTION_DELEGATED|REMINDER/.test(E)) status = 'sent';
  else status = mapProviderStatus(agreement.status);
  return { agreement_id: id, status, event: event || null, participant: body.participantUserEmail || (body.actionOwner && body.actionOwner.email) || null };
}

module.exports = { KINDS, STATUSES, COMPANY, isConfigured, providerName, buildDocument, sendAgreement, agreementStatus, cancelAgreement, parseWebhook, mapProviderStatus, baseUrl };
