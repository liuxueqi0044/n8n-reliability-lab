import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { compose, requireSuccess } from '../helpers/runtime.mjs';

const { Client } = pg;
const ports = {
  n8n: Number(process.env.N8N_HOST_PORT ?? 5678),
  postgres: Number(process.env.POSTGRES_HOST_PORT ?? 5432),
  wiremock: Number(process.env.WIREMOCK_HOST_PORT ?? 8080),
};
const local = {
  host: '127.0.0.1', port: ports.postgres,
  user: process.env.POSTGRES_SUPERUSER ?? 'postgres', password: process.env.POSTGRES_SUPERUSER_PASSWORD ?? 'postgres_local_only', database: 'postgres',
};

test('compose configuration is valid and all images are pinned', async () => {
  await compose('config', '--quiet');
  const { stdout } = await requireSuccess('docker', ['compose', 'config', '--format', 'json']);
  const config = JSON.parse(stdout);
  for (const [service, definition] of Object.entries(config.services)) {
    assert.ok(definition.image && !definition.image.endsWith(':latest'), `${service} must use a pinned image`);
  }
  assert.equal(config.services['n8n-runner'].image, 'docker.io/n8nio/runners:2.32.7');
  assert.equal(config.services.n8n.environment.N8N_RUNNERS_BROKER_LISTEN_ADDRESS, '0.0.0.0');
  assert.deepEqual(Object.keys(config.volumes).sort(), ['n8n_data', 'postgres_data']);
  const credentialTemplate = await readFile(join(process.cwd(), 'bootstrap/credentials/local-credentials.json'), 'utf8');
  assert.match(credentialTemplate, /"database": "\$\{LAB_DB_NAME\}"/);
  assert.match(credentialTemplate, /"user": "\$\{LAB_DB_USER\}"/);
  assert.match(credentialTemplate, /"password": "\$\{LAB_DB_PASSWORD\}"/);
  assert.doesNotMatch(credentialTemplate, /\$env|lab_local_only|n8n_local_only/);
  const attributes = await readFile(join(process.cwd(), '.gitattributes'), 'utf8');
  assert.match(attributes, /^\*.sh text eol=lf$/m, 'shell scripts must be checked out with LF line endings');
});

test('postgres databases and application roles are isolated', async () => {
  const client = new Client(local);
  await client.connect();
  try {
    const databases = await client.query("SELECT datname FROM pg_database WHERE datname IN ('n8n', 'reliability_lab') ORDER BY datname");
    assert.deepEqual(databases.rows.map((row) => row.datname), ['n8n', 'reliability_lab']);
    const roles = await client.query("SELECT rolname, rolsuper FROM pg_roles WHERE rolname IN ('n8n', 'reliability_app') ORDER BY rolname");
    assert.deepEqual(roles.rows, [{ rolname: 'n8n', rolsuper: false }, { rolname: 'reliability_app', rolsuper: false }]);
  } finally { await client.end(); }
});

test('WireMock, n8n, owner provisioning, runner, and bootstrap cleanup are healthy', async () => {
  const [wiremock, n8n, settings] = await Promise.all([
    fetch(`http://127.0.0.1:${ports.wiremock}/__admin/health`),
    fetch(`http://127.0.0.1:${ports.n8n}/healthz/readiness`),
    fetch(`http://127.0.0.1:${ports.n8n}/rest/settings`),
  ]);
  assert.ok(wiremock.ok, `WireMock health returned ${wiremock.status}`);
  assert.ok(n8n.ok, `n8n readiness returned ${n8n.status}`);
  assert.ok(settings.ok, `n8n settings returned ${settings.status}`);
  const settingsBody = await settings.json();
  assert.notEqual(settingsBody.data?.userManagement?.isInstanceOwnerSetUp, false, 'owner setup must be complete');
  const { stdout } = await compose('ps', '-a', '--format', 'json', 'n8n-initialize');
  const services = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(services.every((service) => service.State !== 'running' && !(service.State === 'exited' && service.ExitCode !== 0)), 'n8n-initialize must not be running or have failed');
  const runner = await compose('ps', '--format', 'json', 'n8n-runner');
  const runnerServices = runner.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(runnerServices.some((service) => service.State === 'running'), 'n8n-runner must be running');
});

test('workflow files are imported and available when present', async () => {
  const workflowDirectory = join(process.cwd(), 'workflows');
  const files = (await readdir(workflowDirectory)).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const workflow = JSON.parse(await readFile(join(workflowDirectory, file), 'utf8'));
    assert.equal(typeof workflow.id, 'string', `${file} must contain a fixed workflow id`);
    const exportedPath = `/tmp/${workflow.id}.json`;
    await compose('exec', '-T', 'n8n', 'n8n', 'export:workflow', `--id=${workflow.id}`, `--output=${exportedPath}`);
    const exported = await compose('exec', '-T', 'n8n', 'cat', exportedPath);
    const exportedWorkflows = JSON.parse(exported.stdout);
    assert.ok(Array.isArray(exportedWorkflows) && exportedWorkflows.length === 1, `${workflow.id} export must contain exactly one workflow`);
    const [exportedWorkflow] = exportedWorkflows;
    assert.equal(exportedWorkflow.id, workflow.id, `${workflow.id} must be available in n8n`);
    assert.equal(exportedWorkflow.active, true, `${workflow.id} must be published and active`);
    assert.ok(exportedWorkflow.activeVersionId, `${workflow.id} must have a published version`);
  }
});

test('bootstrap remains repeatable', async () => {
  await requireSuccess('node', ['scripts/bootstrap.mjs']);
});
