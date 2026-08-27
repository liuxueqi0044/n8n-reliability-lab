import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node list-workflow-ids.mjs <workflows-directory>');

for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.json')).sort()) {
  const workflow = JSON.parse(await readFile(join(directory, name), 'utf8'));
  if (typeof workflow.id !== 'string' || workflow.id.length === 0) {
    throw new Error(`${name} must contain a non-empty string workflow id`);
  }
  process.stdout.write(`${workflow.id}\n`);
}
