#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Inlines the shared per-field validator from scripts/validate-snippet.mjs
// into the browser builder Worker file (path resolved below) so that
// the browser builder runs exactly the same validation rules as the
// Node generator without a runtime import (the Worker is a single
// self-contained file, pasted verbatim into the Cloudflare editor).
//
// Usage:
//   node scripts/build-builder-worker.mjs            # rewrite the file
//   node scripts/build-builder-worker.mjs --check    # exit non-zero if stale
//
// The script locates a clearly-marked block in the builder Worker:
//
//   // BEGIN GENERATED FROM scripts/validate-snippet.mjs
//   ...auto-generated body, do not edit...
//   // END GENERATED FROM scripts/validate-snippet.mjs
//
// and rewrites everything between (and including) those markers from
// the shared module's source. The shared module's `export ` keywords
// are stripped and the resulting body is escaped for inclusion in the
// surrounding template literal (backslashes, backticks, and ${ are
// escaped). The pre-commit hook and CI both run --check.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SHARED_PATH = join(REPO_ROOT, 'scripts', 'validate-snippet.mjs');
const BUILDER_FILENAME = '_builder_worker.js';
const BEGIN_MARKER = '// BEGIN GENERATED FROM scripts/validate-snippet.mjs';
const END_MARKER = '// END GENERATED FROM scripts/validate-snippet.mjs';

// Directories never worth scanning when locating the builder Worker
// file. Keeps the search cheap and avoids node_modules-style noise on
// future clones.
const IGNORED_DIRS = new Set([
  '.git',
  '.local',
  '.cache',
  '.config',
  '.agents',
  'node_modules',
  'snippets',
  'generated',
  'media',
]);

const CHECK_ONLY = process.argv.includes('--check');

// Walk the repository and return the first file whose basename matches
// BUILDER_FILENAME. The builder Worker is the only file with that
// name, so this stays unambiguous without hard-coding the directory it
// happens to live in (the surrounding documentation tree is internal
// and may not ship with every clone).
async function findBuilderPath(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && IGNORED_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile() && e.name === BUILDER_FILENAME) {
        return join(dir, e.name);
      }
    }
  }
  return null;
}

function stripExports(src) {
  // Remove the SPDX header comment block (lines starting with //) that
  // opens the shared module so the inlined copy doesn't repeat the
  // header inside the Worker. Stop at the first non-comment, non-blank
  // line.
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//')) {
      i++;
      continue;
    }
    break;
  }
  const body = lines.slice(i).join('\n');
  // Remove the `export ` keyword in front of every const / function
  // declaration; the inlined block lives inside an IIFE so the
  // identifiers are simply local.
  return body.replace(/^export\s+/gm, '');
}

function escapeForTemplateLiteral(src) {
  return src
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function buildBlock(sharedSrc) {
  const stripped = stripExports(sharedSrc);
  const escaped = escapeForTemplateLiteral(stripped);
  const indented = escaped.replace(/^/gm, '  ').replace(/^\s+$/gm, '');
  // The header comment lines are emitted into a surrounding template
  // literal in _builder_worker.js, so they must not contain raw
  // backticks or "${" sequences that would close the literal early.
  // Keep this header ASCII and free of those characters.
  return [
    '  ' + BEGIN_MARKER,
    '  // Auto-generated. Do not edit by hand. Run',
    '  //   node scripts/build-builder-worker.mjs',
    '  // to regenerate this block from scripts/validate-snippet.mjs.',
    indented,
    '  ' + END_MARKER,
  ].join('\n');
}

function spliceBlock(workerSrc, replacement, builderPath) {
  const beginIdx = workerSrc.indexOf(BEGIN_MARKER);
  const endIdx = workerSrc.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `[ERROR] build-builder-worker: could not find the BEGIN/END markers in ` +
      `${builderPath}. Add the sentinel comments first.`,
    );
  }
  // Replace from the beginning of the BEGIN_MARKER line up to the end of
  // the END_MARKER line. Find line starts/ends.
  const lineStart = workerSrc.lastIndexOf('\n', beginIdx) + 1;
  const endOfEndLine = workerSrc.indexOf('\n', endIdx);
  const lineEnd = endOfEndLine === -1 ? workerSrc.length : endOfEndLine;
  return workerSrc.slice(0, lineStart) + replacement + workerSrc.slice(lineEnd);
}

async function main() {
  const builderPath = await findBuilderPath(REPO_ROOT);
  if (!builderPath) {
    // The browser builder Worker source is internal and may not ship
    // with every clone. With no file to update there is nothing to do
    // and nothing to check; exit cleanly so this script stays safe to
    // run from any clone (CI, public, contributor).
    console.log(
      `[OK] build-builder-worker: no ${BUILDER_FILENAME} present; nothing to inline`,
    );
    return;
  }
  const builderRel = relative(REPO_ROOT, builderPath) || builderPath;
  const sharedSrc = await readFile(SHARED_PATH, 'utf8');
  const workerSrc = await readFile(builderPath, 'utf8');
  const block = buildBlock(sharedSrc);
  const next = spliceBlock(workerSrc, block, builderRel);

  if (CHECK_ONLY) {
    if (next !== workerSrc) {
      console.error(
        `[FAIL] build-builder-worker: ${builderRel} is out of sync with ` +
        `scripts/validate-snippet.mjs.\n` +
        `       Run: node scripts/build-builder-worker.mjs`,
      );
      process.exit(1);
    }
    console.log('[OK] build-builder-worker: builder Worker is in sync with shared validator');
    return;
  }

  if (next === workerSrc) {
    console.log('[OK] build-builder-worker: no changes needed');
    return;
  }
  await writeFile(builderPath, next);
  console.log(`[OK] build-builder-worker: rewrote ${builderRel}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
