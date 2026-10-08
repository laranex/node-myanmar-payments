// Builds the dual package with the TypeScript compiler only (no bundler):
// dist/esm holds ES modules, dist/cjs CommonJS modules, each with its own .d.ts files.
// dist/cjs/package.json marks that folder as CommonJS for Node and TypeScript.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync('dist', { recursive: true, force: true });
for (const project of ['tsconfig.build.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [tsc, '--project', project], { stdio: 'inherit' });
}
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
