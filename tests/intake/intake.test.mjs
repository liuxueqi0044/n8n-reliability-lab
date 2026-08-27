import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import test, { after, before, afterEach, beforeEach } from 'node:test';
import * as database from '../helpers/database.mjs';
import { countRequests, resetWireMock } from '../helpers/wiremock.mjs';

const { Pool } = pg;
const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = resolve(root, 'workflows/lead-intake.json');
const intakeUrl = `http://127.0.0.1:${process.env.N8N_HOST_PORT ?? 5678}/webhook/lead-intake`;
const dbPool = new Pool({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.LAB_DB_USER ?? 'reliability_app',
  password: process.env.LAB_DB_PASSWORD ?? 'lab_local_only',
  database: process.env.LAB_DB_NAME ?? 'reliability_lab',
  max: 8,
});

const createdEventIds = new Set();
const createdMarkers = new Set();
const fixture = async (name) => JSON.parse(await readFile(resolve(root, 'tests/fixtures/intake', name), 'utf8'));
const newEventId = () => `test_${randomUUID()}`;

async function post(payload, { raw = false } = {}) {
  const response = await fetch(intakeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? payload : JSON.stringify(payload),
  });
  let body = null;
  try { body = await response.json(); } catch { /* malformed JSON is intentionally not a business response */ }
  return { response, body };
}

async function query(text, values = []) {
  return dbPool.query(text, values);
}

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function eventRow(eventId) {
  // Keep the B helper in the test path; this is its stable public read boundary.
  try { await database.getInboundEvent(eventId); } catch { /* polling below waits for the row */ }
  return waitFor(async () => {
    const result = await query('select * from inbound_events where event_id = $1', [eventId]);
    return result.rows[0] ?? null;
  });
}

async function runsFor(eventId) {
  return (await query(`select wr.* from workflow_runs wr
    join inbound_events ie on ie.id = wr.inbound_event_id
    where ie.event_id = $1 and wr.workflow_id = 'LeadIntake000001'
    order by wr.started_at asc`, [eventId])).rows;
}

async function assertNoDownstream(eventId) {
  const result = await query(`select
    (select count(*)::int from delivery_attempts da join inbound_events ie on ie.id = da.inbound_event_id where ie.event_id = $1) as deliveries,
    (select count(*)::int from dead_letter_events dl join inbound_events ie on ie.id = dl.inbound_event_id where ie.event_id = $1) as dead_letters`, [eventId]);
  assert.equal(result.rows[0].deliveries, 0);
  assert.equal(result.rows[0].dead_letters, 0);
}

async function assertDeliveredOnce(eventId) {
  const row = await waitFor(async () => {
    const result = await query('select * from inbound_events where event_id = $1', [eventId]);
    return result.rows[0]?.status === 'delivered' ? result.rows[0] : null;
  }, { timeoutMs: 30_000 });
  const attempts = await query(`select attempt_no, http_status, outcome from delivery_attempts da
    join inbound_events ie on ie.id = da.inbound_event_id where ie.event_id = $1 order by attempt_no`, [eventId]);
  assert.deepEqual(attempts.rows, [{ attempt_no: 1, http_status: 201, outcome: 'succeeded' }]);
  assert.equal(await countRequests({ path: '/crm/leads/success', eventId }), 1);
  return row;
}

async function uniquePayload(name, eventId = newEventId()) {
  const payload = await fixture(name);
  payload.event_id = eventId;
  if (eventId) createdEventIds.add(eventId);
  return payload;
}

before(async () => {
  await database.waitForDatabase({ timeoutMs: 30_000 });
  await dbPool.query('select 1');
});

beforeEach(async () => {
  await resetWireMock();
});

afterEach(async () => {
  // Resolve NULL-event-id records by a test-only marker, then use B's explicit-ID cleanup.
  const markers = [...createdMarkers];
  const cleanupIds = new Set(createdEventIds);
  if (markers.length) {
    const rows = await query("select id from inbound_events where raw_payload->>'_test_nonce' = any($1::text[])", [markers]);
    for (const row of rows.rows) cleanupIds.add(row.id);
  }
  const terminal = new Set(['delivered', 'rejected', 'awaiting_approval', 'dead_letter']);
  for (const id of cleanupIds) {
    await waitFor(async () => {
      const row = await query('select status from inbound_events where id::text = $1 or event_id = $1', [id]);
      return row.rows[0] && terminal.has(row.rows[0].status) ? true : null;
    }, { timeoutMs: 30_000 });
  }
  const markerIds = [...cleanupIds].filter((id) => !createdEventIds.has(id));
  if (markerIds.length) await database.deleteTestEventsByIds(markerIds);
  if (createdEventIds.size) await database.deleteTestEvents([...createdEventIds]);
  createdEventIds.clear();
  createdMarkers.clear();
  await resetWireMock();
});

after(async () => {
  await dbPool.end();
  await database.closeDatabase();
});

