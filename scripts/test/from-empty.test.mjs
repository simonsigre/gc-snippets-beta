// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// "Build from empty" test for scripts/generate-indexes.mjs.
//
// Verifies that a fresh clone with no committed generator output (no
// /generated/ directory and no /README.md at the repo root) can run the
// build and produce the full set of files and subdirectories the
// generator owns. The generator already calls mkdir(..., { recursive:
// true }) for every directory it writes to, but this test pins that
// guarantee so a future change cannot quietly introduce a hidden
// "directory must pre-exist" assumption.
//
// To stay hermetic and safe under parallel test execution (other test
// files run the real generator against the live /generated tree), this
// test stages the real snippets corpus and the generator into a fresh
// throwaway directory and runs the generator there. That mirrors the
// "copied the project, /generated is empty" scenario exactly without
// disturbing the working tree.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/test/<file> -> repo root is two levels up.
const REPO_ROOT = resolve(HERE, '..', '..');
const SNIPPETS_DIR = join(REPO_ROOT, 'snippets');

// Files the generator must always produce, regardless of corpus shape.
// Per-module and per-tag RSS files are derived from the corpus and are
// asserted separately below.
const REQUIRED_FILES = [
  'README.md',
  'generated/latest.json',
  'generated/latest-by-module.json',
  'generated/snippets-index.json',
  'generated/tags-index.json',
  'generated/status.json',
  'generated/rss.xml',
];

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function isFileNonEmpty(p) {
  const s = await stat(p);
  return s.isFile() && s.size > 0;
}

async function isDir(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Build the expected per-module and per-tag RSS file lists by reading
// the live /snippets corpus directly. Stays in sync with the corpus
// without manual edits as snippets are added.
async function expectedRssFiles() {
  const moduleSlugs = new Set();
  const tags = new Set();
  for (const name of await readdir(SNIPPETS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const raw = await readFile(join(SNIPPETS_DIR, name), 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof data.module_slug === 'string' && data.module_slug.length > 0) {
      moduleSlugs.add(data.module_slug);
    }
    if (Array.isArray(data.tags)) {
      for (const t of data.tags) {
        if (typeof t === 'string' && t.length > 0) tags.add(t);
      }
    }
  }
  const moduleFiles = Array.from(moduleSlugs)
    .sort()
    .map((slug) => `generated/rss/module/${slug}.xml`);
  const tagFiles = Array.from(tags)
    .sort()
    .map((tag) => `generated/rss/tag/${encodeURIComponent(tag)}.xml`);
  return { moduleFiles, tagFiles };
}

test('generator rebuilds the full output tree from an empty starting state', async (t) => {
  // Stage a fresh tree containing only the inputs the generator needs.
  // No /generated/ directory and no /README.md are pre-created.
  const stage = await mkdtemp(join(tmpdir(), 'gocortex-from-empty-'));
  await mkdir(join(stage, 'snippets'), { recursive: true });
  await mkdir(join(stage, 'scripts'), { recursive: true });

  // Copy the generator and its sibling modules; the script computes
  // its own paths relative to its own location, so the staged tree is
  // self-contained.
  for (const f of [
    'generate-indexes.mjs',
    'snippet.schema.json',
    'validate-snippet.mjs',
  ]) {
    await cp(join(REPO_ROOT, 'scripts', f), join(stage, 'scripts', f));
  }

  // Copy the real snippets corpus so the test reflects the actual
  // "copied the project, /generated is empty" scenario.
  for (const name of await readdir(SNIPPETS_DIR)) {
    await cp(join(SNIPPETS_DIR, name), join(stage, 'snippets', name));
  }

  // Sanity: confirm the staged tree really has no generator output yet.
  assert.equal(
    await pathExists(join(stage, 'generated')),
    false,
    'staged tree must start with no /generated/ directory',
  );
  assert.equal(
    await pathExists(join(stage, 'README.md')),
    false,
    'staged tree must start with no /README.md',
  );

  // Run the real generator. SOURCE_DATE_EPOCH is pinned so the run is
  // reproducible, matching the snapshot test's convention.
  const result = spawnSync('node', ['scripts/generate-indexes.mjs'], {
    cwd: stage,
    env: {
      ...process.env,
      SITE_URL: 'https://test.example',
      SOURCE_DATE_EPOCH: '1767225600',
    },
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `generator exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  // Every always-present output file must exist and be non-empty.
  for (const rel of REQUIRED_FILES) {
    const p = join(stage, rel);
    assert.ok(await pathExists(p), `missing required output: ${rel}`);
    assert.ok(await isFileNonEmpty(p), `required output is empty: ${rel}`);
  }

  // Subdirectories under /generated/rss must exist.
  assert.ok(
    await isDir(join(stage, 'generated', 'rss')),
    'missing /generated/rss directory',
  );
  assert.ok(
    await isDir(join(stage, 'generated', 'rss', 'module')),
    'missing /generated/rss/module directory',
  );
  assert.ok(
    await isDir(join(stage, 'generated', 'rss', 'tag')),
    'missing /generated/rss/tag directory',
  );

  // Per-module and per-tag RSS feeds, derived from the live corpus, all
  // exist and are non-empty.
  const { moduleFiles, tagFiles } = await expectedRssFiles();
  assert.ok(moduleFiles.length > 0, 'corpus must yield at least one module feed');
  assert.ok(tagFiles.length > 0, 'corpus must yield at least one tag feed');
  for (const rel of [...moduleFiles, ...tagFiles]) {
    const p = join(stage, rel);
    assert.ok(await pathExists(p), `missing per-slice feed: ${rel}`);
    assert.ok(await isFileNonEmpty(p), `per-slice feed is empty: ${rel}`);
  }
});
