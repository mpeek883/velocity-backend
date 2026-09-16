// Which position is this email about?
//
// A recruiter often works several roles at once and will happily reply to an
// old thread about a new one, or start a fresh thread about a role we already
// have. Two things have to hold:
//
//   1. One lead per (recruiter, position). The same recruiter writing about a
//      different position gets its own lead; a follow-up about a position we
//      already have merges into that lead instead of creating a second one.
//   2. One conversation per lead, and it stays about that position. An inbound
//      message is attached to the lead whose thread it belongs to, and when
//      that cannot be established with confidence nothing is guessed and
//      nothing is auto-sent - a person decides.
//
// Matching runs strongest-evidence-first: the mail thread itself, then the
// provider's conversation id, then the role.

const { titleTokens, titleSimilarity } = require('./skills');

// Similarity at or above this means the same position.
const SAME_ROLE = 0.8;
// Between this and SAME_ROLE the titles are close but not conclusive, so the
// client has to agree too.
const NEAR_ROLE = 0.6;

/** Normalise a role name or subject: no Re:/Fwd:, no requisition ids, no punctuation. */
function roleKey(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/^(\s*(re|fw|fwd|aw|tr|wg)\s*:\s*)+/g, '')
    .replace(/\b[a-z]*\d{4,}[a-z0-9-]*\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Requisition / job ids: the strongest evidence two emails are about the same
// opening, and equally the strongest evidence that they are not.
const REQ_PATTERNS = [
  /\b(?:req(?:uisition)?|job|position|posting|vacancy|id)\s*(?:id|#|no\.?|number)?\s*[:#-]?\s*([a-z]{0,5}[-_]?\d{3,}[a-z0-9-]*)\b/gi,
  /\b([a-z]{2,5}-\d{3,}[a-z0-9-]*)\b/gi,
];
function reqIds(...texts) {
  const hay = texts.filter(Boolean).join(' \n ');
  const out = new Set();
  for (const re of REQ_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(hay))) {
      const id = String(m[1]).toLowerCase().replace(/[-_]/g, '');
      // Bare years and short numbers are not requisition ids.
      if (/^\d{4}$/.test(id) && Number(id) > 1900 && Number(id) < 2100) continue;
      if (/\d/.test(id) && id.length >= 4) out.add(id);
    }
  }
  return [...out];
}

const clean = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Are these two the same position? Each side is a lead-shaped object:
 * { job_title, email_subject, end_client, job_description, req_id }.
 * Returns { same: boolean, basis: string, similarity: number|null }.
 */
function roleMatch(a, b) {
  const aIds = a.req_id ? [String(a.req_id).toLowerCase().replace(/[-_]/g, '')] : reqIds(a.job_title, a.email_subject, a.job_description);
  const bIds = b.req_id ? [String(b.req_id).toLowerCase().replace(/[-_]/g, '')] : reqIds(b.job_title, b.email_subject, b.job_description);
  if (aIds.length && bIds.length) {
    const shared = aIds.some((x) => bIds.includes(x));
    return { same: shared, basis: shared ? 'same requisition id' : 'different requisition ids', similarity: null };
  }

  // Two named end clients that differ are two positions however alike the
  // titles read: one recruiter filling "ServiceNow Developer" at Acme and at
  // Globex is working two openings, not one.
  const ca = clean(a.end_client), cb = clean(b.end_client);
  const clientsDiffer = Boolean(ca && cb && ca !== cb);

  const similarity = titleSimilarity(a.job_title, b.job_title);
  if (similarity != null) {
    if (clientsDiffer) return { same: false, basis: 'a different end client', similarity };
    if (similarity >= SAME_ROLE) return { same: true, basis: 'same job title', similarity };
    if (similarity >= NEAR_ROLE) {
      return ca && cb
        ? { same: true, basis: 'similar job title at the same client', similarity }
        : { same: true, basis: 'similar job title, no client to separate them', similarity };
    }
    return { same: false, basis: 'different job title', similarity };
  }
  if (clientsDiffer) return { same: false, basis: 'a different end client', similarity: null };

  // No titles to compare: fall back to the email subject.
  const sa = roleKey(a.email_subject), sb = roleKey(b.email_subject);
  if (sa && sb) {
    if (sa === sb) return { same: true, basis: 'same email subject', similarity: null };
    const subjectSimilarity = titleSimilarity(sa, sb);
    if (subjectSimilarity != null && subjectSimilarity >= SAME_ROLE) return { same: true, basis: 'matching email subject', similarity: subjectSimilarity };
    return { same: false, basis: 'different email subject', similarity: subjectSimilarity };
  }
  // One side has a title and the other has nothing at all: not enough to split
  // them, and not enough to merge them either.
  if (!titleTokens(a.job_title).length && !titleTokens(b.job_title).length && !sa && !sb) {
    return { same: true, basis: 'nothing to tell them apart', similarity: null };
  }
  return { same: false, basis: 'not enough in common', similarity: null };
}

