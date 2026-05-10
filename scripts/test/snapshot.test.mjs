// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Snapshot test for scripts/generate-indexes.mjs.
//
// Spawns the real generator against a small fixture corpus in a throwaway
// directory and asserts every produced file is byte-equal to a committed
// expected output. Catches accidental changes to:
//   - the snippets-index / latest / latest-by-module / tags-index shapes
//   - the RSS feed structure or escaping
//   - the auto-generated README rendering
// The generator is run as a subprocess so we exercise exactly the same code
// path that CI runs, including the SITE_URL handling.
//
// To regenerate fixtures (e.g. after an intentional change):
//   UPDATE_SNAPSHOTS=1 node --test scripts/test/snapshot.test.mjs
// then review the diff under scripts/test/expected/ and commit it.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURE_SNIPPETS = join(HERE, 'fixtures', 'snippets');
const EXPECTED_DIR = join(HERE, 'expected');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// Files that must always be present in the generator output. Per-slice
// outputs (per-module RSS, per-tag RSS) are discovered by walking the
// staged tree, so adding a new fixture or a new generator output is
// caught automatically without editing this list.
const REQUIRED_OUTPUT_FILES = [
  'generated/latest.json',
  'generated/latest-by-module.json',
  'generated/snippets-index.json',
  'generated/tags-index.json',
  'generated/status.json',
  'generated/rss.xml',
  'README.md',
];

// Pin SOURCE_DATE_EPOCH so generator outputs that bake in a "now"
// timestamp (currently just generated/status.json) are byte-stable
// across runs. Picked once and shared with the staged subprocess via
// the environment.
const FIXED_EPOCH = '1767225600'; // 2026-01-01T00:00:00Z

// Recursively list every regular file under one or more roots, returning
// the union as forward-slash paths relative to the search root.
async function walkRel(root, sub = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(join(root, sub), { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await walkRel(root, rel)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function stageRun() {
  const stage = await mkdtemp(join(tmpdir(), 'gocortex-snapshot-'));
  await mkdir(join(stage, 'snippets'), { recursive: true });
  await mkdir(join(stage, 'scripts'), { recursive: true });
  // Copy the generator and schema into the staging directory so the script
  // resolves SNIPPETS_DIR/GENERATED_DIR/README_PATH from the staged tree
  // (its paths are computed relative to its own location).
  await cp(
    join(REPO_ROOT, 'scripts', 'generate-indexes.mjs'),
    join(stage, 'scripts', 'generate-indexes.mjs'),
  );
  await cp(
    join(REPO_ROOT, 'scripts', 'snippet.schema.json'),
    join(stage, 'scripts', 'snippet.schema.json'),
  );
  // The generator imports the shared per-field validator. Copy it into
  // the staged tree so the relative `./validate-snippet.mjs` import
  // resolves under the temporary directory.
  await cp(
    join(REPO_ROOT, 'scripts', 'validate-snippet.mjs'),
    join(stage, 'scripts', 'validate-snippet.mjs'),
  );
  // Copy fixture snippets into the staged snippets/ directory.
  for (const name of await readdir(FIXTURE_SNIPPETS)) {
    await cp(join(FIXTURE_SNIPPETS, name), join(stage, 'snippets', name));
  }
  const result = spawnSync('node', ['scripts/generate-indexes.mjs'], {
    cwd: stage,
    env: {
      ...process.env,
      SITE_URL: 'https://test.example',
      SOURCE_DATE_EPOCH: FIXED_EPOCH,
    },
    encoding: 'utf8',
  });
  return { stage, result };
}

// Files we never compare against expected output even if they appear in
// the staged tree (the input snippets are copied in, not generated).
const IGNORED_PREFIXES = ['snippets/', 'scripts/'];

function shouldCompare(rel) {
  for (const p of IGNORED_PREFIXES) {
    if (rel.startsWith(p)) return false;
  }
  return true;
}

test('generator output matches committed snapshots', async () => {
  const { stage, result } = await stageRun();
  assert.equal(
    result.status,
    0,
    `generator exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  // Collect the union of files present in either side. Any entry that
  // exists in only one tree is reported via the byte comparison below
  // because the missing-side read fails with a clear message.
  const stagedFiles = (await walkRel(stage)).filter(shouldCompare);
  const expectedFiles = await walkRel(EXPECTED_DIR);
  const union = Array.from(new Set([...stagedFiles, ...expectedFiles])).sort();

  // Sanity check: the always-present outputs must show up in the staged
  // tree even if the corpus is empty.
  for (const rel of REQUIRED_OUTPUT_FILES) {
    assert.ok(
      stagedFiles.includes(rel),
      `generator did not produce required output file ${rel}\n` +
        `staged files:\n${stagedFiles.join('\n')}`,
    );
  }

  for (const rel of union) {
    const actualPath = join(stage, rel);
    const expectedPath = join(EXPECTED_DIR, rel);
    let actual;
    try {
      actual = await readFile(actualPath, 'utf8');
    } catch {
      if (UPDATE) {
        // File no longer produced; remove from expected on the next
        // commit. We do not unlink here automatically because the test
        // runner shouldn't mutate the working tree silently.
        assert.fail(
          `expected snapshot ${rel} no longer produced by generator;\n` +
            `delete test/expected/${rel} and re-run UPDATE_SNAPSHOTS=1.`,
        );
      }
      assert.fail(
        `expected snapshot ${rel} not produced by generator;\n` +
          `staged files:\n${stagedFiles.join('\n')}`,
      );
    }
    if (UPDATE) {
      await mkdir(dirname(expectedPath), { recursive: true });
      await writeFile(expectedPath, actual);
      continue;
    }
    let expected;
    try {
      expected = await readFile(expectedPath, 'utf8');
    } catch {
      assert.fail(
        `expected snapshot missing: ${expectedPath}\n` +
          `re-run with UPDATE_SNAPSHOTS=1 to seed it.\nactual:\n${actual}`,
      );
    }
    assert.equal(
      actual,
      expected,
      `snapshot mismatch for ${rel}\n` +
        `if intentional, re-run with UPDATE_SNAPSHOTS=1 and commit the diff.`,
    );
  }
});
