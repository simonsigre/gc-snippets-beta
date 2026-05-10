// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Validator tests. Two complementary test suites share this file:
//
//   1. Failure-mode corpus for scripts/generate-indexes.mjs.
//      For every documented validation rule we stage a fixture snippet
//      under a throwaway directory, run the generator with --check
//      (validation only, no files written) and assert the exact per-line
//
//        [FAIL] <filename>: <detail>
//
//      message ends up on stderr. The snapshot test already covers the
//      happy path against a curated corpus; this suite locks down the
//      negative path so a regression in any single error string is
//      caught by CI. Each case is intentionally tiny: a base "valid"
//      snippet object plus a patch describing the field(s) under test.
//      Cross-snippet rules (supersedes/superseded_by) stage two
//      snippets at once.
//
//   2. Differential test for the shared validator
//      (scripts/validate-snippet.mjs).
//      Walks a small corpus of valid and invalid snippet objects
//      through two independent validators and asserts they agree on
//      the verdict (valid vs invalid):
//        a. validateFields() imported from
//           scripts/validate-snippet.mjs in this Node process.
//        b. The same function as it actually runs inside the browser
//           builder Worker. We locate _builder_worker.js by walking
//           the repo (the Worker tree may not ship with every clone),
//           extract the inlined block (between the BEGIN/END sentinel
//           comments), undo the template-literal escaping the build
//           step applied, and evaluate it in a fresh function scope.
//           This catches any drift between the shared module and the
//           inlined copy that a stale build step would leave behind.
//           Suite 2 skips cleanly when the builder Worker is absent.
//      The suite also re-runs scripts/build-builder-worker.mjs --check
//      so the inlined copy is by-construction byte-equal to the shared
//      module on CI.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { validateFields as nodeValidateFields } from '../validate-snippet.mjs';
import { findRepoFile } from './_helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-indexes.mjs');
const SCHEMA = join(REPO_ROOT, 'scripts', 'snippet.schema.json');
const SHARED_VALIDATOR = join(REPO_ROOT, 'scripts', 'validate-snippet.mjs');
const BUILDER_PATH = await findRepoFile(REPO_ROOT, '_builder_worker.js');
const BUILD_BUILDER = join(REPO_ROOT, 'scripts', 'build-builder-worker.mjs');
const BEGIN_MARKER = '// BEGIN GENERATED FROM scripts/validate-snippet.mjs';
const END_MARKER = '// END GENERATED FROM scripts/validate-snippet.mjs';

// ---------------------------------------------------------------------------
// Suite 1: failure-mode corpus for the generator (subprocess + stderr line).
// ---------------------------------------------------------------------------

// A minimal valid snippet keyed to filename "202601010001_GoCortexSnippet.json".
// Tests start from a deep clone of this object and apply targeted mutations
// so a single broken assertion in the validator can only blame one failure
// mode, not a tangle of pre-existing problems.
const BASE_FILENAME = '202601010001_GoCortexSnippet.json';
const BASE_ID = '202601010001';
const BASE_SNIPPET = Object.freeze({
  schema_version: 1,
  id: BASE_ID,
  created_at: '2026-01-01T00:01:00Z',
  product_module: 'Cortex XDR',
  module_slug: 'cortex-xdr',
  scenario: 'Fixture scenario for validator test.',
  snippet: 'Fixture snippet body.',
  time_to_implement: '5 minutes',
  tags: ['detection'],
  media_type: '',
  media_base64: '',
});

function cloneBase(patch = {}) {
  return { ...JSON.parse(JSON.stringify(BASE_SNIPPET)), ...patch };
}

// Stage the generator + schema + shared validator into a temp directory,
// write the supplied snippet files into snippets/, run
// `node scripts/generate-indexes.mjs --check`, and return the spawn
// result. We use --check so the generator never writes generated/ or
// README.md and exits cleanly (1) on the first validation failure.
async function runCheck(snippetsByFilename) {
  const stage = await mkdtemp(join(tmpdir(), 'gocortex-validator-'));
  await mkdir(join(stage, 'snippets'), { recursive: true });
  await mkdir(join(stage, 'scripts'), { recursive: true });
  await cp(GENERATOR, join(stage, 'scripts', 'generate-indexes.mjs'));
  await cp(SCHEMA, join(stage, 'scripts', 'snippet.schema.json'));
  // The generator imports the shared per-field validator. Copy it into
  // the staged tree so the relative `./validate-snippet.mjs` import
  // resolves under the temporary directory.
  await cp(SHARED_VALIDATOR, join(stage, 'scripts', 'validate-snippet.mjs'));
  for (const [filename, body] of Object.entries(snippetsByFilename)) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n';
    await writeFile(join(stage, 'snippets', filename), payload);
  }
  const result = spawnSync('node', ['scripts/generate-indexes.mjs', '--check'], {
    cwd: stage,
    encoding: 'utf8',
  });
  return result;
}