/** Back-compatible boolean form used by the duplicate check. */
function sameRole(a, b) { return roleMatch(a || {}, b || {}).same; }

/** Normalise a Message-ID so the angle brackets and case never matter. */
const normId = (v) => String(v == null ? '' : v).trim().replace(/^<|>$/g, '').toLowerCase();

/** Every message id an inbound email says it is a reply to, newest first. */
function threadRefs(msg) {
  const out = [];
  const push = (v) => { const id = normId(v); if (id && !out.includes(id)) out.push(id); };
  push(msg.in_reply_to);
  const refs = msg.references;
  if (Array.isArray(refs)) refs.slice().reverse().forEach(push);
  else if (refs) String(refs).split(/\s+/).reverse().forEach(push);
  return out;
}

/**
 * Decide which lead an inbound message belongs to.
 *
 * @param {object} msg    { subject, from_email, text, in_reply_to, references, thread_id }
 * @param {object[]} leads every lead for this sender
 * @param {Map<string,string>} knownIds message id -> lead id, from leads and lead_emails
 * @returns {{lead: object|null, basis: string, confident: boolean, reason: string}}
 *   `confident` false means the caller must not auto-send anything.
 */
function pickLeadForReply(msg, leads, knownIds = new Map()) {
  if (!leads || !leads.length) return { lead: null, basis: 'none', confident: false, reason: 'no existing lead for this sender' };
  const byId = new Map(leads.map((l) => [String(l.id), l]));

  // 1. The mail thread itself: the only evidence that cannot be coincidence.
  for (const ref of threadRefs(msg)) {
    const leadId = knownIds.get(ref);
    if (leadId && byId.has(String(leadId))) {
      return { lead: byId.get(String(leadId)), basis: 'thread', confident: true, reason: `replies to a message in this lead's conversation (${ref})` };
    }
  }

  // 2. The mail provider's own conversation id.
  if (msg.thread_id) {
    const hit = leads.find((l) => l.thread_id && String(l.thread_id) === String(msg.thread_id));
    if (hit) return { lead: hit, basis: 'thread_id', confident: true, reason: 'same mailbox conversation' };
  }

  // 3. The role. Exactly one match is good enough; several or none is not.
  const incoming = { job_title: '', email_subject: msg.subject, job_description: msg.text, end_client: '' };
  const matches = leads.filter((l) => roleMatch(l, incoming).same);
  if (matches.length === 1) {
    return { lead: matches[0], basis: 'role', confident: true, reason: `subject matches this lead's role (${roleMatch(matches[0], incoming).basis})` };
  }
  if (matches.length > 1) {
    const newest = matches.slice().sort(byRecency)[0];
    return { lead: newest, basis: 'ambiguous', confident: false, reason: `${matches.length} open roles with this recruiter could match this reply` };
  }

  // Nothing matched on role. If the recruiter only has one thing open with us,
  // it is almost certainly about that; still not confident enough to auto-send.
  const open = leads.filter((l) => !['declined', 'closed_no_response', 'opportunity_created'].includes(String(l.workflow_status || '')));
  if (open.length === 1) {
    return { lead: open[0], basis: 'only_open', confident: false, reason: 'the only role open with this recruiter, but the subject does not match it' };
  }
  return { lead: null, basis: 'none', confident: false, reason: 'no lead for this recruiter matches this message' };
}

function byRecency(a, b) {
  const t = (l) => new Date(l.last_inbound_at || l.replied_at || l.email_received_at || l.created_at || 0).getTime();
  return t(b) - t(a);
}

module.exports = { roleKey, reqIds, roleMatch, sameRole, threadRefs, pickLeadForReply, normId, SAME_ROLE, NEAR_ROLE };
