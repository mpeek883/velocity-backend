// AI-based candidate matching.
//
// Two layers, blended:
//   1. A deterministic profile score built only from dimensions that actually
//      carry information for this pairing (skills, title, experience, location
//      and work arrangement, rate, availability). A dimension with nothing to
//      compare is dropped and the remaining weights are renormalised, so the
//      score always means "how well does this person fit on the things we
//      actually know" instead of quietly averaging in placeholder numbers.
//   2. A model assessment for the top candidates (Claude, structured output)
//      that reads the job text and the candidate's background and scores
//      skills, experience, domain and logistics fit with a written rationale.
//
// Why dimensions are dropped rather than defaulted: the previous version gave
// every empty dimension a fixed middling score (skills 50, experience 60,
// location/rate/availability 70). When a job order carried no requirements -
// which is the normal state for one created straight from a recruiter email -
// every candidate was scored on placeholders alone and came out with the same
// number for everyone. Dropping empty dimensions means an under-specified job
// order produces a low-confidence score over the few real signals instead of a
// confident-looking constant, and `requirements_missing` says what to add.

const Anthropic = require('@anthropic-ai/sdk');
const { screenUS } = require('./work-auth');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const skills = require('./skills');

const MODEL = process.env.MATCH_AI_MODEL || 'claude-opus-5';
const { normSkill, skillList, extractSkills, roleRequirements, titleSimilarity } = skills;

// Base weights. Renormalised across whichever dimensions have a signal.
const WEIGHTS = { skills: 0.4, title: 0.15, experience: 0.15, location: 0.1, rate: 0.1, availability: 0.1 };

// A gap on the job order and a gap on the candidate record are different
// things. If the job order never stated a requirement, the candidate cannot be
// marked down for it, so that dimension is dropped. If the requirement exists
// but the candidate record has nothing to check it against, that is a real
// weakness in the submission - somebody whose experience, location or
// availability is unknown is genuinely a worse bet than somebody whose is
// known and fits - so it scores badly at half weight and is flagged `unknown`
// with the reason, which tells the recruiter exactly which field to fill in.
const UNKNOWN = { score: 30, factor: 0.5 };
const UNKNOWN_RATE = 55; // a missing desired rate is common and nearly neutral

