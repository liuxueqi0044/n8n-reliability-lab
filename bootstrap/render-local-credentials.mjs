import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: node render-local-credentials.mjs <input> <output>');

const allowed = new Set(['LAB_DB_NAME', 'LAB_DB_USER', 'LAB_DB_PASSWORD', 'LAB_OPERATOR_HEADER_NAME', 'LAB_OPERATOR_HEADER_VALUE']);
const values = Object.fromEntries([...allowed].map((key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Required credential render variable is missing: ${key}`);
  return [key, value];
}));

function render(value) {
  if (Array.isArray(value)) return value.map(render);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, render(nested)]));
  if (typeof value !== 'string') return value;
  const placeholder = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (placeholder) {
    const key = placeholder[1];
    if (!allowed.has(key)) throw new Error(`Credential template uses a disallowed placeholder: ${key}`);
    return values[key];
  }
  if (value.includes('${')) throw new Error('Credential template contains a malformed placeholder');
  return value;
}

const template = JSON.parse(await readFile(inputPath, 'utf8'));
await writeFile(outputPath, `${JSON.stringify(render(template))}\n`, { encoding: 'utf8', mode: 0o600 });
