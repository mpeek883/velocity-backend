const test = require('node:test');
const assert = require('node:assert');
const posting = require('../posting');

const job = {
  id: 7, title: 'ServiceNow ITAM Developer', company: 'Globex Staffing',
  location: 'Hybrid - Rockville, MD', salary_range: '$110/hr', pay_rate: '$85/hr',
  description: 'Build IT Asset Management on ServiceNow.\n\nRequired:\n- 6+ years ServiceNow\n- CMDB and ITAM\n- JavaScript',
};
const lead = { job_title: 'ServiceNow ITAM Developer', end_client: 'Acme Health', job_description: 'Acme Health needs ITAM build-out. Req 88213.', work_arrangement: 'Hybrid', job_location: 'Rockville, MD', rate_or_salary: '$110/hr bill' };

test('the template posting is usable with no model available', () => {
  const { posting: text } = posting.templatePosting(job, lead);
  assert.ok(text.includes('ServiceNow ITAM Developer'));
  assert.ok(/What you need/.test(text));
  assert.ok(/equal opportunity employer/i.test(text));
  assert.ok(/authorized to work in the United States/i.test(text));
});

test('a posting never leaks the end client or the bill rate', () => {
  const { posting: text } = posting.templatePosting(job, lead);
  assert.ok(!/Acme Health/i.test(text), 'the end client must not appear in a public posting');
  assert.ok(!/110/.test(text), 'the client bill rate must not appear in a public posting');
  assert.ok(!/88213/.test(text), 'requisition ids must not appear in a public posting');
});

test('the work arrangement is read out of the location field', () => {
  const ctx = posting.postingContext(job, lead);
  assert.equal(ctx.arrangement, 'Hybrid');
  assert.equal(ctx.location, 'Rockville, MD');
  assert.equal(ctx.years, 6);
  assert.ok(ctx.required.includes('servicenow'));
});

test('every board a posting can go to has somewhere to go', () => {
  assert.ok(posting.BOARDS.length >= 4);
  for (const b of posting.BOARDS) {
    assert.ok(b.id && b.name, JSON.stringify(b));
    if (b.id !== 'other') assert.ok(b.post_url.startsWith('https://'), `${b.id} needs a post URL`);
  }
});
