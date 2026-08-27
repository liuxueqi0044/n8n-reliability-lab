import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import * as database from '../helpers/database.mjs';
import { waitFor } from '../helpers/polling.mjs';
import { countRequests, resetWireMock } from '../helpers/wiremock.mjs';

const root = process.cwd();
const n8nUrl = `http://127.0.0.1:${process.env.N8N_HOST_PORT ?? 5678}`;
const operatorHeader = process.env.LAB_OPERATOR_HEADER_NAME ?? 'x-lab-operator-key';
const operatorValue = process.env.LAB_OPERATOR_HEADER_VALUE ?? 'operator_local_only';
const createdEventIds = new Set();

const fixture = async (name) => JSON.parse(await readFile(join(root, 'tests/fixtures/approval', name), 'utf8'));
const eventId = () => `test_approval_${randomUUID()}`;

async function post(path, body, { authorized = true, headers: extraHeaders = {} } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (authorized) headers[operatorHeader] = operatorValue;
  const response = await fetch(`${n8nUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* auth middleware may return non-JSON */ }
  return { response, body: parsed, text };
}

async function approvalPayload(name, id = eventId()) {
  const payload = await fixture(name);
  payload.event_id = id;
  createdEventIds.add(id);
  return payload;
}

async function intake(payload) {
  const result = await post('/webhook/lead-intake', payload, { authorized: false });
  assert.equal(result.response.status, 202);
  return result;
}

async function eventRow(id, expectedStatus) {
  return waitFor(async () => {
    const row = await database.getInboundEvent(id);
    return row && (!expectedStatus || row.status === expectedStatus) ? row : null;
  }, { timeoutMs: 20_000, description: `${id} to become ${expectedStatus ?? 'available'}` });
}

async function crmCount(id) {
  return countRequests({ path: '/crm/leads/success', eventId: id });
}

before(async () => {
  await database.waitForDatabase();
});

beforeEach(async () => {
  await resetWireMock();
});

afterEach(async () => {
  await database.deleteTestEvents([...createdEventIds]);
  createdEventIds.clear();
  await resetWireMock();
});

after(async () => {
  await database.closeDatabase();
});

test('high-value intake awaits approval with zero CRM calls, then approved delivery is 200 and delivered once', async () => {
  const payload = await approvalPayload('high-value.json');
  const accepted = await intake(payload);
  assert.equal(accepted.body.status, 'awaiting_approval');
  assert.equal(accepted.body.classification, 'high_value');
  assert.equal(accepted.body.requires_approval, true);
  await eventRow(payload.event_id, 'awaiting_approval');
  assert.equal(await crmCount(payload.event_id), 0);

  const decision = await post('/webhook/lead-approval', {
    event_id: payload.event_id,
    decision: 'approved',
    decided_by: 'reviewer@example.test',
    reason: 'Qualified fictional account',
  });
  assert.equal(decision.response.status, 200);
  assert.match(decision.response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(decision.body?.accepted, true);
  assert.equal(decision.body?.event_id, payload.event_id);
  assert.equal(decision.body?.status, 'delivered');
  await eventRow(payload.event_id, 'delivered');
  assert.equal(await crmCount(payload.event_id), 1);
});

test('repeating the same approval is a 200 no-op and does not add a CRM call', async () => {
  const payload = await approvalPayload('high-value.json');
  await intake(payload);
  await eventRow(payload.event_id, 'awaiting_approval');
  const body = { event_id: payload.event_id, decision: 'approved', decided_by: 'reviewer@example.test', reason: 'Approved once' };
  const first = await post('/webhook/lead-approval', body);
  assert.equal(first.response.status, 200);
  await eventRow(payload.event_id, 'delivered');
  assert.equal(await crmCount(payload.event_id), 1);

  const repeat = await post('/webhook/lead-approval', body);
  assert.equal(repeat.response.status, 200);
  assert.equal(repeat.body?.duplicate, true);
  assert.equal(repeat.body?.event_id, payload.event_id);
  assert.equal(await crmCount(payload.event_id), 1);
});

test('rejection prevents CRM delivery and opposite approval returns 409', async () => {
  const payload = await approvalPayload('high-risk.json');
  await intake(payload);
  await eventRow(payload.event_id, 'awaiting_approval');
  const reject = await post('/webhook/lead-approval', {
    event_id: payload.event_id,
    decision: 'rejected',
    decided_by: 'reviewer@example.test',
    reason: 'Not a fit',
  });
  assert.equal(reject.response.status, 200);
  assert.equal(reject.body?.accepted, false);
  await eventRow(payload.event_id, 'rejected');
  assert.equal(await crmCount(payload.event_id), 0);

  const opposite = await post('/webhook/lead-approval', {
    event_id: payload.event_id,
    decision: 'approved',
    decided_by: 'reviewer@example.test',
    reason: 'Changed mind',
  });
  assert.equal(opposite.response.status, 409);
  assert.equal(opposite.body?.event_id, payload.event_id);
  assert.equal(await crmCount(payload.event_id), 0);
  assert.equal((await eventRow(payload.event_id)).status, 'rejected');
});

test('missing or incorrect operator header is rejected with 401 or 403', async () => {
  const payload = await approvalPayload('high-value.json');
  await intake(payload);
  await eventRow(payload.event_id, 'awaiting_approval');
  const decision = { event_id: payload.event_id, decision: 'approved', decided_by: 'reviewer@example.test' };
  const missing = await post('/webhook/lead-approval', decision, { authorized: false });
  assert.ok([401, 403].includes(missing.response.status));
  const wrong = await post('/webhook/lead-approval', decision, { authorized: false, headers: { [operatorHeader]: 'wrong_operator_value' } });
  assert.ok([401, 403].includes(wrong.response.status));
  assert.equal(await crmCount(payload.event_id), 0);
  assert.equal((await eventRow(payload.event_id)).status, 'awaiting_approval');
});

test('invalid approval body returns stable JSON 422', async () => {
  const result = await post('/webhook/lead-approval', { event_id: 'invalid-body' });
  assert.equal(result.response.status, 422);
  assert.match(result.response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.deepEqual(result.body, {
    accepted: false,
    event_id: 'invalid-body',
    errors: [
      { field: 'decision', code: 'required', message: 'decision is required' },
      { field: 'decided_by', code: 'required', message: 'decided_by is required' },
    ],
  });
});
