// Outbound email (Phase 5, Task 4).
// Primary transport: Microsoft Graph sendMail with client-credentials auth
// (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET, sending as FROM_EMAIL).
// Fallback transport: SMTP via nodemailer (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS).
// Both sets of variables already exist on the Render API service.

const FROM_EMAIL = process.env.FROM_EMAIL || 'bradpeek@peekitservices.com';
const FROM_NAME = process.env.FROM_NAME || 'Peek IT Services';

function graphConfigured() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}
function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function isEmailConfigured() {
  return graphConfigured() || smtpConfigured();
}
function emailTransportName() {
  if (graphConfigured()) return 'graph';
  if (smtpConfigured()) return 'smtp';
  return null;
}

function textToHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

// Cache the Graph token until shortly before it expires.
let graphToken = { value: null, expires: 0 };

async function getGraphToken(fetchImpl) {
  if (graphToken.value && Date.now() < graphToken.expires - 60 * 1000) return graphToken.value;
  const resp = await fetchImpl(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(`Microsoft Graph auth failed: ${data.error_description || data.error || resp.status}`);
  graphToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return graphToken.value;
}

async function sendViaGraph({ to, subject, html, attachmentBuffer, attachmentFilename }, fetchImpl) {
  const token = await getGraphToken(fetchImpl);
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: (Array.isArray(to) ? to : [to]).map((address) => ({ emailAddress: { address } })),
    from: { emailAddress: { address: FROM_EMAIL, name: FROM_NAME } },
  };
  if (attachmentBuffer && attachmentFilename) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachmentFilename,
      contentType: 'application/octet-stream',
      contentBytes: attachmentBuffer.toString('base64'),
    }];
  }
  const resp = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM_EMAIL)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!resp.ok && resp.status !== 202) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(`Microsoft Graph sendMail failed (${resp.status}): ${(e.error && e.error.message) || resp.statusText || 'unknown error'}`);
  }
  return { transport: 'graph' };
}

let smtpTransporter = null;
function getSmtpTransporter() {
  if (!smtpTransporter) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return smtpTransporter;
}

async function sendViaSmtp({ to, subject, html, text, attachmentBuffer, attachmentFilename }, transporter) {
  const t = transporter || getSmtpTransporter();
  const info = await t.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
    text: text || undefined,
    attachments: attachmentBuffer && attachmentFilename ? [{ filename: attachmentFilename, content: attachmentBuffer }] : undefined,
  });
  return { transport: 'smtp', messageId: info && info.messageId };
}

/**
 * Send an email. Accepts `html` or plain `text` (converted to HTML).
 * @param {{to: string|string[], subject: string, html?: string, text?: string, attachmentBuffer?: Buffer, attachmentFilename?: string}} mail
 * @param {{fetchImpl?: Function, transporter?: object}} [options] test injection
 */
async function sendEmail(mail, options = {}) {
  const { to, subject } = mail;
  if (!to || !String(Array.isArray(to) ? to[0] : to).includes('@')) throw Object.assign(new Error('A valid recipient email address is required'), { status: 400 });
  if (!subject) throw Object.assign(new Error('Email subject is required'), { status: 400 });
  const html = mail.html || textToHtml(mail.text);
  if (!html) throw Object.assign(new Error('Email body is required'), { status: 400 });

  const fetchImpl = options.fetchImpl || global.fetch;
  if (graphConfigured()) {
    try {
      return await sendViaGraph({ ...mail, html }, fetchImpl);
    } catch (err) {
      if (!smtpConfigured() && !options.transporter) throw err;
      console.error('⚠️ Graph send failed, falling back to SMTP:', err.message);
    }
  }
  if (smtpConfigured() || options.transporter) {
    return sendViaSmtp({ ...mail, html }, options.transporter);
  }
  throw Object.assign(new Error('Email is not configured (set MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET or SMTP_HOST/SMTP_USER/SMTP_PASS)'), { status: 503, code: 'EMAIL_NOT_CONFIGURED' });
}

module.exports = {
  sendEmail, isEmailConfigured, emailTransportName, textToHtml, FROM_EMAIL, FROM_NAME,
  graphConfigured,
  getGraphAccessToken: (fetchImpl = global.fetch) => getGraphToken(fetchImpl),
  _resetGraphToken: () => { graphToken = { value: null, expires: 0 }; },
};
