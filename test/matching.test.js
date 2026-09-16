const test = require('node:test');
const assert = require('node:assert');
const matching = require('../matching');
const skills = require('../skills');

const JOB = {
  id: 1, title: 'ServiceNow ITAM Developer', company: 'Acme',
  location: 'Hybrid - Rockville, MD', salary_range: '$85/hr',
  description: [
    'We are looking for a ServiceNow developer to build out IT Asset Management.',
    '',
    'Required:',
    '- 6+ years of experience with ServiceNow',
    '- Strong ITAM and CMDB background',
    '- JavaScript and Flow Designer',
    '',
    'Nice to have:',
    '- Flexera or Snow License Manager',
    '- ITIL certification',
  ].join('\n'),
};
const target = matching.targetFromJobOrder(JOB);

const strong = { id: 'a', name: 'Strong', title: 'Senior ServiceNow Developer', skills: ['ServiceNow', 'ITAM', 'CMDB', 'JavaScript', 'Flow Designer', 'ITIL'], experience_years: 8, location: 'Rockville, MD', desired_rate: 80, availability: 'Available', status: 'active' };
const partial = { id: 'b', name: 'Partial', title: 'ServiceNow Administrator', skills: ['ServiceNow', 'ITSM'], experience_years: 4, location: 'Baltimore, MD', desired_rate: 90, availability: 'Available', status: 'active' };
const weak = { id: 'c', name: 'Weak', title: 'Java Developer', skills: ['Java', 'Spring'], experience_years: 2, location: 'Austin, TX', desired_rate: 110, availability: 'Not available', status: 'active' };

test('a real job order separates candidates instead of scoring them all alike', () => {
  const s = matching.deterministicScore(strong, target).score;
  const p = matching.deterministicScore(partial, target).score;
  const w = matching.deterministicScore(weak, target).score;
  assert.ok(s > p, `strong (${s}) should beat partial (${p})`);
  assert.ok(p > w, `partial (${p}) should beat weak (${w})`);
  assert.equal(new Set([s, p, w]).size, 3, 'three different candidates must not share one score');
});

test('required skills outweigh nice-to-haves', () => {
  const r = matching.deterministicScore(strong, target);
  assert.ok(r.breakdown.skills.signal);
  assert.ok(r.breakdown.skills.required_total >= 3, `expected the required list to be read: ${JSON.stringify(r.breakdown.skills)}`);
  assert.ok(r.breakdown.skills.matched.includes('servicenow'));
});

test('the experience requirement is read out of the description', () => {
  const r = matching.deterministicScore(partial, target);
  assert.equal(r.breakdown.experience.required_years, 6);
  assert.equal(r.breakdown.experience.candidate_years, 4);
  assert.ok(r.breakdown.experience.score < 100);
});

test('an empty job order scores low-confidence and says what is missing', () => {
  const empty = matching.targetFromJobOrder({ id: 2, title: '', description: '', required_skills: '', location: '', salary_range: '' });
  const r = matching.deterministicScore(strong, empty);
  assert.ok(r.confidence < 0.4, `confidence should be low, got ${r.confidence}`);
  assert.ok(r.requirements_missing.includes('required skills'));
  assert.ok(r.requirements_missing.includes('a job description'));
  assert.equal(r.breakdown.skills.signal, false);
  assert.equal(r.breakdown.title.signal, false);
});

test('a requirement the candidate record cannot answer counts against them', () => {
  // The job order asks for 6 years; this candidate record says nothing, so the
  // dimension is scored badly and flagged rather than silently dropped.
  const blank = { id: 'e', name: 'Unknown', title: 'ServiceNow Developer', skills: ['ServiceNow'] };
  const r = matching.deterministicScore(blank, target);
  assert.equal(r.breakdown.experience.signal, true);
  assert.equal(r.breakdown.experience.unknown, true);
  assert.ok(r.breakdown.experience.score < 50);
  assert.ok(/candidate record/.test(r.breakdown.availability.reason));
});

test('a candidate we know nothing about never outranks one we do', () => {
  const nothing = { id: 'f', name: 'Nothing on file' };
  const bare = matching.targetFromJobOrder({ id: 4, title: 'ServiceNow Developer', description: '', location: 'Remote' });
  const blankScore = matching.deterministicScore(nothing, bare).score;
  const strongScore = matching.deterministicScore(strong, bare).score;
  assert.ok(blankScore < strongScore, `empty record (${blankScore}) must not beat a real one (${strongScore})`);
  assert.ok(blankScore < 60, `an empty candidate record should not look like a match, got ${blankScore}`);
});

test('a bare job order no longer gives every candidate the same number', () => {
  // The shape that produced the reported "everyone is 67%": a job order with a
  // title and a location but no requirements at all.
  const bare = matching.targetFromJobOrder({ id: 5, title: 'ServiceNow Developer', description: '', location: 'Remote' });
  const scores = [strong, partial, weak].map((c) => matching.deterministicScore(c, bare).score);
  assert.equal(new Set(scores).size, 3, `expected distinct scores, got ${scores.join(', ')}`);
});

test('the model gets more of the blend when the job order is thin', () => {
  assert.deepEqual(matching.blendWeights(0.9), { det: 0.4, ai: 0.6 });
  assert.deepEqual(matching.blendWeights(0.6), { det: 0.3, ai: 0.7 });
  assert.deepEqual(matching.blendWeights(0.2), { det: 0.15, ai: 0.85 });
});

test('skills are read out of free text with synonyms folded together', () => {
  const found = skills.extractSkills('Hands-on with Service Now, k8s, and node js.');
  assert.ok(found.includes('servicenow'), JSON.stringify(found));
  assert.ok(found.includes('kubernetes'), JSON.stringify(found));
  assert.ok(found.includes('node.js'), JSON.stringify(found));
});

test('title similarity ignores seniority words but not the actual role', () => {
  assert.equal(skills.titleSimilarity('Senior ServiceNow Developer', 'ServiceNow Developer'), 1);
  assert.ok(skills.titleSimilarity('ServiceNow Developer', 'ServiceNow Administrator') < 0.6);
  assert.equal(skills.titleSimilarity('', 'Developer'), null);
});

test('rates are read as hourly whichever way they are written', () => {
  assert.equal(skills.parseRate('$85/hr'), 85);
  assert.equal(Math.round(skills.parseRate('$150k')), 72);
  assert.equal(skills.parseRate('no money here'), null);
});
