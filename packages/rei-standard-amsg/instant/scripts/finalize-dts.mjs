// Post-build step for declaration files.
//
// tsc mirrors the src/ layout (src/blob-store/*.js → dist/blob-store/*.d.ts),
// but the published subpaths rename that directory (package.json exports map
// `./blob/*` → dist/blob/*, matching the tsup entry keys). Move the emitted
// declarations next to the JS they describe, then mirror the root .d.ts to
// .d.cts like the shared package does.
import { readdirSync, renameSync, rmdirSync, copyFileSync, existsSync } from 'node:fs';

const from = 'dist/blob-store';
const to = 'dist/blob';
if (existsSync(from)) {
  for (const file of readdirSync(from)) {
    renameSync(`${from}/${file}`, `${to}/${file}`);
  }
  rmdirSync(from);
}
copyFileSync('dist/index.d.ts', 'dist/index.d.cts');