// Assert the generator exited non-zero AND produced the exact "[FAIL]
// <filename>: <detail>" line on stderr. We match the full line so a
// regression that drops the filename, changes punctuation, or swaps the
// detail wording is caught.
function assertFailLine(result, filename, detail) {
  assert.notEqual(
    result.status,
    0,
    `expected generator to fail but it exited 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const expected = `[FAIL] ${filename}: ${detail}`;
  const lines = result.stderr.split('\n');
  assert.ok(
    lines.includes(expected),
    `expected stderr to contain line:\n  ${expected}\nactual stderr:\n${result.stderr}`,
  );
}

// Sanity: the un-patched base snippet itself must validate, otherwise
// every negative test below would be ambiguous.
test('base fixture validates cleanly', async () => {
  const result = await runCheck({ [BASE_FILENAME]: cloneBase() });
  assert.equal(
    result.status,
    0,
    `base fixture failed validation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// code_blocks failure modes (the new surface area from task #22)
// ---------------------------------------------------------------------------

test('code_blocks: outer value must be an array', async () => {
  const snippet = cloneBase({ code_blocks: { language: 'python', code: 'x' } });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(result, BASE_FILENAME, '"code_blocks" must be an array');
});

test('code_blocks: too many entries are rejected', async () => {
  const tooMany = Array.from({ length: 9 }, () => ({ language: 'bash', code: 'echo' }));
  const snippet = cloneBase({ code_blocks: tooMany });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"code_blocks" may contain at most 8 entries (got 9)',
  );
});

test('code_blocks: non-object entry is rejected', async () => {
  const snippet = cloneBase({ code_blocks: ['not-an-object'] });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"code_blocks[0]" must be an object with "language" and "code"',
  );
});

test('code_blocks: unknown field on a block is rejected', async () => {
  const snippet = cloneBase({
    code_blocks: [{ language: 'python', code: 'print(1)', caption: 'nope' }],
  });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"code_blocks[0]" has unknown field "caption"',
  );
});

test('code_blocks: language must match the short identifier pattern', async () => {
  const snippet = cloneBase({
    code_blocks: [{ language: 'Python 3', code: 'print(1)' }],
  });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"code_blocks[0]".language must be a short identifier (lowercase a-z, 0-9, "+", "-", up to 16 characters)',
  );
});

test('code_blocks: empty code is rejected', async () => {
  const snippet = cloneBase({ code_blocks: [{ language: 'python', code: '' }] });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(result, BASE_FILENAME, '"code_blocks[0]".code must be a non-empty string');
});

test('code_blocks: oversize code is rejected', async () => {
  const big = 'x'.repeat(16385);
  const snippet = cloneBase({ code_blocks: [{ language: 'python', code: big }] });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"code_blocks[0]".code is 16385 characters (limit 16384)',
  );
});

// ---------------------------------------------------------------------------
// Existing rules (locked down end-to-end for completeness)
// ---------------------------------------------------------------------------

test('module_slug: rejects uppercase / invalid slug', async () => {
  const snippet = cloneBase({ module_slug: 'Cortex_XDR' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"module_slug" must be lowercase, hyphenated (e.g. "cortex-xdr")',
  );
});

test('media pairing: media_type without media_base64 is rejected', async () => {
  const snippet = cloneBase();
  delete snippet.media_base64;
  snippet.media_type = 'image/png';
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"media_type" and "media_base64" must be supplied together',
  );
});

