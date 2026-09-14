// Candidate sourcing from free public boards, driven by a job order.
//
//   hn         Hacker News "Ask HN: Who wants to be hired?" monthly thread (Algolia API, free)
//   craigslist Craigslist resumes section for a metro (no-JS results page)
//   google     Google Custom Search "X-ray" over public profiles (needs GOOGLE_CSE_KEY + GOOGLE_CSE_CX; 100 queries/day free)
//   links      Boards that need a person's login or block automation: PostJobFree resumes,
//              Reddit r/forhire, Jobvertise, state workforce job banks
//
// Every result is { source, id, name, title, snippet, location, link, posted_at, text }.
// Import runs the same AI resume extraction as the upload form on the result text.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 VelocityCRM';

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
const terms = (q) => String(q || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter((t) => t.length > 1);
function matchScore(text, query) {
  const hay = String(text || '').toLowerCase(); const ts = terms(query);
  if (!ts.length) return 1;
  const hit = ts.filter((t) => hay.includes(t)).length;
  return hit / ts.length;
}
const fieldLine = (text, label) => { const m = String(text || '').match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im')); return m ? m[1].trim() : ''; };

// ---------------------------------------------------------------------------
// Hacker News "Who wants to be hired?"
// ---------------------------------------------------------------------------
let hnCache = { at: 0, thread: null };
async function hnLatestThread(fetchImpl) {
  if (hnCache.thread && Date.now() - hnCache.at < 60 * 60 * 1000) return hnCache.thread;
  const r = await fetchImpl('https://hn.algolia.com/api/v1/search_by_date?query=%22who%20wants%20to%20be%20hired%22&tags=story,author_whoishiring&hitsPerPage=12');
  const d = await r.json();
  const hit = (d.hits || []).find((h) => /^ask hn: who wants to be hired/i.test(h.title || ''));
  if (!hit) throw new Error('Could not find the current "Who wants to be hired" thread');
  const t = await fetchImpl(`https://hn.algolia.com/api/v1/items/${hit.objectID}`);
  const thread = await t.json();
  hnCache = { at: Date.now(), thread: { id: hit.objectID, title: hit.title, comments: (thread.children || []).filter((c) => c.text) } };
  return hnCache.thread;
}
async function searchHN(query, { limit = 20, fetchImpl = global.fetch } = {}) {
  const thread = await hnLatestThread(fetchImpl);
  const out = [];
  for (const c of thread.comments) {
    const text = htmlToText(c.text);
    const score = matchScore(text, query);
    if (score < 0.5) continue;
    const location = fieldLine(text, 'Location'), remote = fieldLine(text, 'Remote'), tech = fieldLine(text, 'Technologies'), email = fieldLine(text, 'Email');
    const resume = (text.match(/https?:\/\/\S+/g) || []).find((u) => /resume|cv|pdf|linkedin|github|drive\.google/i.test(u)) || '';
    out.push({ source: 'hn', id: String(c.id), name: c.author ? `HN user ${c.author}` : 'HN candidate', title: tech ? tech.slice(0, 120) : text.split('\n')[0].slice(0, 120), snippet: text.slice(0, 400), location: [location, remote ? `Remote: ${remote}` : ''].filter(Boolean).join(' · '), link: `https://news.ycombinator.com/item?id=${c.id}`, posted_at: c.created_at, email: /\S+@\S+/.test(email) ? email : '', resume_link: resume, text, score });
  }
  return { thread: { id: thread.id, title: thread.title, link: `https://news.ycombinator.com/item?id=${thread.id}` }, results: out.sort((a, b) => b.score - a.score).slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Craigslist resumes (no-JS results page)
// ---------------------------------------------------------------------------
const CL_METROS = { austin: 'Austin, TX', dallas: 'Dallas, TX', houston: 'Houston, TX', sanantonio: 'San Antonio, TX', washingtondc: 'Washington, DC', baltimore: 'Baltimore, MD', frederick: 'Frederick, MD', philadelphia: 'Philadelphia, PA', newyork: 'New York, NY', boston: 'Boston, MA', chicago: 'Chicago, IL', atlanta: 'Atlanta, GA', charlotte: 'Charlotte, NC', raleigh: 'Raleigh, NC', denver: 'Denver, CO', phoenix: 'Phoenix, AZ', seattle: 'Seattle, WA', losangeles: 'Los Angeles, CA', sfbay: 'SF Bay Area, CA', miami: 'Miami, FL', tampa: 'Tampa, FL', orlando: 'Orlando, FL', minneapolis: 'Minneapolis, MN', detroit: 'Detroit, MI', stlouis: 'St. Louis, MO', kansascity: 'Kansas City, MO', nashville: 'Nashville, TN', columbus: 'Columbus, OH', pittsburgh: 'Pittsburgh, PA', richmond: 'Richmond, VA', norfolk: 'Norfolk, VA' };
function metroFor(location) {
  const l = String(location || '').toLowerCase();
  if (!l || /remote/.test(l)) return null;
  for (const [key, label] of Object.entries(CL_METROS)) { const city = label.split(',')[0].toLowerCase(); if (l.includes(city) || l.includes(key)) return key; }
  if (/\bmd\b|maryland/.test(l)) return 'baltimore';
  if (/\bdc\b|virginia|\bva\b/.test(l)) return 'washingtondc';
  if (/\btx\b|texas/.test(l)) return 'austin';
  return null;
}
async function searchCraigslist(query, { metro = 'washingtondc', limit = 20, fetchImpl = global.fetch } = {}) {
  const url = `https://${metro}.craigslist.org/search/rrr?query=${encodeURIComponent(query)}`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Craigslist ${metro} answered ${r.status}`);
  const html = await r.text();
  const out = [];
  const blocks = html.split('<li class="cl-static-search-result"').slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const li = block.split('</li>')[0];
    const link = (li.match(/<a href="([^"]+)"/) || [])[1]; if (!link) continue;
    const title = htmlToText((li.match(/<div class="title">([\s\S]*?)<\/div>/) || [])[1] || (li.match(/^[^>]*title="([^"]*)"/) || [])[1] || '');
    const loc = htmlToText((li.match(/<div class="location">([\s\S]*?)<\/div>/) || [])[1] || '');
    out.push({ source: 'craigslist', id: link.split('/').pop().replace(/\.html$/, ''), name: 'Craigslist poster', title: title.slice(0, 140), snippet: title, location: loc || CL_METROS[metro] || metro, link, posted_at: null, text: title, score: matchScore(title, query) });
  }
  return { metro, metro_label: CL_METROS[metro] || metro, url, results: out };
}

// ---------------------------------------------------------------------------
// Google Custom Search "X-ray" (optional)
// ---------------------------------------------------------------------------
function googleConfigured() { return Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX); }
async function searchGoogle(query, { location = '', limit = 10, fetchImpl = global.fetch } = {}) {
  if (!googleConfigured()) return { configured: false, results: [] };
  const q = `(site:linkedin.com/in OR site:github.com OR site:about.me) ${query} ${location}`.trim();
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_CSE_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_CX)}&num=${Math.min(10, limit)}&q=${encodeURIComponent(q)}`;
  const r = await fetchImpl(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google search failed (${r.status}): ${(d.error && d.error.message) || ''}`);
  return { configured: true, results: (d.items || []).map((it) => ({ source: 'google', id: it.link, name: (it.title || '').split(' - ')[0].slice(0, 80), title: (it.title || '').slice(0, 140), snippet: it.snippet || '', location, link: it.link, posted_at: null, text: `${it.title}\n${it.snippet}`, score: matchScore(`${it.title} ${it.snippet}`, query) })) };
}

// Boards a person searches themselves (login required or automation blocked).
function manualLinks(query, location) {
  const q = encodeURIComponent(query || ''); const l = encodeURIComponent(location || '');
  return [
    { name: 'PostJobFree resumes', note: 'Free resume database; contact details after a free recruiter sign-in.', url: `https://www.postjobfree.com/resumes?q=${q}&l=${l}&radius=100` },
    { name: 'Jobvertise resumes', note: 'Free to search; contact details are paid.', url: `https://www.jobvertise.com/resumes/search?q=${q}` },
    { name: 'Reddit r/forhire', note: 'Availability posts flaired "For Hire".', url: `https://www.reddit.com/r/forhire/search/?q=${q}%20flair%3A%22For%20Hire%22&restrict_sr=1&sort=new` },
    { name: 'Maryland Workforce Exchange', note: 'Free resume search for registered Maryland employers.', url: 'https://mwejobs.maryland.gov/' },
    { name: 'WorkInTexas', note: 'Free resume search for registered Texas employers.', url: 'https://www.workintexas.com/' },
    { name: 'LinkedIn people search', note: 'Basic search is free; contacting needs a connection or InMail.', url: `https://www.linkedin.com/search/results/people/?keywords=${q}` },
  ];
}

async function searchAll(query, { location = '', sources = ['hn', 'craigslist', 'google'], limit = 20, metro, fetchImpl = global.fetch } = {}) {
  const out = { query, location, results: [], errors: [], meta: {}, links: manualLinks(query, location) };
  const want = new Set(sources);
  const jobs = [];
  if (want.has('hn')) jobs.push(searchHN(query, { limit, fetchImpl }).then((r) => { out.meta.hn = r.thread; out.results.push(...r.results); }).catch((e) => out.errors.push(`Hacker News: ${e.message}`)));
  if (want.has('craigslist')) { const m = metro || metroFor(location) || 'washingtondc'; jobs.push(searchCraigslist(query, { metro: m, limit, fetchImpl }).then((r) => { out.meta.craigslist = { metro: r.metro, label: r.metro_label, url: r.url }; out.results.push(...r.results); }).catch((e) => out.errors.push(`Craigslist: ${e.message}`))); }
  if (want.has('google')) jobs.push(searchGoogle(query, { location, limit, fetchImpl }).then((r) => { out.meta.google = { configured: r.configured }; out.results.push(...r.results); }).catch((e) => out.errors.push(`Google: ${e.message}`)));
  await Promise.all(jobs);
  out.results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return out;
}

/** Full text for a result so the AI parser has something to read. */
async function fetchResultText(result, fetchImpl = global.fetch) {
  if (result.text && result.text.length > 200) return result.text;
  if (!result.link) return result.text || '';
  try {
    const r = await fetchImpl(result.link, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    const html = await r.text();
    const main = html.match(/<section id="postingbody">([\s\S]*?)<\/section>/i);
    return htmlToText(main ? main[1] : html).slice(0, 20000);
  } catch { return result.text || ''; }
}

module.exports = { searchAll, searchHN, searchCraigslist, searchGoogle, googleConfigured, manualLinks, fetchResultText, metroFor, CL_METROS, htmlToText, matchScore };
