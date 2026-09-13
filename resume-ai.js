// AI-powered resume extraction using the Anthropic API with a structured
// output schema, so the response is guaranteed to match the candidate fields.
// Falls back to the rule-based parser (resume-parser.js) when no API key is
// configured or the call fails; the route handles that fallback.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = process.env.RESUME_AI_MODEL || 'claude-opus-5';

const CandidateSchema = z.object({
  name: z.string().describe("The candidate's full name. Empty string if not present."),
  email: z.string().describe('Primary email address. Empty string if not present.'),
  phone: z.string().describe('Primary phone number as written. Empty string if not present.'),
  title: z.string().describe('Current or most recent job title. Empty string if not present.'),
  company: z.string().describe('Current or most recent employer. Empty string if not present.'),
  location: z.string().describe('City and state or country where the candidate is based. Empty string if not present.'),
  years_experience: z.number().nullable().describe('Total years of professional experience, estimated from work history dates. Null if it cannot be determined.'),
  skills: z.array(z.string()).describe('Technical and professional skills, deduplicated, using standard spelling (e.g. "JavaScript", "Node.js", "AWS").'),
  summary: z.string().describe('One or two sentence professional summary written in third person.'),
});

const SYSTEM_PROMPT = [
  'You extract structured candidate information from resume text for a staffing CRM.',
  'Use only information present in the resume. Never invent values; use an empty string or null when something is missing.',
  'Keep phone numbers and emails exactly as written. Prefer the most recent role for title and company.',
  'List skills as short canonical terms, not sentences.',
].join(' ');

function isAIConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let defaultClient = null;
function getClient() {
  if (!defaultClient) {
    defaultClient = new Anthropic({ timeout: 60 * 1000, maxRetries: 2 });
  }
  return defaultClient;
}

/**
 * Extract candidate fields from resume text with Claude.
 * @param {string} text - plain text of the resume
 * @param {{client?: object}} [options] - optional client override (used by tests)
 * @returns {Promise<object>} fields shaped for the Add Candidate form
 */
async function extractCandidateWithAI(text, options = {}) {
  const client = options.client || getClient();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: zodOutputFormat(CandidateSchema),
    },
    messages: [
      { role: 'user', content: `Extract the candidate's details from this resume.\n\n<resume>\n${text}\n</resume>` },
    ],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('The model declined to process this resume');
    err.code = 'AI_REFUSAL';
    throw err;
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The model response was cut off before completing');
  }
  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error('The model returned no parseable output');
  }

  const skills = (parsed.skills || []).map((s) => s.trim()).filter(Boolean);
  return {
    name: parsed.name || '',
    email: parsed.email || '',
    phone: parsed.phone || '',
    title: parsed.title || '',
    company: parsed.company || '',
    location: parsed.location || '',
    years_experience: parsed.years_experience ?? null,
    skills: skills.join(', '),
    skills_list: skills,
    summary: parsed.summary || '',
    parser: 'ai',
    model: response.model || MODEL,
  };
}

module.exports = { extractCandidateWithAI, isAIConfigured, CandidateSchema, MODEL };
