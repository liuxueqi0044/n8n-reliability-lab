import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { waitForHttp } from './wait-for-stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const n8nPort = Number(process.env.N8N_HOST_PORT ?? 5678);
const compose = (args) => new Promise((resolvePromise, reject) => {
  const child = spawn('docker', ['compose', ...args], { cwd: root, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolvePromise();
    else {
      const error = new Error(`docker compose ${args.join(' ')} failed (${signal ?? `exit ${code}`})`);
      error.exitCode = code ?? 1;
      reject(error);
    }
  });
});

try {
  // n8n-initialize uses the same data volume as n8n, so make this exclusive.
  await compose(['stop', 'n8n', 'n8n-runner']);
  await compose(['up', '-d', '--wait', 'postgres', 'wiremock']);
  await compose(['run', '--rm', '--no-deps', 'db-migrate']);
  await compose(['run', '--rm', '--no-deps', 'n8n-initialize']);
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'n8n']);
  await waitForHttp(`http://127.0.0.1:${n8nPort}/healthz/readiness`, { timeoutMs: 90_000 });
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'n8n-runner']);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
