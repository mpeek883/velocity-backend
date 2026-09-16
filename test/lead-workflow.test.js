const test = require('node:test');
const assert = require('node:assert');
const workflow = require('../lead-workflow');

// A pool stand-in: enough of Postgres to exercise the decision tree.
function fakePool(lead) {
  const state = { lead: { ...lead }, emails: [], updates: [] };
  return {
    state,
    async query(sql, params = []) {
      if (/INSERT INTO lead_emails/i.test(sql)) {
        const row = { id: state.emails.length + 1, lead_id: params[0], direction: params[1], kind: params[2], subject: params[3], body: params[4], created_at: new Date() };
        state.emails.push(row);
        return { rows: [row] };
      }
      if (/SELECT created_at FROM lead_emails/i.test(sql)) {
        const hits = state.emails.filter((e) => e.direction === 'outbound' && e.kind === params[1]);
        return { rows: hits.length ? [hits[hits.length - 1]] : [] };
      }
      if (/^UPDATE leads SET/i.test(sql)) {
        const cols = [...sql.matchAll(/(\w+)=\$\d+/g)].map((m) => m[1]);
        cols.forEach((c, i) => { state.lead[c] = params[i]; });
        state.updates.push(cols);
        return { rows: [{ ...state.lead }] };
      }
      return { rows: [] };
    },
  };
}
const sendOptions = { transporter: { sendMail: async () => ({ messageId: '<sent@peek>' }) } };
const LEAD = {
  id: 1, name: 'Dana Reyes', email: 'dana@agency.com', company: 'Agency', job_title: 'ServiceNow Developer',
  end_client: 'Acme', job_description: 'A long enough description of the ServiceNow build work to count as on file.',
  rate_or_salary: '$85/hr', work_arrangement: 'Remote', job_location: 'Remote', email_subject: 'ServiceNow Developer',
  workflow_status: 'replied', status: 'contacted',
};
const analyzer = (out) => async () => out;

test('a recruiter question that needs judgement is drafted, never sent', async () => {
  const pool = fakePool(LEAD);
  const r = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'RE: ServiceNow Developer', text: 'What is your fee on this one, and can you do it exclusively?' }, {
    analyze: analyzer({ interest: 'interested', provided: {}, summary: 'asks about fee and exclusivity', response_complexity: 'complex', questions: ['What is your fee?', 'Can you work exclusively?'], needs_human: true }),
    sendOptions,
  });
  assert.ok(['draft_awaiting_approval', 'ready_to_authorize_with_draft'].includes(r.action), r.action);
  assert.equal(pool.state.lead.status, 'draft_review', 'the Leads screen must show it needs approval');
  assert.ok(pool.state.lead.draft_body, 'a draft must be waiting on the lead');
  assert.equal(pool.state.emails.filter((e) => e.direction === 'outbound').length, 0, 'nothing may be sent');
});

test('a reply whose position is uncertain is never answered automatically', async () => {
  const pool = fakePool(LEAD);
  const r = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'quick one', text: 'Yes please go ahead.' }, {
    analyze: analyzer({ interest: 'interested', provided: {}, summary: 'yes', response_complexity: 'simple', questions: [], needs_human: false }),
    routing: { confident: false, basis: 'ambiguous', reason: '2 open roles with this recruiter could match this reply' },
    sendOptions,
  });
  assert.equal(r.action, 'draft_awaiting_approval');
  assert.ok(/could not be confirmed/.test(pool.state.lead.draft_reason), pool.state.lead.draft_reason);
  assert.equal(pool.state.emails.filter((e) => e.direction === 'outbound').length, 0);
  assert.notEqual(pool.state.lead.workflow_status, 'ready_to_authorize', 'an unconfirmed role must not be advanced on its own');
});

test('a simple decline still closes itself out automatically', async () => {
  const pool = fakePool({ ...LEAD, last_inbound_at: new Date() });
  const r = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'RE: ServiceNow Developer', text: 'Thanks, we filled it internally.' }, {
    analyze: analyzer({ interest: 'not_interested', provided: {}, summary: 'filled', response_complexity: 'simple', questions: [], needs_human: false }),
    routing: { confident: true, basis: 'thread', reason: 'same thread' },
    sendOptions,
  });
  assert.equal(r.action, 'declined_close_out_sent');
  assert.equal(pool.state.emails.filter((e) => e.kind === 'close_out').length, 1);
});

test('the same email is never sent twice to a recruiter who follows up', async () => {
  const pool = fakePool({ ...LEAD, rate_or_salary: '', last_inbound_at: new Date(Date.now() - 60000) });
  const opts = {
    analyze: analyzer({ interest: 'interested', provided: {}, summary: 'yes please', response_complexity: 'simple', questions: [], needs_human: false }),
    routing: { confident: true, basis: 'thread', reason: 'same thread' },
    sendOptions,
  };
  const first = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'RE: role', text: 'Yes, please help.' }, opts);
  assert.equal(first.action, 'info_requested');
  // They write again before answering the question; the same request must not go out a second time.
  const second = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'RE: role', text: 'Any update?' }, opts);
  assert.equal(second.action, 'info_already_requested');
  assert.equal(pool.state.emails.filter((e) => e.kind === 'info_request').length, 1, 'the info request must be sent exactly once');
});

test('a personal application is never answered by the workflow', async () => {
  const pool = fakePool({ ...LEAD, workflow_status: 'personal_interest', status: 'personal' });
  const r = await workflow.handleInboundReply(pool, pool.state.lead, { subject: 'RE: your application', text: 'Can you interview Thursday?' }, { sendOptions });
  assert.equal(r.action, 'personal_reply_received');
  assert.equal(pool.state.emails.filter((e) => e.direction === 'outbound').length, 0);
});
