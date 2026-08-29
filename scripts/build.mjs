import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSources = [
  'packages/chase-core/lib/dates.js',
  'packages/chase-core/lib/csv.js',
  'packages/chase-core/lib/matching.js',
  'packages/chase-core/lib/normalize.js',
  'packages/chase-core/app/storage.js',
  'packages/chase-core/app/chase-dom.js',
  'packages/chase-core/app/capture.js'
];

const apps = [
  {
    id: 'ink-tracker',
    metadata: 'apps/ink/metadata.txt',
    sources: [
      ...sharedSources,
      'apps/ink/products.js',
      'apps/ink/calculations.js',
      'apps/ink/rewards-dom.js',
      'apps/ink/ui.js',
      'apps/ink/main.js'
    ]
  },
  {
    id: 'hyatt-tracker',
    metadata: 'apps/hyatt/metadata.txt',
    sources: [
      ...sharedSources,
      'packages/chase-core/lib/statements.js',
      'packages/chase-core/app/chase-statements.js',
      'apps/hyatt/products.js',
      'apps/hyatt/calculations.js',
      'apps/hyatt/setup.js',
      'apps/hyatt/ui.js',
      'apps/hyatt/main.js'
    ]
  }
];

function stripModules(source, filename) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .trim()
    .concat(`\n\n// end ${filename}`);
}

const vendorAssets = [
  ['vendor/pdfjs/pdf-5.6.205.min.mjs', 'dist/vendor/pdf-5.6.205.min.mjs'],
  ['vendor/pdfjs/pdf.worker-5.6.205.min.mjs', 'dist/vendor/pdf.worker-5.6.205.min.mjs'],
  ['vendor/pdfjs/LICENSE', 'dist/vendor/pdfjs-LICENSE']
];
for (const [source, destination] of vendorAssets) {
  const output = resolve(root, destination);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(resolve(root, source), output);
  console.log(`Copied ${output}`);
}

for (const app of apps) {
  const metadata = (await readFile(resolve(root, app.metadata), 'utf8')).trim();
  const bodies = [];
  for (const filename of app.sources) {
    const source = await readFile(resolve(root, filename), 'utf8');
    bodies.push(`// ---- ${filename} ----\n${stripModules(source, filename)}`);
  }

  const output = `${metadata}\n\n(() => {\n  'use strict';\n\n${bodies.join('\n\n')}\n})();\n`;
  const destination = resolve(root, `dist/${app.id}.user.js`);
  const metadataDestination = resolve(root, `dist/${app.id}.meta.js`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output, 'utf8');
  await writeFile(metadataDestination, `${metadata}\n`, 'utf8');
  console.log(`Built ${destination} (${Buffer.byteLength(output).toLocaleString()} bytes)`);
  console.log(`Built ${metadataDestination} (${Buffer.byteLength(metadata).toLocaleString()} bytes)`);
}
