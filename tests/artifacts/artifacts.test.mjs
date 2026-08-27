import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const execute = promisify(execFile);
const root = process.cwd();
const expectedWorkflows = new Map([
  ['lead-intake.json', 'LeadIntake000001'],
  ['approval-and-delivery.json', 'ApprovalDeliv001'],
  ['failure-recovery.json', 'FailureRecover01'],
]);

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function visit(value, callback) {
  if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
  else if (value && typeof value === 'object') {
    callback(value);
    Object.values(value).forEach((item) => visit(item, callback));
  }
}

test('workflow artifacts have fixed unique identities and credential references only', async () => {
  const workflows = await Promise.all([...expectedWorkflows].map(async ([file, id]) => {
    const workflow = JSON.parse(await readFile(join(root, 'workflows', file), 'utf8'));
    assert.equal(workflow.id, id, `${file} must retain its fixed id`);
    return workflow;
  }));
  assert.equal(new Set(workflows.map((workflow) => workflow.id)).size, 3, 'workflow ids must be unique');
  for (const workflow of workflows) {
    visit(workflow, (object) => {
      if (object.credentials) {
        for (const credential of Object.values(object.credentials)) {
          assert.deepEqual(Object.keys(credential).sort(), ['id', 'name']);
        }
      }
    });
  }
});

test('workflow exports contain no demo secret, private key, token, or credential data', async () => {
  const content = await Promise.all([...expectedWorkflows.keys()].map((file) => readFile(join(root, 'workflows', file), 'utf8')));
  const exported = content.join('\n');
  assert.doesNotMatch(exported, /reliability_lab_local_only|operator_local_only|postgres_local_only|n8n_local_only/i);
  assert.doesNotMatch(exported, /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|credentialData/i);
  assert.doesNotMatch(exported, /"(?:password|api[_-]?key|client_secret|access_token|refresh_token|token)"\s*:/i);
  assert.doesNotMatch(exported, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/);
});

test('compose is valid and uses no latest image', async () => {
  await execute('docker', ['compose', 'config', '--quiet'], { cwd: root });
  const { stdout } = await execute('docker', ['compose', 'config', '--format', 'json'], { cwd: root });
  const config = JSON.parse(stdout);
  for (const [service, definition] of Object.entries(config.services)) {
    assert.ok(definition.image && !definition.image.endsWith(':latest'), `${service} must use a pinned image`);
  }
});

test('public repository files and README first screen are present', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const firstScreen = readme.slice(0, 4000);
  const positions = [
    'A production-oriented n8n workflow lab',
    'Most workflow demos only show the happy path',
    '```mermaid',
    'docs/screenshots/approval-and-delivery.png',
    'docker compose up -d --wait',
    'PASS valid lead delivered',
  ].map((text) => firstScreen.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'README first screen contract must remain ordered');
  for (const path of ['LICENSE', '.github/workflows/ci.yml', 'docs/architecture.md', 'docs/acceptance-tests.md']) {
    assert.equal(await exists(join(root, path)), true, `${path} must exist`);
  }
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /permissions:\s*\n\s+contents: read/);
  assert.match(ci, /actions\/checkout@v6/);
  assert.match(ci, /persist-credentials: false/);
  assert.match(ci, /actions\/setup-node@v6/);
  assert.match(ci, /node-version: 20/);
  assert.match(ci, /npm test/);
  assert.match(ci, /docker compose logs/);
  assert.match(ci, /docker compose down --volumes --remove-orphans/);
});

test('real overview and detail workflow screenshots are present', async () => {
  for (const name of ['approval-and-delivery.png', 'approval-gate.png', 'retry-dead-letter.png']) {
    const screenshot = join(root, 'docs/screenshots', name);
    assert.equal(await exists(screenshot), true, `${name} must be committed`);
    assert.ok((await stat(screenshot)).size > 20_000, `${name} must not be a placeholder`);
    const header = await readFile(screenshot);
    assert.deepEqual([...header.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${name} must be PNG`);
  }
});
