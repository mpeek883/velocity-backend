const test = require('node:test');
const assert = require('node:assert');
const c = require('../conversation');

test('the same role written two ways is one position', () => {
  assert.ok(c.sameRole({ job_title: 'Senior ServiceNow Developer' }, { job_title: 'ServiceNow Developer' }));
  assert.ok(c.sameRole({ job_title: 'ServiceNow ITAM Developer' }, { job_title: 'ITAM ServiceNow Developer' }));
});

test('two different roles from one recruiter stay separate', () => {
  assert.equal(c.sameRole({ job_title: 'ServiceNow Developer' }, { job_title: 'ServiceNow Administrator' }), false);
  assert.equal(c.sameRole({ job_title: 'Java Developer' }, { job_title: 'Network Engineer' }), false);
});

test('a requisition id settles it either way', () => {
  const a = { job_title: 'Developer', email_subject: 'Req 448812 - Developer' };
  const b = { job_title: 'Engineer', email_subject: 'REQ-448812 opening' };
  assert.ok(c.roleMatch(a, b).same, 'the same req id means the same position whatever the titles say');
  const d = { job_title: 'Developer', email_subject: 'Req 990001 - Developer' };
  assert.equal(c.roleMatch(a, d).same, false, 'different req ids mean different positions');
});

test('near-identical titles are split by the end client', () => {
  const a = { job_title: 'ServiceNow Developer', end_client: 'Acme' };
  const b = { job_title: 'ServiceNow Developer II', end_client: 'Globex' };
  const same = { job_title: 'ServiceNow Developer II', end_client: 'Acme' };
  assert.equal(c.roleMatch(a, b).same, false);
  assert.ok(c.roleMatch(a, same).same);
});

test('a reply is routed by its mail thread before anything else', () => {
  const leads = [
    { id: 1, job_title: 'ServiceNow Developer', email_subject: 'ServiceNow Developer' },
    { id: 2, job_title: 'Network Engineer', email_subject: 'Network Engineer' },
  ];
  const known = new Map([['abc@mail', '2']]);
  const msg = { subject: 'RE: ServiceNow Developer', references: '<abc@mail>', text: '' };
  const r = c.pickLeadForReply(msg, leads, known);
  assert.equal(r.lead.id, 2, 'the thread wins over a subject that looks like the other lead');
  assert.equal(r.basis, 'thread');
  assert.ok(r.confident);
});

test('an ambiguous reply is never confidently attached', () => {
  const leads = [
    { id: 1, job_title: 'ServiceNow Developer', email_subject: 'ServiceNow Developer role', workflow_status: 'replied' },
    { id: 2, job_title: 'ServiceNow Developer', email_subject: 'ServiceNow Developer role', end_client: 'Globex', workflow_status: 'replied' },
  ];
  const r = c.pickLeadForReply({ subject: 'RE: ServiceNow Developer role', text: '' }, leads, new Map());
  assert.equal(r.confident, false);
  assert.equal(r.basis, 'ambiguous');
  assert.ok(r.lead, 'it still picks the most recent so the email is filed somewhere');
});

test('a reply that matches no role is not forced onto the newest lead', () => {
  const leads = [
    { id: 1, job_title: 'ServiceNow Developer', email_subject: 'ServiceNow Developer', workflow_status: 'replied' },
    { id: 2, job_title: 'Network Engineer', email_subject: 'Network Engineer', workflow_status: 'replied' },
  ];
  const r = c.pickLeadForReply({ subject: 'Salesforce Architect - new role', text: '' }, leads, new Map());
  assert.equal(r.lead, null);
  assert.equal(r.confident, false);
});

test('the one open role with a recruiter is filed but not trusted', () => {
  const leads = [
    { id: 1, job_title: 'ServiceNow Developer', workflow_status: 'replied' },
    { id: 2, job_title: 'Network Engineer', workflow_status: 'declined' },
  ];
  const r = c.pickLeadForReply({ subject: 'quick question', text: '' }, leads, new Map());
  assert.equal(r.lead.id, 1);
  assert.equal(r.confident, false, 'a vague subject must not trigger an automatic reply');
});

test('message ids are matched whatever the brackets and case', () => {
  assert.deepEqual(c.threadRefs({ in_reply_to: '<AbC@Mail>' }), ['abc@mail']);
  assert.deepEqual(c.threadRefs({ references: '<one@x> <two@y>' }), ['two@y', 'one@x']);
});
