import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const filename of ['dist/ink-tracker.user.js', 'dist/hyatt-tracker.user.js']) {
  const source = await readFile(resolve(root, filename), 'utf8');
  new Script(source, { filename });
  console.log(`Syntax checked ${filename}`);
}