test('media pairing: one populated and one empty is rejected', async () => {
  const snippet = cloneBase({ media_type: 'image/png', media_base64: '' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"media_type" and "media_base64" must both be empty or both be populated',
  );
});

test('supersedes: pointing at an unknown id is rejected', async () => {
  const snippet = cloneBase({ supersedes: '202512310000' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"supersedes" points at unknown snippet id "202512310000"',
  );
});

test('supersedes/superseded_by: one-sided pointer is rejected', async () => {
  // A says it supersedes B, but B does not declare A as its successor.
  const aFilename = '202601020001_GoCortexSnippet.json';
  const bFilename = '202601010001_GoCortexSnippet.json';
  const a = cloneBase({
    id: '202601020001',
    created_at: '2026-01-02T00:01:00Z',
    supersedes: '202601010001',
  });
  const b = cloneBase(); // no superseded_by
  const result = await runCheck({ [aFilename]: a, [bFilename]: b });
  assertFailLine(
    result,
    aFilename,
    '"supersedes" points at "202601010001", but that snippet\'s "superseded_by" is "missing" (expected "202601020001")',
  );
});

test('supersedes: cannot point at the snippet\'s own id', async () => {
  const snippet = cloneBase({ supersedes: BASE_ID });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(result, BASE_FILENAME, '"supersedes" cannot point at the snippet\'s own id');
});

// ---------------------------------------------------------------------------
// A few extra core rules that protect the snippet shape itself
// ---------------------------------------------------------------------------

test('id mismatch with filename timestamp is rejected', async () => {
  const snippet = cloneBase({ id: '209912310000' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"id" (209912310000) does not match filename timestamp (202601010001)',
  );
});

test('legacy field "problem_statement" gets a targeted hint', async () => {
  const snippet = cloneBase({ problem_statement: 'old field name' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    'legacy field "problem_statement" found; rename it to "scenario" (the field was renamed in the snippet schema)',
  );
});

test('unrecognised schema_version is rejected', async () => {
  const snippet = cloneBase({ schema_version: 99 });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"schema_version" 99 is not recognised by this validator (supported: 1)',
  );
});

test('non-UTC created_at is rejected', async () => {
  const snippet = cloneBase({ created_at: '2026-01-01T00:01:00+01:00' });
  const result = await runCheck({ [BASE_FILENAME]: snippet });
  assertFailLine(
    result,
    BASE_FILENAME,
    '"created_at" must be an ISO-8601 UTC timestamp ending in "Z" (e.g. 2026-05-01T10:30:00Z)',
  );
});

// ---------------------------------------------------------------------------
// Suite 2: differential test for the shared validator
// ---------------------------------------------------------------------------

async function loadBuilderValidator() {
  const src = await readFile(BUILDER_PATH, 'utf8');
  const beginIdx = src.indexOf(BEGIN_MARKER);
  const endIdx = src.indexOf(END_MARKER);
  assert.ok(
    beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx,
    `BEGIN/END markers missing from ${BUILDER_PATH}`,
  );
  // Slice between markers (exclusive of the marker lines themselves).
  const afterBegin = src.indexOf('\n', beginIdx) + 1;
  const blockEnd = src.lastIndexOf('\n', endIdx);
  let block = src.slice(afterBegin, blockEnd);
  // The build step escaped the source for inclusion inside a template
  // literal. Reverse those escapes so the snippet is real JS again.
  block = block
    .replace(/\\\$\{/g, '${')
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\');
  // Evaluate the block in a fresh function scope and return its
  // validateFields binding. The block is `const`-only, so we attach the
  // export explicitly.
  const factory = new Function(block + '\nreturn { validateFields: validateFields };');
  return factory().validateFields;
}

const VALID_CORPUS = [
  {
    name: 'minimal valid snippet',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'Alerts duplicate.',
      snippet: 'Tune the dedup window.',
      time_to_implement: '5 minutes',
    },
  },
  {
    name: 'valid with tags and code blocks',
    data: {
      schema_version: 1,
      id: '202602020202',
      created_at: '2026-02-02T02:02:00Z',
      product_module: 'Cortex XSIAM',
      module_slug: 'cortex-xsiam',
      scenario: 'Parser misclassifies events.',
      snippet: 'Add a regex normaliser.',
      time_to_implement: '20 minutes',
      tags: ['parsing', 'ingestion'],
      code_blocks: [
        { language: 'python', code: 'print("hi")' },
        { language: 'bash', code: 'echo hi' },
      ],
    },
  },
  {
    name: 'valid with empty media pair (no attachment)',
    data: {
      schema_version: 1,
      id: '202603030303',
      created_at: '2026-03-03T03:03:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'Empty media pair allowed.',
      snippet: 'Both empty strings.',
      time_to_implement: '1 minute',
      media_type: '',
      media_base64: '',
    },
  },
  {
    name: 'valid with populated media pair',
    data: {
      schema_version: 1,
      id: '202604040404',
      created_at: '2026-04-04T04:04:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'Image attached.',
      snippet: 'PNG payload.',
      time_to_implement: '1 minute',
      media_type: 'image/png',
      media_base64: 'iVBORw0KGgo=',
    },
  },
  {
    name: 'valid with supersedes pointing at a different id',
    data: {
      schema_version: 1,
      id: '202605050505',
      created_at: '2026-05-05T05:05:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'Replaces an older tip.',
      snippet: 'See newer.',
      time_to_implement: '1 minute',
      supersedes: '202504040404',
    },
  },
];

const INVALID_CORPUS = [
  {
    name: 'missing required field',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'Missing snippet field.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'unknown field',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      bogus_field: 'nope',
    },
  },
  {
    name: 'legacy renamed field',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      problem_statement: 'old name',
    },
  },
  {
    name: 'unsupported schema_version',
    data: {
      schema_version: 99,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'malformed id',
    data: {
      schema_version: 1,
      id: 'not-a-timestamp',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'created_at without Z',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00+01:00',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'invalid module_slug',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'Cortex XDR',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'tags array contains empty string',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      tags: ['ok', ''],
    },
  },
  {
    name: 'media_type without media_base64',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      media_type: 'image/png',
    },
  },
  {
    name: 'media one side empty',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      media_type: 'image/png',
      media_base64: '',
    },
  },
  {
    name: 'code_blocks too many',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      code_blocks: Array.from({ length: 9 }, () => ({ language: 'bash', code: 'true' })),
    },
  },
  {
    name: 'code_block with bad language',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      code_blocks: [{ language: 'Not A Lang', code: 'x' }],
    },
  },
  {
    name: 'product_module not in allowed list',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex CDR',
      module_slug: 'cortex-cdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'module_slug does not match product_module',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xsiam',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
    },
  },
  {
    name: 'tag not in allowed list',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      tags: ['detection', 'invented-tag'],
    },
  },
  {
    name: 'code_block language not in allowed list',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      code_blocks: [{ language: 'ruby', code: 'puts 1' }],
    },
  },
  {
    name: 'supersedes points at own id',
    data: {
      schema_version: 1,
      id: '202601010000',
      created_at: '2026-01-01T00:00:00Z',
      product_module: 'Cortex XDR',
      module_slug: 'cortex-xdr',
      scenario: 'X.',
      snippet: 'Y.',
      time_to_implement: '1 minute',
      supersedes: '202601010000',
    },
  },
];

