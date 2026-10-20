/**
 * esbuild build script.
 *
 * - Bundles `src/main.ts` -> `dist/code.js` (self-contained, no imports at
 *   runtime; Figma sandboxes run it as a plain script).
 * - Inlines `src/ui/ui.html` into the bundle as raw text (loader `.html` = text)
 *   and also copies it to `dist/ui.html` for the manifest entry.
 *
 * The plugin never fetches anything at runtime; `manifest.json` sets
 * `networkAccess: none`. There is no minification so the generated artifact is
 * reviewable/debuggable.
 */
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, '..', 'dist');

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  entryPoints: [join(root, '..', 'src', 'main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  outfile: join(distDir, 'code.js'),
  loader: { '.html': 'text' },
  logLevel: 'info',
  legalComments: 'none',
  metafile: false,
  minify: false,
  sourcemap: false,
  // No `define` network/telemetry switches: the plugin simply has no network code.
};

if (process.argv.includes('--watch')) {
  const context = await (await import('esbuild')).context(baseOptions);
  await context.watch();
  console.log('[compose-studio] watching for changes…');
} else {
  await mkdir(distDir, { recursive: true });
  await build(baseOptions);
  await copyFile(join(root, '..', 'src', 'ui', 'ui.html'), join(distDir, 'ui.html'));
  console.log('[compose-studio] build complete: dist/code.js, dist/ui.html');
}