const numFrom = (v) => {
  const m = String(v == null ? '' : v).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

/** Everything a candidate demonstrably knows: listed skills plus skills found in their own text. */
function candidateSkills(candidate) {
  const listed = skillList(candidate.skills);
  const text = `${candidate.title || ''}\n${candidate.resume_text || ''}\n${candidate.notes || ''}`;
  return { listed, all: [...new Set([...listed, ...extractSkills(text, listed)])], text };
}

/** What the role needs, from the target's structured fields and its job text. */
function targetRequirements(target) {
  return roleRequirements({
    title: target.title,
    description: target.description,
    required_skills: target.skills,
    nice_to_have_skills: target.nice_to_have_skills,
    extraText: target.extra_text || '',
  });
}

/**
 * Deterministic score for one candidate against one target.
 * Returns { score, confidence, signals, breakdown, requirements_missing }.
 *   score       0-100, or null when nothing at all could be compared
 *   confidence  0-1: the share of the full weighting that had real signal
 */
function deterministicScore(candidate, target, precomputed = null) {
  const req = precomputed || targetRequirements(target);
  const cand = candidateSkills(candidate);
  const breakdown = {};

  // ---- Skills: must-haves outweigh nice-to-haves, which outweigh skills
  // merely mentioned somewhere in the job text. The third tier matters: a job
  // order with only a title still names a technology, and without it such a
  // job order would have no skills signal at all. ----
  const must = req.must, nice = req.nice, mentioned = req.mentioned || [];
  const weighted = [
    ...must.map((s) => ({ skill: s, w: 2 })),
    ...nice.map((s) => ({ skill: s, w: 1 })),
    ...mentioned.map((s) => ({ skill: s, w: 0.5 })),
  ];
  if (weighted.length) {
    const has = (s) => cand.all.includes(s);
    const matched = weighted.filter((x) => has(x.skill));
    const missing = weighted.filter((x) => !has(x.skill));
    const earned = matched.reduce((a, x) => a + x.w, 0);
    const possible = weighted.reduce((a, x) => a + x.w, 0);
    breakdown.skills = {
      score: Math.round((earned / possible) * 100),
      weight: WEIGHTS.skills, signal: true,
      matched: matched.map((x) => x.skill), missing: missing.map((x) => x.skill),
      required_total: must.length, nice_total: nice.length, mentioned_total: mentioned.length,
      // Extra relevant skills are informational, never a penalty.
      additional: cand.all.filter((s) => !weighted.some((x) => x.skill === s)).slice(0, 12),
    };
  } else {
    breakdown.skills = { score: null, weight: WEIGHTS.skills, signal: false, matched: [], missing: [], reason: 'no required skills on the job order and none found in its description' };
  }

  // ---- Title ----
  const titleScore = titleSimilarity(target.title, candidate.title);
  if (titleScore != null) {
    breakdown.title = { score: Math.round(titleScore * 100), weight: WEIGHTS.title, signal: true, target_title: target.title, candidate_title: candidate.title };
  } else if (String(target.title || '').trim()) {
    breakdown.title = { score: UNKNOWN.score, weight: WEIGHTS.title * UNKNOWN.factor, signal: true, unknown: true, target_title: target.title, candidate_title: null, reason: 'no current title on the candidate record' };
  } else {
    breakdown.title = { score: null, weight: WEIGHTS.title, signal: false, reason: 'the job order has no title' };
  }

  // ---- Experience ----
  const needYears = req.years;
  const haveYears = candidate.experience_years == null || candidate.experience_years === '' ? null : Number(candidate.experience_years);
  if (needYears != null && haveYears != null) {
    // Meeting the bar is full marks; beyond it adds nothing, short of it scales.
    breakdown.experience = { score: haveYears >= needYears ? 100 : Math.max(0, Math.round((haveYears / needYears) * 100)), weight: WEIGHTS.experience, signal: true, required_years: needYears, candidate_years: haveYears };
  } else if (haveYears != null) {
    // No stated requirement: seniority is a weak signal, at half weight, and
    // flagged so the app can say the job order never stated a bar.
    breakdown.experience = { score: Math.min(100, Math.round(40 + haveYears * 6)), weight: WEIGHTS.experience / 2, signal: true, inferred: true, required_years: null, candidate_years: haveYears, reason: 'the job order states no experience requirement; scored on seniority alone' };
  } else if (needYears != null) {
    breakdown.experience = { score: UNKNOWN.score, weight: WEIGHTS.experience * UNKNOWN.factor, signal: true, unknown: true, required_years: needYears, candidate_years: null, reason: 'the role asks for years of experience and the candidate record has none on file' };
  } else {
    breakdown.experience = { score: null, weight: WEIGHTS.experience, signal: false, required_years: null, candidate_years: null, reason: 'neither the job order nor the candidate record states experience' };
  }

  // ---- Location and work arrangement ----
  const arrangement = String(target.work_arrangement || '').toLowerCase();
  const tLoc = String(target.location || '').toLowerCase();
  const cLoc = String(candidate.location || '').toLowerCase();
  if (arrangement.includes('remote') || /\bremote\b/.test(tLoc)) {
    breakdown.location = { score: 100, weight: WEIGHTS.location, signal: true, reason: 'the role is remote' };
  } else if (tLoc && cLoc) {
    const city = tLoc.replace(/^(hybrid|on-?site|remote)\s*-\s*/, '').split(',')[0].trim();
    const state = (tLoc.match(/\b([a-z]{2})\b\s*$/) || [])[1];
    const score = city && cLoc.includes(city) ? 100 : (state && cLoc.includes(state) ? 75 : 25);
    breakdown.location = { score, weight: WEIGHTS.location, signal: true, target_location: target.location, candidate_location: candidate.location };
  } else if (tLoc) {
    breakdown.location = { score: UNKNOWN.score, weight: WEIGHTS.location * UNKNOWN.factor, signal: true, unknown: true, target_location: target.location, candidate_location: null, reason: 'the role is not remote and the candidate record has no location' };
  } else {
    breakdown.location = { score: null, weight: WEIGHTS.location, signal: false, reason: 'the job order has no location or work arrangement' };
  }

  // ---- Rate ----
  const tRate = numFrom(target.rate) ?? req.rate;
  const cRate = candidate.desired_rate == null || candidate.desired_rate === '' ? null : Number(candidate.desired_rate);
  if (tRate && cRate) {
    breakdown.rate = { score: cRate <= tRate ? 100 : Math.max(0, Math.round(100 - ((cRate - tRate) / tRate) * 200)), weight: WEIGHTS.rate, signal: true, target_rate: Math.round(tRate), candidate_rate: cRate };
  } else if (tRate) {
    breakdown.rate = { score: UNKNOWN_RATE, weight: WEIGHTS.rate * UNKNOWN.factor, signal: true, unknown: true, target_rate: Math.round(tRate), candidate_rate: null, reason: 'no desired rate on the candidate record' };
  } else {
    breakdown.rate = { score: null, weight: WEIGHTS.rate, signal: false, target_rate: null, candidate_rate: cRate, reason: 'the job order states no rate' };
  }

  // ---- Availability ----
  const avail = String(candidate.availability || '').toLowerCase();
  const status = String(candidate.status || '').toLowerCase();
  if (avail || status) {
    let score = 70;
    if (avail.includes('not') || status === 'placed' || status === 'dnc') score = 10;
    else if (avail.includes('soon') || avail.includes('week') || avail.includes('notice')) score = 60;
    else if (avail.includes('available') || avail.includes('immediate') || status === 'active') score = 100;
    breakdown.availability = { score, weight: WEIGHTS.availability, signal: true, availability: candidate.availability || null, status: candidate.status || null };
  } else {
    breakdown.availability = { score: UNKNOWN.score, weight: WEIGHTS.availability * UNKNOWN.factor, signal: true, unknown: true, availability: null, status: null, reason: 'no availability or status on the candidate record' };
  }

  const live = Object.values(breakdown).filter((b) => b.signal);
  const totalWeight = live.reduce((a, b) => a + b.weight, 0);
  const score = totalWeight ? Math.round(live.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight) : null;
  const fullWeight = Object.values(WEIGHTS).reduce((a, w) => a + w, 0);

  return {
    score,
    confidence: Math.round((totalWeight / fullWeight) * 100) / 100,
    signals: Object.entries(breakdown).filter(([, b]) => b.signal).map(([k]) => k),
    breakdown,
    requirements_missing: requirementsMissing(req, target),
  };
}

/** What the job order is missing that would make scores meaningful. */
function requirementsMissing(req, target) {
  const gaps = [];
  if (!req.must.length && !req.nice.length) gaps.push('required skills');
  if (req.years == null) gaps.push('years of experience');
  if (!String(target.title || '').trim()) gaps.push('a job title');
  if (!String(target.location || '').trim() && !String(target.work_arrangement || '').trim()) gaps.push('a location or work arrangement');
  if (!numFrom(target.rate) && req.rate == null) gaps.push('a rate');
  if (!String(target.description || '').trim()) gaps.push('a job description');
  return gaps;
}

const AssessmentSchema = z.object({
  skills_fit: z.number().min(0).max(100),
  experience_fit: z.number().min(0).max(100),
  domain_fit: z.number().min(0).max(100).describe('Industry / problem-domain familiarity relevant to this role.'),
  logistics_fit: z.number().min(0).max(100).describe('Location, work arrangement, rate, availability, authorization.'),
  overall: z.number().min(0).max(100).describe('Holistic likelihood this candidate is a strong submission for the role.'),
  strengths: z.array(z.string()).max(5),
  gaps: z.array(z.string()).max(5),
  rationale: z.string().describe('Two or three sentences a recruiter could repeat to the client.'),
});

let defaultClient = null;
function getClient() { if (!defaultClient) defaultClient = new Anthropic({ timeout: 90 * 1000, maxRetries: 2 }); return defaultClient; }
function _setClientForTests(c) { defaultClient = c; }
function isMatchAIConfigured() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

async function aiAssess(candidate, target, options = {}) {
  const client = options.client || getClient();
  const req = options.requirements || targetRequirements(target);
  const cand = candidateSkills(candidate);
  const payload = {
    role: {
      title: target.title, client: target.client_name || target.company || '', location: target.location,
      work_arrangement: target.work_arrangement, rate: target.rate, employment_type: target.employment_type,
      description: String(target.description || '').slice(0, 6000),
      required_skills: req.must, nice_to_have_skills: req.nice, required_years: req.years,
    },
    candidate: {
      title: candidate.title, years_experience: candidate.experience_years, skills: cand.all,
      location: candidate.location, availability: candidate.availability, work_authorization: candidate.work_auth,
      desired_rate: candidate.desired_rate, background: String(candidate.resume_text || '').slice(0, 6000),
      notes: String(candidate.notes || '').slice(0, 1500),
    },
  };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [
      'You are a senior technical recruiter scoring how well a candidate matches a specific role.',
      'Be rigorous and calibrated: 90+ means an immediate submission, 70-89 a solid candidate with minor gaps, 50-69 a stretch, below 50 not a fit.',
      'Spread your scores. Two candidates are almost never equally good; if the information is thin, say so in the rationale and score on what you can see rather than putting everyone in the middle.',
      'Use only the information given. Never assume a skill the candidate has not evidenced.',
    ].join(' '),
    output_config: { effort: 'medium', format: zodOutputFormat(AssessmentSchema) },
    messages: [{ role: 'user', content: `Score this match.\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>` }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
  return { ...response.parsed_output, model: response.model || MODEL };
}

/**
 * How much to trust the model over the profile score. When the job order
 * carries real requirements the profile score is worth 40%; when it carries
 * almost nothing the model - which reads the raw text - should dominate.
 */
function blendWeights(confidence) {
  if (confidence >= 0.8) return { det: 0.4, ai: 0.6 };
  if (confidence >= 0.5) return { det: 0.3, ai: 0.7 };
  return { det: 0.15, ai: 0.85 };
}

/**
 * Rank candidates for a target (opportunity or job order).
 * deps: { pool, target, candidates?, limit, aiTop, useAI, usOnly, strictUS, client }
 */
async function rankCandidates(deps) {
  const { pool, target } = deps;
  const limit = Number(deps.limit || 10);
  const aiTop = Number(deps.aiTop ?? 5);
  const useAI = deps.useAI !== false && (deps.client || isMatchAIConfigured());
  const all = deps.candidates || (await pool.query("SELECT * FROM candidates WHERE COALESCE(status,'active') NOT IN ('DNC','dnc') ORDER BY id")).rows;
  const requirements = targetRequirements(target);

  // US work authorization screen (on by default): candidates who need
  // sponsorship or are outside the US are never ranked; with strict on,
  // candidates with nothing on file are held back too.
  const usOnly = deps.usOnly !== false, strictUS = deps.strictUS !== false;
  const excluded = { not_authorized: 0, unknown: 0 };
  const candidates = [];
  const screens = new Map();
  for (const c of all) {
    const scr = screenUS({ workAuth: c.work_auth, location: c.location, text: `${c.resume_text || ''}\n${c.notes || ''}` });
    screens.set(String(c.id), scr);
    if (usOnly && scr.eligible === false) { excluded.not_authorized += 1; continue; }
    if (usOnly && strictUS && scr.eligible === null) { excluded.unknown += 1; continue; }
    candidates.push(c);
  }

  const scored = candidates
    .map((c) => ({ candidate: c, det: deterministicScore(c, target, requirements) }))
    .sort((a, b) => (b.det.score ?? -1) - (a.det.score ?? -1));

  const results = [];
  for (let i = 0; i < Math.min(scored.length, limit); i++) {
    const { candidate, det } = scored[i];
    let ai = null;
    if (useAI && i < aiTop) {
      try { ai = await aiAssess(candidate, target, { client: deps.client, requirements }); } catch (err) { ai = { error: err.message }; }
    }
    const aiScore = ai && ai.overall != null ? Math.round(ai.overall) : null;
    const mix = blendWeights(det.confidence);
    const final = aiScore != null
      ? (det.score == null ? aiScore : Math.round(det.score * mix.det + aiScore * mix.ai))
      : det.score;
    results.push({
      candidate_id: candidate.id, candidate_name: candidate.name, candidate_title: candidate.title,
      score: final, deterministic_score: det.score, ai_score: aiScore,
      confidence: det.confidence, signals: det.signals, breakdown: det.breakdown,
      ai, rank: 0, us_work: screens.get(String(candidate.id)),
    });
  }
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  results.forEach((r, i) => { r.rank = i + 1; });

  // Surfaced by the app so an under-specified job order explains itself
  // instead of showing everyone the same unexplained number.
  const dets = results.map((r) => r.deterministic_score).filter((s) => s != null);
  const flat = dets.length > 1 && new Set(dets).size === 1;
  const missing = requirementsMissing(requirements, target);
  results.excluded = excluded;
  results.us_only = usOnly;
  results.strict_us = strictUS;
  results.requirements = { required_skills: requirements.must, nice_to_have_skills: requirements.nice, required_years: requirements.years };
  results.requirements_missing = missing;
  results.confidence = results.length ? Math.max(...results.map((r) => r.confidence || 0)) : 0;
  results.warning = flat
    ? `Every candidate scored the same on profile match because this job order has nothing to tell them apart. Add ${missing.slice(0, 3).join(', ') || 'requirements'} to the job order, then score again.`
    : (missing.length >= 4 ? `Scores are low-confidence: this job order is missing ${missing.slice(0, 3).join(', ')}.` : null);
  return results;
}

async function storeMatches(pool, target, results) {
  await pool.query('DELETE FROM candidate_matches WHERE target_kind=$1 AND target_id=$2', [target.kind, String(target.id)]);
  for (const r of results) {
    await pool.query(
      `INSERT INTO candidate_matches (target_kind, target_id, candidate_id, rank, score, deterministic_score, ai_score, breakdown, rationale, strengths, gaps, model, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [target.kind, String(target.id), String(r.candidate_id), r.rank, r.score, r.deterministic_score, r.ai_score, JSON.stringify(r.breakdown),
        r.ai && r.ai.rationale ? r.ai.rationale : null, r.ai && r.ai.strengths ? JSON.stringify(r.ai.strengths) : null,
        r.ai && r.ai.gaps ? JSON.stringify(r.ai.gaps) : null, r.ai && r.ai.model ? r.ai.model : null, r.confidence == null ? null : r.confidence]);
  }
}

function targetFromOpportunity(o) {
  return {
    kind: 'opportunity', id: o.id, title: o.job_title || o.name, description: o.job_description || o.notes || '',
    skills: o.required_skills || '', nice_to_have_skills: '', location: o.work_location || '',
    work_arrangement: o.work_arrangement || '', rate: o.rate || (o.value != null ? String(o.value) : ''),
    client_name: o.client_name || o.account || '', employment_type: o.employment_type || '',
  };
}
function targetFromJobOrder(j) {
  return {
    kind: 'job_order', id: j.id, title: j.title, description: j.description || '',
    skills: j.required_skills || '', nice_to_have_skills: j.nice_to_have_skills || '',
    // The location column holds "Hybrid - Rockville, MD" for job orders opened
    // from a lead, so the arrangement is read out of it when not set separately.
    location: j.location || '', work_arrangement: j.work_arrangement || j.location || '',
    rate: j.salary_range || '', client_name: j.company || '', employment_type: j.employment_type || '',
    // The posting and the client's intake answers are part of the role text.
    extra_text: [j.job_posting || '', j.intake_data ? String(j.intake_data) : ''].filter(Boolean).join('\n\n'),
  };
}

module.exports = {
  deterministicScore, aiAssess, rankCandidates, storeMatches, targetFromOpportunity, targetFromJobOrder,
  targetRequirements, requirementsMissing, blendWeights, candidateSkills,
  skillList, normSkill, isMatchAIConfigured, MODEL, _setClientForTests, WEIGHTS,
};