test('workflow export has fixed production identity, credential, and no delivery implementation', async () => {
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(workflow.id, 'LeadIntake000001');
  assert.equal(workflow.name, 'Lead Intake - Validate and Claim');
  const webhook = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.httpMethod, 'POST');
  assert.equal(webhook.parameters.path, 'lead-intake');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.ok(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.respondToWebhook'));
  const ifNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.if');
  assert.equal(ifNodes.length, 3);
  for (const node of ifNodes) {
    assert.deepEqual(node.parameters.conditions.options, { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 });
  }
  const codeNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.code');
  assert.equal(codeNodes.length, 1);
  assert.equal(codeNodes[0].name, 'Normalize, Validate and Classify');
  const postgresNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.postgres');
  assert.ok(postgresNodes.length >= 4);
  for (const node of postgresNodes) {
    assert.deepEqual(node.credentials?.postgres, { id: 'LabPgCred0000001', name: 'Reliability Lab Postgres' });
    assert.equal(node.parameters.operation, 'executeQuery');
    assert.match(node.parameters.options.queryReplacement, /^=\{/);
  }
  assert.match(postgresNodes.find((node) => node.name === 'Atomic Claim Event').parameters.query, /claim_inbound_event\(\$1, \$2::jsonb\)/);
  const finalizeNode = postgresNodes.find((node) => node.name === 'Finalize Intake');
  assert.match(finalizeNode.parameters.query, /finalize_intake\(/);
  assert.match(finalizeNode.parameters.options.queryReplacement, /Normalize, Validate and Classify/);
  assert.equal(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.httpRequest'), false);
  const handoff = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.executeWorkflow');
  assert.ok(handoff);
  assert.equal(handoff.typeVersion, 1.1);
  assert.equal(handoff.parameters.workflowId.__rl, true);
  assert.equal(handoff.parameters.workflowId.value, 'ApprovalDeliv001');
  assert.equal(handoff.parameters.workflowId.mode, 'list');
});

test('standard intake returns 202 processing, normalizes values, and audits one run', async () => {
  const payload = await uniquePayload('valid-standard.json');
  const { response, body } = await post(payload);
  assert.equal(response.status, 202);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.deepEqual(body, { accepted: true, duplicate: false, event_id: payload.event_id, status: 'processing', classification: 'standard', requires_approval: false });
  const row = await eventRow(payload.event_id);
  assert.equal(row.status, 'processing');
  assert.equal(row.lead_email, payload.lead.email.toLowerCase());
  assert.equal(row.occurred_at.toISOString(), new Date(payload.occurred_at).toISOString());
  assert.deepEqual(row.raw_payload.lead, payload.lead);
  const runs = await waitFor(async () => (await runsFor(payload.event_id)).length === 1 ? runsFor(payload.event_id) : null);
  assert.equal(runs[0].outcome, 'succeeded');
  await assertDeliveredOnce(payload.event_id);
});

test('sequential duplicate returns 200 and creates one inbound event plus skipped audit', async () => {
  const payload = await uniquePayload('valid-standard.json');
  assert.equal((await post(payload)).response.status, 202);
  const duplicate = await post({ ...payload, lead: { ...payload.lead, message: 'different duplicate body' } });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.accepted, false);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.event_id, payload.event_id);
  assert.ok(['processing', 'delivered'].includes(duplicate.body.status));
  assert.equal((await query('select count(*)::int as count from inbound_events where event_id = $1', [payload.event_id])).rows[0].count, 1);
  const runs = await waitFor(async () => { const rows = await runsFor(payload.event_id); return rows.length === 2 ? rows : null; });
  assert.deepEqual(runs.map((run) => run.outcome).sort(), ['skipped', 'succeeded']);
  await assertDeliveredOnce(payload.event_id);
});

test('twenty concurrent requests claim exactly once', async () => {
  const payload = await uniquePayload('valid-standard.json');
  const results = await Promise.all(Array.from({ length: 20 }, () => post(payload)));
  assert.equal(results.filter(({ response }) => response.status === 202).length, 1);
  assert.equal(results.filter(({ response }) => response.status === 200).length, 19);
  assert.equal((await query('select count(*)::int as count from inbound_events where event_id = $1', [payload.event_id])).rows[0].count, 1);
  const runs = await waitFor(async () => { const rows = await runsFor(payload.event_id); return rows.length === 20 ? rows : null; });
  assert.equal(runs.filter((run) => run.outcome === 'succeeded').length, 1);
  assert.equal(runs.filter((run) => run.outcome === 'skipped').length, 19);
  for (const result of results.filter(({ response }) => response.status === 200)) {
    // A concurrent duplicate may observe the atomic claim before intake finalization.
    assert.ok(['received', 'processing', 'delivered'].includes(result.body.status));
  }
  await assertDeliveredOnce(payload.event_id);
});

test('missing email is rejected with a stable 422 error', async () => {
  const payload = await uniquePayload('invalid-missing-email.json');
  const { response, body } = await post(payload);
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(body.accepted, false);
  assert.equal(body.duplicate, false);
  assert.equal(body.event_id, payload.event_id);
  assert.equal(body.status, 'rejected');
  assert.deepEqual(body.errors, [{ field: 'lead.email', code: 'required', message: 'lead.email is required' }]);
  assert.equal((await eventRow(payload.event_id)).status, 'rejected');
  await assertNoDownstream(payload.event_id);
});

test('invalid JSON types are not coerced and remain auditable', async () => {
  const payload = await fixture('invalid-types.json');
  const marker = `test_marker_${randomUUID()}`;
  payload._test_nonce = marker;
  createdMarkers.add(marker);
  const { response, body } = await post(payload);
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(body.event_id, null);
  assert.equal(body.status, 'rejected');
  assert.deepEqual(body.errors.map(({ field, code }) => ({ field, code })), [
    { field: 'event_id', code: 'invalid_type' },
    { field: 'lead.company_size', code: 'invalid_type' },
  ]);
  const row = await waitFor(async () => (await query("select * from inbound_events where raw_payload->>'_test_nonce' = $1", [marker])).rows[0] ?? null);
  assert.equal(row.status, 'rejected');
  assert.equal(row.company_size, null);
});

test('129-character event_id is rejected without a database 500', async () => {
  const payload = await uniquePayload('valid-standard.json', null);
  payload.event_id = 'x'.repeat(129);
  const marker = `test_marker_${randomUUID()}`;
  payload._test_nonce = marker;
  createdMarkers.add(marker);
  const { response, body } = await post(payload);
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(body.event_id, null);
  assert.equal(body.status, 'rejected');
  assert.deepEqual(body.errors, [{ field: 'event_id', code: 'too_long', message: 'event_id must be at most 128 characters' }]);
  const row = await waitFor(async () => (await query("select * from inbound_events where raw_payload->>'_test_nonce' = $1", [marker])).rows[0] ?? null);
  assert.equal(row.status, 'rejected');
});

test('nonexistent calendar date is rejected and audited by its valid event_id', async () => {
  const payload = await uniquePayload('valid-standard.json');
  payload.occurred_at = '2026-02-30T10:00:00Z';
  const { response, body } = await post(payload);
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(body.event_id, payload.event_id);
  assert.deepEqual(body.errors, [{ field: 'occurred_at', code: 'invalid_format', message: 'occurred_at must be a valid RFC3339 timestamp' }]);
  const row = await eventRow(payload.event_id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.occurred_at, null);
  await assertNoDownstream(payload.event_id);
});

test('numeric occurred_at is rejected as invalid_type and audited', async () => {
  const payload = await uniquePayload('valid-standard.json');
  payload.occurred_at = 1772445600000;
  const { response, body } = await post(payload);
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(body.event_id, payload.event_id);
  assert.deepEqual(body.errors, [{ field: 'occurred_at', code: 'invalid_type', message: 'occurred_at must be a string' }]);
  const row = await eventRow(payload.event_id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.occurred_at, null);
  await assertNoDownstream(payload.event_id);
});

test('high-value and high-risk events await approval, with high-risk precedence', async () => {
  const highValue = await uniquePayload('valid-high-value.json');
  const highRisk = await uniquePayload('valid-high-risk.json');
  const both = await uniquePayload('valid-high-value.json');
  both.lead.message = 'A fictional GDPR security review is requested.';
  const responses = await Promise.all([post(highValue), post(highRisk), post(both)]);
  for (const { response, body } of responses) {
    assert.equal(response.status, 202);
    assert.equal(body.status, 'awaiting_approval');
    assert.equal(body.requires_approval, true);
    assert.equal(body.accepted, true);
  }
  assert.equal((await eventRow(highValue.event_id)).classification, 'high_value');
  assert.equal((await eventRow(highRisk.event_id)).classification, 'high_risk');
  assert.equal((await eventRow(both.event_id)).classification, 'high_risk');
  for (const payload of [highValue, highRisk, both]) {
    const approval = await waitFor(async () => database.getApprovalRequest((await eventRow(payload.event_id)).id));
    assert.equal(approval.decision, 'pending');
    await assertNoDownstream(payload.event_id);
  }
});

test('risk keyword uses word boundaries and legalized remains standard', async () => {
  const payload = await uniquePayload('valid-standard.json');
  payload.lead.message = 'A fictional legalized process has no risk keyword.';
  const { response, body } = await post(payload);
  assert.equal(response.status, 202);
  assert.equal(body.classification, 'standard');
  assert.equal(body.requires_approval, false);
  assert.equal((await eventRow(payload.event_id)).classification, 'standard');
  await assertDeliveredOnce(payload.event_id);
});

test('malformed JSON receives a non-2xx response without business HTML assertions', async () => {
  const { response } = await post('{"event_id":', { raw: true });
  assert.ok(response.status >= 400 && response.status < 500);
});

test('re-running bootstrap leaves one usable production webhook', async () => {
  await execFile(process.execPath, ['scripts/bootstrap.mjs'], { cwd: root, timeout: 120_000 });
  const payload = await uniquePayload('valid-standard.json');
  const { response, body } = await post(payload);
  assert.equal(response.status, 202);
  assert.equal(body.status, 'processing');
  await assertDeliveredOnce(payload.event_id);
});
