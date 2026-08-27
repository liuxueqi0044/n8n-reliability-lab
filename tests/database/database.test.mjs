import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { compose } from '../helpers/runtime.mjs';
import {
  closeDatabase, deleteTestEvents, deleteTestEventsByIds, getApprovalRequest,
  getDatabase, getInboundEvent, getWorkflowRun, waitForDatabase,
} from '../helpers/database.mjs';

const eventIds = new Set();
const nullEventIds = new Set();
const id = (label) => {
  const eventId = `test_${label}_${randomUUID()}`;
  eventIds.add(eventId);
  return eventId;
};
const raw = { fixture: 'database-test' };

async function claim(eventId, payload = raw) {
  const { rows } = await getDatabase().query('SELECT * FROM claim_inbound_event($1, $2::jsonb)', [eventId, JSON.stringify(payload)]);
  return rows[0];
}

async function createRunningRun(inboundEventId, workflowName = `test-intake-${randomUUID()}`) {
  const executionId = `exec_${randomUUID()}`;
  await getDatabase().query(
    `INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome)
     VALUES ($1, 'LeadIntake000001', $2, $3, 'intake', 'running')`,
    [inboundEventId, workflowName, executionId],
  );
  return { workflowName, executionId };
}

async function finalize(inboundEventId, run, { errors = [], classification = 'standard', approval = false } = {}) {
  return getDatabase().query(
    `SELECT * FROM finalize_intake($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
    [inboundEventId, 'test-source', '2026-08-27T00:00:00Z', 'Test Lead', 'test@example.local', 20, 'Test message', JSON.stringify(errors), classification, approval, run.workflowName, run.executionId],
  );
}

before(async () => { await waitForDatabase(); });
after(async () => {
  await deleteTestEvents([...eventIds]);
  await deleteTestEventsByIds([...nullEventIds]);
  await closeDatabase();
});

test('five tables and public function boundaries exist', async () => {
  const { rows } = await getDatabase().query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [[
    'inbound_events', 'workflow_runs', 'delivery_attempts', 'approval_requests', 'dead_letter_events',
  ]]);
  assert.equal(rows.length, 5);
  const functions = await getDatabase().query(`SELECT proname FROM pg_proc WHERE proname = ANY($1::text[])`, [['claim_inbound_event', 'finalize_intake']]);
  assert.equal(functions.rows.length, 2);
});

test('claim creates a received event and atomically deduplicates concurrent calls', async () => {
  const eventId = id('concurrent');
  const claims = await Promise.all(Array.from({ length: 20 }, () => claim(eventId)));
  assert.equal(claims.filter(({ claimed }) => claimed).length, 1);
  assert.equal((await getDatabase().query('SELECT count(*)::int AS count FROM inbound_events WHERE event_id = $1', [eventId])).rows[0].count, 1);
  const event = await getInboundEvent(eventId);
  assert.equal(event.status, 'received');
  assert.deepEqual(event.raw_payload, raw);
});

test('different and NULL event IDs create independent audit rows', async () => {
  const first = id('different-a'); const second = id('different-b');
  assert.equal((await claim(first)).claimed, true);
  assert.equal((await claim(second)).claimed, true);
  const one = await claim(null); const two = await claim('   ');
  nullEventIds.add(one.id); nullEventIds.add(two.id);
  assert.equal(one.claimed, true); assert.equal(two.claimed, true); assert.notEqual(one.id, two.id);
});

test('claim rejects a 129-character event ID without creating an event', async () => {
  const eventId = `test_${'x'.repeat(124)}`;
  await assert.rejects(claim(eventId));
  const { rows } = await getDatabase().query('SELECT count(*)::int AS count FROM inbound_events WHERE event_id = $1', [eventId]);
  assert.equal(rows[0].count, 0);
});

test('database rejects invalid ledger values and payload shapes', async () => {
  const eventId = id('constraints');
  await assert.rejects(getDatabase().query(`INSERT INTO inbound_events (event_id, raw_payload, status) VALUES ($1, '{}'::jsonb, 'unknown')`, [eventId]));
  await assert.rejects(getDatabase().query(`INSERT INTO inbound_events (event_id, raw_payload, classification) VALUES ($1, '{}'::jsonb, 'unknown')`, [eventId]));
  await assert.rejects(getDatabase().query(`INSERT INTO inbound_events (event_id, raw_payload, validation_errors) VALUES ($1, '[]'::jsonb, '{}'::jsonb)`, [eventId]));
  await assert.rejects(getDatabase().query(`INSERT INTO inbound_events (event_id, raw_payload, message) VALUES ($1, '{}'::jsonb, $2)`, [eventId, 'x'.repeat(5001)]));
});

test('state trigger enforces transitions, terminality, timestamps, and versions', async () => {
  const eventId = id('state'); const claimed = await claim(eventId);
  await assert.rejects(getDatabase().query(`UPDATE inbound_events SET status = 'delivered' WHERE id = $1`, [claimed.id]));
  const initial = await getInboundEvent(eventId);
  await getDatabase().query(`UPDATE inbound_events SET status = 'validated' WHERE id = $1`, [claimed.id]);
  await getDatabase().query(`UPDATE inbound_events SET status = 'processing' WHERE id = $1`, [claimed.id]);
  await getDatabase().query(`UPDATE inbound_events SET status = 'delivered' WHERE id = $1`, [claimed.id]);
  const delivered = await getInboundEvent(eventId);
  assert.equal(delivered.status, 'delivered'); assert.ok(delivered.delivered_at); assert.equal(delivered.version, initial.version + 3);
  assert.ok(new Date(delivered.updated_at) >= new Date(initial.updated_at));
  await assert.rejects(getDatabase().query(`UPDATE inbound_events SET status = 'processing' WHERE id = $1`, [claimed.id]));
  const rejectedId = id('rejected'); const rejected = await claim(rejectedId);
  await getDatabase().query(`UPDATE inbound_events SET status = 'rejected' WHERE id = $1`, [rejected.id]);
  assert.ok((await getInboundEvent(rejectedId)).rejected_at);
  await assert.rejects(getDatabase().query(`UPDATE inbound_events SET status = 'received' WHERE id = $1`, [rejected.id]));
});

test('audit and delivery uniqueness plus cross-field constraints are enforced', async () => {
  const eventId = id('audit'); const claimed = await claim(eventId); const db = getDatabase();
  await db.query(`INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome) VALUES ($1, 'w', 'test-workflow', 'test-exec-${claimed.id}', 'intake', 'running')`, [claimed.id]);
  await assert.rejects(db.query(`INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome) VALUES ($1, 'w', 'test-workflow', 'test-exec-${claimed.id}', 'intake', 'running')`, [claimed.id]));
  const attempt = `INSERT INTO delivery_attempts (inbound_event_id, processing_cycle, attempt_no, idempotency_key, outcome, http_status, retryable, request_payload) VALUES ($1, 0, 1, 'key', 'succeeded', 200, false, '{}'::jsonb)`;
  await db.query(attempt, [claimed.id]);
  await assert.rejects(db.query(attempt, [claimed.id]));
  await assert.rejects(db.query(`INSERT INTO delivery_attempts (inbound_event_id, processing_cycle, attempt_no, idempotency_key, outcome, retryable, request_payload) VALUES ($1, 1, 1, 'key-2', 'succeeded', false, '{}'::jsonb)`, [claimed.id]));
  await assert.rejects(db.query(`INSERT INTO approval_requests (inbound_event_id, decision, decided_at, decided_by) VALUES ($1, 'pending', now(), 'operator')`, [claimed.id]));
  await assert.rejects(db.query(`INSERT INTO dead_letter_events (inbound_event_id, failure_class, attempt_count, event_snapshot, status, recovered_at) VALUES ($1, 'x', 1, '{}'::jsonb, 'open', now())`, [claimed.id]));
  await db.query(`INSERT INTO approval_requests (inbound_event_id) VALUES ($1)`, [claimed.id]);
  await assert.rejects(db.query(`INSERT INTO approval_requests (inbound_event_id) VALUES ($1)`, [claimed.id]));
  await db.query(`INSERT INTO dead_letter_events (inbound_event_id, failure_class, attempt_count, event_snapshot) VALUES ($1, 'x', 1, '{}'::jsonb)`, [claimed.id]);
  await assert.rejects(db.query(`INSERT INTO dead_letter_events (inbound_event_id, failure_class, attempt_count, event_snapshot) VALUES ($1, 'x', 1, '{}'::jsonb)`, [claimed.id]));
});

test('finalize_intake produces standard, approval, and rejected routes atomically', async () => {
  const standardId = id('final-standard'); const standard = await claim(standardId); const standardRun = await createRunningRun(standard.id);
  assert.equal((await finalize(standard.id, standardRun)).rows[0].status, 'processing');
  assert.equal((await getWorkflowRun(standardRun.workflowName, standardRun.executionId)).outcome, 'succeeded');
  const approvalId = id('final-approval'); const approval = await claim(approvalId); const approvalRun = await createRunningRun(approval.id);
  assert.equal((await finalize(approval.id, approvalRun, { classification: 'high_risk', approval: true })).rows[0].status, 'awaiting_approval');
  assert.equal((await getApprovalRequest(approval.id)).decision, 'pending');
  const rejectedId = id('final-rejected'); const rejected = await claim(rejectedId); const rejectedRun = await createRunningRun(rejected.id);
  assert.equal((await finalize(rejected.id, rejectedRun, { errors: [{ field: 'lead.email', code: 'required', message: 'required' }], classification: null })).rows[0].status, 'rejected');
});

test('finalize_intake rolls back when pending approval insertion cannot succeed', async () => {
  const eventId = id('final-rollback'); const claimed = await claim(eventId); const run = await createRunningRun(claimed.id);
  await getDatabase().query(`INSERT INTO approval_requests (inbound_event_id) VALUES ($1)`, [claimed.id]);
  await assert.rejects(finalize(claimed.id, run, { classification: 'high_value', approval: true }));
  assert.equal((await getInboundEvent(eventId)).status, 'received');
  assert.equal((await getWorkflowRun(run.workflowName, run.executionId)).outcome, 'running');
});

test('test data persists through a PostgreSQL service restart and is then precisely removed', async () => {
  const eventId = id('restart'); const claimed = await claim(eventId);
  await closeDatabase();
  await compose('restart', 'postgres');
  await waitForDatabase({ timeoutMs: 60_000 });
  assert.equal((await getInboundEvent(eventId)).id, claimed.id);
  await deleteTestEvents([eventId]); eventIds.delete(eventId);
  assert.equal(await getInboundEvent(eventId), null);
});
