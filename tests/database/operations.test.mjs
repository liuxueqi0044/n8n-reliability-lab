import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeDatabase, deleteTestEvents, getDatabase, getInboundEvent, waitForDatabase } from '../helpers/database.mjs';

const eventIds = new Set();
const suffix = () => randomUUID();
const eventId = (label) => { const value = `test_ops_${label}_${suffix()}`; eventIds.add(value); return value; };
const db = () => getDatabase();

async function claim(value) { return (await db().query(`SELECT * FROM claim_inbound_event($1, '{}'::jsonb)`, [value])).rows[0]; }
async function intake(claimed, { approval = false } = {}) {
  const workflowName = `test-intake-${suffix()}`; const executionId = `exec-${suffix()}`;
  await db().query(`INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome) VALUES ($1, 'LeadIntake000001', $2, $3, 'intake', 'running')`, [claimed.id, workflowName, executionId]);
  await db().query(`SELECT * FROM finalize_intake($1, 'source', now(), 'Lead', 'lead@example.local', 1, 'message', '[]'::jsonb, $2, $3, $4, $5)`, [claimed.id, approval ? 'high_value' : 'standard', approval, workflowName, executionId]);
}
async function prepare(value) {
  const workflowName = `test-delivery-${suffix()}`; const executionId = `exec-${suffix()}`;
  const result = (await db().query(`SELECT * FROM prepare_delivery($1, 'ApprovalDeliv001', $2, $3)`, [value, workflowName, executionId])).rows[0];
  return { ...result, workflowName, executionId };
}
async function attempt(value, cycle, number, status, prepared) {
  return (await db().query(`SELECT * FROM record_delivery_attempt($1, $2, $3, $4, '{}'::jsonb, NULL, NULL, $5, $6)`, [value, cycle, number, status, prepared.workflowName, prepared.executionId])).rows[0];
}

before(async () => { await waitForDatabase(); });
after(async () => { await deleteTestEvents([...eventIds]); await closeDatabase(); });

test('concurrent approval dispatches exactly once and conflicting decision is inert', async () => {
  const value = eventId('approval'); const claimed = await claim(value); await intake(claimed, { approval: true });
  const results = await Promise.all(Array.from({ length: 12 }, () => db().query(`SELECT * FROM decide_approval($1, 'approved', 'reviewer', NULL, 'ApprovalDeliv001', $2, $3)`, [value, `test-approval-${suffix()}`, `exec-${suffix()}`])));
  assert.equal(results.filter(({ rows }) => rows[0].dispatch).length, 1);
  assert.equal((await getInboundEvent(value)).status, 'processing');
  const conflict = (await db().query(`SELECT * FROM decide_approval($1, 'rejected', 'reviewer', NULL, 'ApprovalDeliv001', $2, $3)`, [value, `test-approval-${suffix()}`, `exec-${suffix()}`])).rows[0];
  assert.equal(conflict.http_status, 409); assert.equal(conflict.dispatch, false);
});

test('unapproved events cannot be prepared for delivery', async () => {
  const value = eventId('blocked'); const claimed = await claim(value); await intake(claimed, { approval: true });
  const result = await prepare(value);
  assert.equal(result.dispatch, false); assert.equal(result.event_status, 'awaiting_approval');
});

test('one n8n execution can audit approval and delivery as distinct run types', async () => {
  const value = eventId('shared-execution'); const claimed = await claim(value); await intake(claimed, { approval: true });
  const workflowName = 'Approval and Delivery'; const executionId = `exec-${suffix()}`;
  const approval = (await db().query(`SELECT * FROM decide_approval($1, 'approved', 'reviewer', NULL, 'ApprovalDeliv001', $2, $3)`, [value, workflowName, executionId])).rows[0];
  assert.equal(approval.dispatch, true);
  const delivery = (await db().query(`SELECT * FROM prepare_delivery($1, 'ApprovalDeliv001', $2, $3)`, [value, workflowName, executionId])).rows[0];
  assert.equal(delivery.dispatch, true);
  const runs = (await db().query(`SELECT run_type FROM workflow_runs AS run JOIN inbound_events AS event ON event.id = run.inbound_event_id WHERE event.event_id = $1 AND run.workflow_name = $2 AND run.n8n_execution_id = $3 ORDER BY run_type`, [value, workflowName, executionId])).rows;
  assert.deepEqual(runs, [{ run_type: 'approval' }, { run_type: 'delivery' }]);
});

