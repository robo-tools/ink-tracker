import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseTag = process.argv[2];
if (!releaseTag) throw new Error('Pass the release tag, for example: v1.0.0');

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const apps = [
  { id: 'ink-tracker', metadata: 'apps/ink/metadata.txt', ui: 'apps/ink/ui.js' },
  { id: 'hyatt-tracker', metadata: 'apps/hyatt/metadata.txt', ui: 'apps/hyatt/ui.js' }
];

const version = packageJson.version;
const expectedTag = `v${version}`;
const versionLine = `// @version      ${version}`;
const uiVersion = `<span class="version">v${version}</span>`;

const checks = [[releaseTag === expectedTag, `tag ${releaseTag} does not match package version ${version}`]];
for (const app of apps) {
  const metadata = await readFile(resolve(root, app.metadata), 'utf8');
  const ui = await readFile(resolve(root, app.ui), 'utf8');
  const builtMetadata = await readFile(resolve(root, `dist/${app.id}.meta.js`), 'utf8');
  const builtUserscript = await readFile(resolve(root, `dist/${app.id}.user.js`), 'utf8');
  checks.push(
    [metadata.includes(versionLine), `${app.metadata} version does not match package.json`],
    [ui.includes(uiVersion), `${app.ui} visible version does not match package.json`],
    [builtMetadata.includes(versionLine), `dist/${app.id}.meta.js version does not match package.json`],
    [builtUserscript.includes(versionLine), `dist/${app.id}.user.js version does not match package.json`]
  );
}

const hyattMetadata = await readFile(resolve(root, 'apps/hyatt/metadata.txt'), 'utf8');
const pdfModule = await readFile(resolve(root, 'dist/vendor/pdf-5.6.205.min.mjs'));
const pdfWorker = await readFile(resolve(root, 'dist/vendor/pdf.worker-5.6.205.min.mjs'));
checks.push(
  [hyattMetadata.includes('// @grant        GM.getResourceText'), 'Hyatt metadata does not grant access to cached parser resources'],
  [hyattMetadata.includes('/vendor/pdf-5.6.205.min.mjs'), 'Hyatt metadata does not reference the pinned PDF.js module'],
  [hyattMetadata.includes('/vendor/pdf.worker-5.6.205.min.mjs'), 'Hyatt metadata does not reference the pinned PDF.js worker'],
  [pdfModule.length > 400_000, 'built PDF.js module is missing or unexpectedly small'],
  [pdfWorker.length > 1_000_000, 'built PDF.js worker is missing or unexpectedly small']
);

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) throw new Error(failures.join('\n'));

console.log(`Release ${releaseTag} matches all version declarations for ${apps.length} userscripts.`);
