import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'src/lib/dates.js',
  'src/lib/products.js',
  'src/lib/csv.js',
  'src/lib/normalize.js',
  'src/lib/matching.js',
  'src/lib/calculations.js',
  'src/app/storage.js',
  'src/app/chase-dom.js',
  'src/app/rewards-dom.js',
  'src/app/capture.js',
  'src/app/ui.js',
  'src/main.js'
];

function stripModules(source, filename) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .trim()
    .concat(`\n\n// end ${filename}`);
}

const metadata = (await readFile(resolve(root, 'src/metadata.txt'), 'utf8')).trim();
const bodies = [];
for (const filename of sources) {
  const source = await readFile(resolve(root, filename), 'utf8');
  bodies.push(`// ---- ${filename} ----\n${stripModules(source, filename)}`);
}

const output = `${metadata}\n\n(() => {\n  'use strict';\n\n${bodies.join('\n\n')}\n})();\n`;
const destination = resolve(root, 'dist/ink-tracker.user.js');
const metadataDestination = resolve(root, 'dist/ink-tracker.meta.js');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, output, 'utf8');
await writeFile(metadataDestination, `${metadata}\n`, 'utf8');
console.log(`Built ${destination} (${Buffer.byteLength(output).toLocaleString()} bytes)`);
console.log(`Built ${metadataDestination} (${Buffer.byteLength(metadata).toLocaleString()} bytes)`);
