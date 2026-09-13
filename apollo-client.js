// Apollo.io API client (Phase 4, Task 1).
// Wraps the two endpoints the job-order integration needs:
//   - organization search:  POST /api/v1/mixed_companies/search   (1 credit per page)
//   - organization postings: GET  /api/v1/organizations/{id}/job_postings (1 credit per page)
// Auth is the x-api-key header. The API key comes from APOLLO_API_KEY.

const APOLLO_BASE = process.env.APOLLO_API_BASE || 'https://api.apollo.io/api/v1';
const REQUEST_TIMEOUT_MS = 20000;

class ApolloError extends Error {
  constructor(message, { status = 502, code = 'APOLLO_ERROR', retryAfter = null } = {}) {
    super(message);
    this.name = 'ApolloError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function isApolloConfigured() {
  return Boolean(process.env.APOLLO_API_KEY);
}

// Small in-memory cache so repeated company lookups don't burn credits.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function createApolloClient({ apiKey = process.env.APOLLO_API_KEY, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    // Node < 18 fallback
    fetchImpl = require('node-fetch');
  }

  async function request(method, path, { body, query } = {}) {
    if (!apiKey) throw new ApolloError('Apollo is not configured (APOLLO_API_KEY missing)', { status: 503, code: 'APOLLO_NOT_CONFIGURED' });
    const url = new URL(APOLLO_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new ApolloError('Apollo request timed out', { status: 504, code: 'APOLLO_TIMEOUT' });
      throw new ApolloError(`Could not reach Apollo: ${err.message}`, { status: 502, code: 'APOLLO_UNREACHABLE' });
    }
    clearTimeout(timer);

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (res.status === 401 || res.status === 403) {
      throw new ApolloError('Apollo rejected the API key (check APOLLO_API_KEY on Render)', { status: 502, code: 'APOLLO_AUTH' });
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || null;
      throw new ApolloError('Apollo rate limit reached; try again shortly', { status: 429, code: 'APOLLO_RATE_LIMIT', retryAfter });
    }
    if (res.status === 402) {
      throw new ApolloError('Apollo credits exhausted for this plan', { status: 402, code: 'APOLLO_NO_CREDITS' });
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `Apollo API returned ${res.status}`;
      throw new ApolloError(msg, { status: 502, code: 'APOLLO_ERROR' });
    }
    return data || {};
  }

  /** Search companies by name. Returns a trimmed list; cached for 10 minutes. */
  async function searchOrganizations(name, { page = 1, perPage = 10 } = {}) {
    const q = String(name || '').trim();
    if (!q) return { organizations: [], page, total: 0 };
    const key = `orgs:${q.toLowerCase()}:${page}:${perPage}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const data = await request('POST', '/mixed_companies/search', {
      body: { q_organization_name: q, page, per_page: Math.min(Math.max(1, perPage), 100) },
    });
    const list = data.organizations || data.accounts || [];
    const result = {
      organizations: list.map((o) => ({
        id: o.id,
        name: o.name || '',
        website_url: o.website_url || '',
        primary_domain: o.primary_domain || '',
        linkedin_url: o.linkedin_url || '',
        logo_url: o.logo_url || '',
        industry: o.industry || '',
        estimated_num_employees: o.estimated_num_employees ?? null,
        location: [o.city, o.state, o.country].filter(Boolean).join(', '),
      })),
      page,
      total: (data.pagination && data.pagination.total_entries) ?? list.length,
    };
    cacheSet(key, result);
    return result;
  }

  /** Current job postings for an Apollo organization id. Not cached (freshness matters). */
  async function getJobPostings(organizationId, { page = 1, perPage = 100 } = {}) {
    if (!organizationId) throw new ApolloError('organization id is required', { status: 400, code: 'BAD_REQUEST' });
    const data = await request('GET', `/organizations/${encodeURIComponent(organizationId)}/job_postings`, {
      query: { page, per_page: Math.min(Math.max(1, perPage), 500) },
    });
    const list = data.organization_job_postings || data.job_postings || [];
    return {
      postings: list.map((j) => ({
        id: j.id,
        title: j.title || '',
        url: j.url || '',
        city: j.city || '',
        state: j.state || '',
        country: j.country || '',
        location: [j.city, j.state, j.country].filter(Boolean).join(', '),
        posted_at: j.posted_at || null,
        last_seen_at: j.last_seen_at || null,
      })),
      page,
    };
  }

  return { searchOrganizations, getJobPostings, request };
}

let defaultClient = null;
function getApolloClient() {
  if (!defaultClient) defaultClient = createApolloClient();
  return defaultClient;
}

module.exports = { createApolloClient, getApolloClient, isApolloConfigured, ApolloError, _cache: cache };
