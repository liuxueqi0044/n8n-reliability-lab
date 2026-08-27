import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { compose } from '../helpers/runtime.mjs';
import { waitFor } from '../helpers/polling.mjs';
import { countRequests, resetWireMock } from '../helpers/wiremock.mjs';
import { closeDatabase, deleteTestEvents, getDatabase, getInboundEvent, waitForDatabase } from '../helpers/database.mjs';

const n8nUrl = `http://127.0.0.1:${process.env.N8N_HOST_PORT ?? 5678}`;
const operatorHeader = process.env.LAB_OPERATOR_HEADER_NAME ?? 'x-lab-operator-key';
const operatorValue = process.env.LAB_OPERATOR_HEADER_VALUE ?? 'operator_local_only';
const created = new Set();
const eventId = () => { const value = `test_recovery_${randomUUID()}`; created.add(value); return value; };

async function post(path, body, { authorized = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authorized) headers[operatorHeader] = operatorValue;
  const response = await fetch(`${n8nUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* Auth middleware may return a non-JSON response. */ }
  return { response, body: parsed, text };
}

async function recoverableDeadLetter(value) {
  const payload = JSON.parse(await readFile(new URL('../fixtures/recovery/recoverable-lead.json', import.meta.url), 'utf8'));
  payload.event_id = value;
  const intake = await post('/webhook/lead-intake', payload, { authorized: false });
  assert.equal(intake.response.status, 202);
  await waitFor(async () => (await getInboundEvent(value))?.status === 'dead_letter', { timeoutMs: 30_000, description: 'initial dead letter' });
}

before(async () => { await waitForDatabase(); await resetWireMock(); });
after(async () => { await deleteTestEvents([...created]); await closeDatabase(); });

test('recovery workflow has fixed identity, protected webhook, and selector-based child invocation', async () => {
  const workflow = JSON.parse(await readFile(new URL('../../workflows/failure-recovery.json', import.meta.url), 'utf8'));
  assert.equal(workflow.id, 'FailureRecover01'); assert.equal(workflow.name, 'Failure Recovery');
  const webhook = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.path, 'recovery-replay'); assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.deepEqual(webhook.credentials.httpHeaderAuth, { id: 'LabOpsCred000001', name: 'Reliability Lab Operator Header' });
  const execute = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(execute.typeVersion, 1.1); assert.equal(execute.parameters.workflowId.value, 'ApprovalDeliv001');
  assert.equal(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.respondToWebhook'), true);
  assert.equal(JSON.stringify(workflow).includes('operator_local_only'), false);
});

test('recovery replays one dead letter, persists across ordered restarts, and then no-ops', async () => {
  const value = eventId(); await recoverableDeadLetter(value);
  assert.equal(await countRequests({ path: '/crm/leads/recoverable', eventId: value }), 3);
  const replay = await post('/webhook/recovery-replay', { event_id: value });
  assert.equal(replay.response.status, 200);
  await waitFor(async () => (await getInboundEvent(value))?.status === 'delivered', { timeoutMs: 30_000, description: 'recovery delivery' });
  assert.equal(await countRequests({ path: '/crm/leads/recoverable', eventId: value }), 4);
  let state = (await getDatabase().query(`SELECT dead.status, dead.replay_count FROM dead_letter_events AS dead JOIN inbound_events AS event ON event.id = dead.inbound_event_id WHERE event.event_id = $1`, [value])).rows[0];
  assert.deepEqual(state, { status: 'recovered', replay_count: 1 });
  const repeat = await post('/webhook/recovery-replay', { event_id: value });
  assert.equal(repeat.response.status, 200); assert.equal(await countRequests({ path: '/crm/leads/recoverable', eventId: value }), 4);
  await closeDatabase(); await compose('restart', 'postgres'); await waitForDatabase({ timeoutMs: 60_000 });
  await compose('restart', 'n8n');
  await waitFor(async () => (await fetch(`${n8nUrl}/healthz/readiness`)).ok, { timeoutMs: 60_000, description: 'n8n readiness after restart' });
  state = (await getDatabase().query(`SELECT event.status AS event_status, dead.status AS dead_status, dead.replay_count FROM dead_letter_events AS dead JOIN inbound_events AS event ON event.id = dead.inbound_event_id WHERE event.event_id = $1`, [value])).rows[0];
  assert.deepEqual(state, { event_status: 'delivered', dead_status: 'recovered', replay_count: 1 });
  const afterRestart = await waitFor(async () => {
    const result = await post('/webhook/recovery-replay', { event_id: value });
    return result.response.status === 200 ? result : null;
  }, { timeoutMs: 30_000, description: 'recovery webhook registration after restart' });
  assert.equal(afterRestart.response.status, 200);
  assert.equal(await countRequests({ path: '/crm/leads/recoverable', eventId: value }), 4);
});

test('recovery webhook rejects missing or bad operator credentials', async () => {
  const missing = await post('/webhook/recovery-replay', { event_id: eventId() }, { authorized: false });
  assert.ok(missing.response.status === 401 || missing.response.status === 403);
  const bad = await fetch(`${n8nUrl}/webhook/recovery-replay`, { method: 'POST', headers: { 'content-type': 'application/json', [operatorHeader]: 'wrong' }, body: JSON.stringify({ event_id: eventId() }) });
  assert.ok(bad.status === 401 || bad.status === 403);
});
