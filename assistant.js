// VelocityCRM AI assistant (Phase 5, Task 4). Backs POST /api/ai/chat, which
// the app uses for the assistant panel and for Smart Paste extraction (the
// caller asks for JSON in the message and parses it from the reply text).

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_CHAT_MODEL || 'claude-opus-5';

const MANUAL = `VelocityCRM by Peek Talent Solutions.
Modules: CRM (Contacts, Accounts, Leads, Opportunities pipeline, Activities, Contracts) and Staffing (Candidates, Job Orders, Submissions, Placements).
AI features: resume parsing on Add Candidate, Smart Paste extraction (paste a recruiter email, job posting, signature, or notes and the fields are extracted), job description parsing, candidate matching, submission write-ups.
Integrations: Apollo.io job postings import and sync (Job Orders screen), Microsoft Graph / SMTP email, Render hosting.
Staffing workflow: Job Order -> Candidate Match -> Submission -> Placement. Peek Talent Solutions retains 35% of the bill rate; candidate pay rate is 65% of bill rate unless stated otherwise.`;

function isAIConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let defaultClient = null;
function getClient() {
  if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 });
  return defaultClient;
}

function buildMessages(history, message) {
  const out = [];
  for (const h of Array.isArray(history) ? history.slice(-20) : []) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof h.content === 'string' ? h.content : (h.text || '');
    if (!content) continue;
    // Merge consecutive same-role turns so the transcript alternates cleanly.
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + content;
    else out.push({ role, content });
  }
  if (out.length && out[out.length - 1].role === 'user') out[out.length - 1].content += '\n\n' + message;
  else out.push({ role: 'user', content: message });
  if (out[0].role !== 'user') out.unshift({ role: 'user', content: '(conversation start)' });
  return out;
}

/**
 * @param {{message: string, module?: string, userRole?: string, history?: Array}} input
 * @param {{client?: object}} [options] test injection
 * @returns {Promise<{response: string, model: string, stop_reason: string}>}
 */
async function runAssistantChat(input, options = {}) {
  const message = String((input && input.message) || '').trim();
  if (!message) throw Object.assign(new Error('message is required'), { status: 400 });
  const mod = (input.module || 'dashboard').toString();
  const role = (input.userRole || 'user').toString();
  const client = options.client || getClient();

  const system = [
    `You are the VelocityCRM Assistant for Peek Talent Solutions. Current module: "${mod}". User role: ${role}.`,
    'Be concise. When asked how to do something in the app, give short numbered steps.',
    'When the user asks for JSON, return only the JSON with no prose, no markdown fences.',
    '',
    MANUAL,
  ].join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    output_config: { effort: 'low' },
    messages: buildMessages(input.history, message),
  });

  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('The assistant declined this request'), { status: 422, code: 'AI_REFUSAL' });
  }
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { response: text, model: response.model || MODEL, stop_reason: response.stop_reason };
}

module.exports = { runAssistantChat, isAIConfigured, buildMessages, MODEL, MANUAL };
