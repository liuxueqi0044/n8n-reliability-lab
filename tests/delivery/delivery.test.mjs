import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import * as database from '../helpers/database.mjs';
import { waitFor } from '../helpers/polling.mjs';
import { countRequests } from '../helpers/wiremock.mjs';

const root = process.cwd();
const intakeUrl = `http://127.0.0.1:${process.env.N8N_HOST_PORT ?? 5678}/webhook/lead-intake`;
const wireMockUrl = `http://127.0.0.1:${process.env.WIREMOCK_HOST_PORT ?? 8080}`;
const createdEventIds = new Set();

const fixture = async (name) => JSON.parse(await readFile(join(root, 'tests/fixtures/delivery', name), 'utf8'));
const eventId = () => `test_delivery_${randomUUID()}`;

async function postIntake(payload) {
  const response = await fetch(intakeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function resetWireMockForTest() {
  for (const [path, method] of [['/__admin/requests', 'DELETE'], ['/__admin/scenarios/reset', 'POST']]) {
    const response = await fetch(`${wireMockUrl}${path}`, { method });
    if (!response.ok) throw new Error(`WireMock ${method} ${path} returned ${response.status}`);
  }
}

async function payloadFor(name) {
  const payload = await fixture(name);
  payload.event_id = eventId();
  createdEventIds.add(payload.event_id);
  return payload;
}

async function deliverySnapshot(id) {
  const db = database.getDatabase();
  const { rows } = await db.query(`
    select ie.id, ie.status,
      coalesce((select json_agg(json_build_object('attempt_no', da.attempt_no, 'http_status', da.http_status, 'outcome', da.outcome, 'retryable', da.retryable) order by da.attempt_no)
        from delivery_attempts da where da.inbound_event_id = ie.id), '[]'::json) as attempts,
      (select row_to_json(dl) from dead_letter_events dl where dl.inbound_event_id = ie.id) as dead_letter
    from inbound_events ie where ie.event_id = $1`, [id]);
  return rows[0] ?? null;
}

async function waitForFinalState(id, expectedStatus) {
  return waitFor(async () => {
    const snapshot = await deliverySnapshot(id);
    return snapshot?.status === expectedStatus ? snapshot : null;
  }, { timeoutMs: 35_000, description: `${id} to become ${expectedStatus}` });
}

async function assertCrmCount(path, id, expected) {
  await waitFor(async () => (await countRequests({ path, eventId: id })) === expected, {
    timeoutMs: 10_000,
    description: `${id} to have ${expected} ${path} requests`,
  });
  assert.equal(await countRequests({ path, eventId: id }), expected);
}

before(async () => {
  await database.waitForDatabase();
});

beforeEach(async () => {
  await resetWireMockForTest();
});

afterEach(async () => {
  await database.deleteTestEvents([...createdEventIds]);
  createdEventIds.clear();
  await resetWireMockForTest();
});

after(async () => {
  await database.closeDatabase();
});

test('success is delivered once and duplicate intake has one CRM request', async () => {
  const payload = await payloadFor('success.json');
  const first = await postIntake(payload);
  assert.equal(first.response.status, 202);
  const delivered = await waitForFinalState(payload.event_id, 'delivered');
  assert.deepEqual(delivered.attempts.map((attempt) => attempt.http_status), [201]);
  await assertCrmCount('/crm/leads/success', payload.event_id, 1);

  const duplicate = await postIntake({ ...payload, lead: { ...payload.lead, message: 'A different duplicate body.' } });
  assert.equal(duplicate.response.status, 200);
  await assertCrmCount('/crm/leads/success', payload.event_id, 1);
});

test('transient 500, 429, then 201 is delivered after exactly three attempts', async () => {
  const payload = await payloadFor('transient.json');
  assert.equal((await postIntake(payload)).response.status, 202);
  const delivered = await waitForFinalState(payload.event_id, 'delivered');
  assert.deepEqual(delivered.attempts.map((attempt) => attempt.http_status), [500, 429, 201]);
  assert.deepEqual(delivered.attempts.map((attempt) => attempt.outcome), ['retryable_failure', 'retryable_failure', 'succeeded']);
  await assertCrmCount('/crm/leads/transient', payload.event_id, 3);
});

test('permanent 503 enters one open dead letter after three attempts and sends one alert', async () => {
  const payload = await payloadFor('permanent.json');
  assert.equal((await postIntake(payload)).response.status, 202);
  const deadLetter = await waitForFinalState(payload.event_id, 'dead_letter');
  assert.deepEqual(deadLetter.attempts.map((attempt) => attempt.http_status), [503, 503, 503]);
  assert.equal(deadLetter.dead_letter.status, 'open');
  assert.equal(deadLetter.dead_letter.attempt_count, 3);
  await assertCrmCount('/crm/leads/permanent', payload.event_id, 3);
  await waitFor(async () => (await countRequests({ path: '/alerts/dead-letter' })) === 1, {
    timeoutMs: 10_000,
    description: 'one permanent dead-letter alert',
  });
  assert.equal(await countRequests({ path: '/alerts/dead-letter' }), 1);
});

test('nonretryable 400 enters dead letter after one attempt and sends one alert', async () => {
  const payload = await payloadFor('nonretryable.json');
  assert.equal((await postIntake(payload)).response.status, 202);
  const deadLetter = await waitForFinalState(payload.event_id, 'dead_letter');
  assert.deepEqual(deadLetter.attempts.map((attempt) => attempt.http_status), [400]);
  assert.equal(deadLetter.dead_letter.status, 'open');
  assert.equal(deadLetter.dead_letter.attempt_count, 1);
  await assertCrmCount('/crm/leads/nonretryable', payload.event_id, 1);
  await waitFor(async () => (await countRequests({ path: '/alerts/dead-letter' })) === 1, {
    timeoutMs: 10_000,
    description: 'one nonretryable dead-letter alert',
  });
  assert.equal(await countRequests({ path: '/alerts/dead-letter' }), 1);
});
