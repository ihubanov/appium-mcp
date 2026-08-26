#!/usr/bin/env node
/**
 * Cross-platform post-build step.
 *
 * Replaces the previous shell one-liners (`chmod +x`, `mkdir -p`, `cp -f`),
 * which only ran on Unix. npm executes package scripts through cmd.exe on
 * Windows, where none of those exist — and because `chmod` was chained with
 * `&&`, the whole build failed there rather than degrading.
 *
 * Everything here is a no-op when it does not apply, so the build succeeds on
 * Windows, macOS and Linux alike.
 */
import { chmodSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Make the CLI entry point executable. Meaningless on Windows, so skip it
//    there rather than failing.
if (process.platform !== 'win32') {
  const entry = join(root, 'dist', 'index.js');
  if (existsSync(entry)) {
    chmodSync(entry, 0o755);
  }
}

// 2. Copy the documentation index into dist, if it was generated. Optional —
//    absence is not an error, matching the previous `|| true`.
const docsRel = join('tools', 'documentation', 'uploads', 'documents.json');
const src = join(root, 'src', docsRel);
const dest = join(root, 'dist', docsRel);

if (existsSync(src)) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`postbuild: copied ${docsRel}`);
} else {
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`postbuild: no ${docsRel} to copy (skipped)`);
}
