import pg from 'pg';

const { Pool } = pg;
let pool;

function databaseConfig() {
  return {
    host: process.env.LAB_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.POSTGRES_HOST_PORT ?? 5432),
    database: process.env.LAB_DB_NAME ?? 'reliability_lab',
    user: process.env.LAB_DB_USER ?? 'reliability_app',
    password: process.env.LAB_DB_PASSWORD ?? 'lab_local_only',
    max: 10,
  };
}

export function getDatabase() {
  pool ??= new Pool(databaseConfig());
  return pool;
}

export async function waitForDatabase({ timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await getDatabase().query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }
  throw new Error(`PostgreSQL was not reachable within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`);
}

async function deleteInboundEventIds(ids) {
  if (ids.length === 0) return;
  const db = getDatabase();
  const params = [ids];
  await db.query('DELETE FROM delivery_attempts WHERE inbound_event_id = ANY($1::uuid[])', params);
  await db.query('DELETE FROM workflow_runs WHERE inbound_event_id = ANY($1::uuid[])', params);
  await db.query('DELETE FROM approval_requests WHERE inbound_event_id = ANY($1::uuid[])', params);
  await db.query('DELETE FROM dead_letter_events WHERE inbound_event_id = ANY($1::uuid[])', params);
  await db.query('DELETE FROM inbound_events WHERE id = ANY($1::uuid[])', params);
}

export async function deleteTestEvents(eventIds) {
  if (!eventIds?.length) return;
  const { rows } = await getDatabase().query(
    'SELECT id FROM inbound_events WHERE event_id = ANY($1::varchar[])',
    [eventIds],
  );
  await deleteInboundEventIds(rows.map(({ id }) => id));
}

export async function deleteTestEventsByIds(inboundEventIds) {
  if (!inboundEventIds?.length) return;
  await deleteInboundEventIds(inboundEventIds);
}

export async function getInboundEvent(eventId) {
  const { rows } = await getDatabase().query('SELECT * FROM inbound_events WHERE event_id = $1', [eventId]);
  return rows[0] ?? null;
}

export async function getApprovalRequest(inboundEventId) {
  const { rows } = await getDatabase().query('SELECT * FROM approval_requests WHERE inbound_event_id = $1', [inboundEventId]);
  return rows[0] ?? null;
}

export async function getWorkflowRun(workflowName, executionId) {
  const { rows } = await getDatabase().query(
    'SELECT * FROM workflow_runs WHERE workflow_name = $1 AND n8n_execution_id = $2',
    [workflowName, executionId],
  );
  return rows[0] ?? null;
}

export async function closeDatabase() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