test('retry exhaustion and first nonretryable failure create dead letters', async () => {
  const retryValue = eventId('retry'); const retryClaim = await claim(retryValue); await intake(retryClaim); const retryRun = await prepare(retryValue);
  assert.equal((await attempt(retryValue, 0, 1, 500, retryRun)).action, 'retry');
  assert.equal((await attempt(retryValue, 0, 2, 429, retryRun)).action, 'retry');
  assert.equal((await attempt(retryValue, 0, 3, 503, retryRun)).action, 'dead_letter');
  assert.equal((await attempt(retryValue, 0, 3, 503, retryRun)).action, 'dead_letter');
  assert.equal((await getInboundEvent(retryValue)).status, 'dead_letter');
  const nonRetryValue = eventId('nonretry'); const nonRetryClaim = await claim(nonRetryValue); await intake(nonRetryClaim); const nonRetryRun = await prepare(nonRetryValue);
  assert.equal((await attempt(nonRetryValue, 0, 1, 400, nonRetryRun)).action, 'dead_letter');
  assert.equal((await db().query(`SELECT count(*)::int AS count FROM delivery_attempts AS attempt JOIN inbound_events AS event ON event.id = attempt.inbound_event_id WHERE event.event_id = $1`, [nonRetryValue])).rows[0].count, 1);
});

test('NULL transport failures retry then dead-letter and truncate persisted error text', async () => {
  const value = eventId('transport'); const claimed = await claim(value); await intake(claimed); const prepared = await prepare(value);
  const longError = 'x'.repeat(2500);
  const invoke = (number) => db().query(`SELECT * FROM record_delivery_attempt($1, 0, $2, NULL, '{}'::jsonb, $3, $3, $4, $5)`, [value, number, longError, prepared.workflowName, prepared.executionId]);
  assert.equal((await invoke(1)).rows[0].action, 'retry');
  assert.equal((await invoke(2)).rows[0].action, 'retry');
  assert.equal((await invoke(3)).rows[0].action, 'dead_letter');
  const stored = (await db().query(`SELECT response_excerpt, error_message FROM delivery_attempts AS attempt JOIN inbound_events AS event ON event.id = attempt.inbound_event_id WHERE event.event_id = $1 AND attempt.attempt_no = 1`, [value])).rows[0];
  assert.equal(stored.response_excerpt.length, 2000); assert.equal(stored.error_message.length, 2000);
});

test('replay advances cycle once, successful recovery closes DLQ, and repeat replay is no-op', async () => {
  const value = eventId('recovery'); const claimed = await claim(value); await intake(claimed); const initial = await prepare(value);
  await attempt(value, 0, 1, 503, initial); await attempt(value, 0, 2, 503, initial); await attempt(value, 0, 3, 503, initial);
  const replayName = `test-recovery-${suffix()}`; const replayExecution = `exec-${suffix()}`;
  const replay = (await db().query(`SELECT * FROM claim_dead_letter_replay($1, 'FailureRecover01', $2, $3)`, [value, replayName, replayExecution])).rows[0];
  assert.equal(replay.dispatch, true); assert.equal(replay.processing_cycle, 1);
  const recoveredRun = await prepare(value); assert.equal(recoveredRun.dispatch, true);
  assert.equal((await attempt(value, 1, 1, 201, recoveredRun)).action, 'delivered');
  const state = await getInboundEvent(value); assert.equal(state.status, 'delivered');
  const dead = (await db().query(`SELECT dead.status AS dead_status, dead.replay_count FROM dead_letter_events AS dead JOIN inbound_events AS event ON event.id = dead.inbound_event_id WHERE event.event_id = $1`, [value])).rows[0];
  assert.equal(dead.dead_status, 'recovered'); assert.equal(dead.replay_count, 1);
  const skippedName = `test-recovery-${suffix()}`; const skippedExecution = `exec-${suffix()}`;
  const repeat = (await db().query(`SELECT * FROM claim_dead_letter_replay($1, 'FailureRecover01', $2, $3)`, [value, skippedName, skippedExecution])).rows[0];
  assert.equal(repeat.dispatch, false);
  assert.equal((await db().query(`SELECT outcome FROM workflow_runs WHERE workflow_name = $1 AND n8n_execution_id = $2`, [skippedName, skippedExecution])).rows[0].outcome, 'skipped');
  assert.equal((await db().query(`SELECT replay_count FROM dead_letter_events AS dead JOIN inbound_events AS event ON event.id = dead.inbound_event_id WHERE event.event_id = $1`, [value])).rows[0].replay_count, 1);
});
