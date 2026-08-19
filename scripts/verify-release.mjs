import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseTag = process.argv[2];
if (!releaseTag) throw new Error('Pass the release tag, for example: v0.9.7');

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const metadata = await readFile(resolve(root, 'src/metadata.txt'), 'utf8');
const ui = await readFile(resolve(root, 'src/app/ui.js'), 'utf8');
const builtMetadata = await readFile(resolve(root, 'dist/ink-tracker.meta.js'), 'utf8');
const builtUserscript = await readFile(resolve(root, 'dist/ink-tracker.user.js'), 'utf8');

const version = packageJson.version;
const expectedTag = `v${version}`;
const versionLine = `// @version      ${version}`;
const uiVersion = `<span class="version">v${version}</span>`;

const checks = [
  [releaseTag === expectedTag, `tag ${releaseTag} does not match package version ${version}`],
  [metadata.includes(versionLine), 'src/metadata.txt version does not match package.json'],
  [ui.includes(uiVersion), 'visible UI version does not match package.json'],
  [builtMetadata.includes(versionLine), 'built metadata version does not match package.json'],
  [builtUserscript.includes(versionLine), 'built userscript version does not match package.json']
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) throw new Error(failures.join('\n'));

console.log(`Release ${releaseTag} matches all version declarations.`);