test('builder Worker is in sync with the shared validator (--check)', (t) => {
  if (!BUILDER_PATH) {
    return t.skip('no _builder_worker.js present in this clone');
  }
  const result = spawnSync('node', [BUILD_BUILDER, '--check'], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `build-builder-worker --check failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test('node validator and builder validator agree on the corpus', async (t) => {
  if (!BUILDER_PATH) {
    return t.skip('no _builder_worker.js present in this clone');
  }
  const browserValidateFields = await loadBuilderValidator();
  const corpus = [
    ...VALID_CORPUS.map((c) => ({ ...c, expectValid: true })),
    ...INVALID_CORPUS.map((c) => ({ ...c, expectValid: false })),
  ];
  for (const { name, data, expectValid } of corpus) {
    const nodeErrs = nodeValidateFields(data);
    const browserErrs = browserValidateFields(data);
    const nodeValid = nodeErrs.length === 0;
    const browserValid = browserErrs.length === 0;
    assert.equal(
      nodeValid,
      expectValid,
      `[${name}] node verdict mismatch: expected ${expectValid}, got ${nodeValid}\n` +
        `errors: ${JSON.stringify(nodeErrs)}`,
    );
    assert.equal(
      browserValid,
      expectValid,
      `[${name}] browser verdict mismatch: expected ${expectValid}, got ${browserValid}\n` +
        `errors: ${JSON.stringify(browserErrs)}`,
    );
    assert.deepEqual(
      nodeErrs,
      browserErrs,
      `[${name}] error lists differ between node and browser validators\n` +
        `node:    ${JSON.stringify(nodeErrs)}\n` +
        `browser: ${JSON.stringify(browserErrs)}`,
    );
  }
});
