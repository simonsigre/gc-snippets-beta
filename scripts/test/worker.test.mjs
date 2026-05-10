// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO

// End-to-end tests for the Cloudflare Worker source file
// (_worker.js). The Worker is a single-file module that calls global
// fetch against raw.githubusercontent.com and uses the global caches
// API. Both are stubbed here so the module runs unchanged under
// node:test, reading the local /generated and /snippets trees instead
// of hitting the network. Tests then drive mod.default.fetch(request,
// env, ctx) directly and assert on the returned Response.
//
// The Worker source is deploy-by-paste-into-Cloudflare and may not
// ship with every clone. The test locates _worker.js by walking the
// repo and skips the whole suite cleanly when it is not present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { findRepoFile } from './_helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const WORKER_PATH = await findRepoFile(REPO_ROOT, '_worker.js');
if (!WORKER_PATH) {
  // Worker source is not present in this clone (e.g. a public-only
  // checkout that does not include the internal Worker tree). Nothing
  // to test; exit cleanly so the suite stays runnable everywhere.
  console.log('[OK] worker tests: no _worker.js present; skipping suite');
  process.exit(0);
}

// Make sure /generated is fresh before the Worker reads from it. The
// snapshot test is upstream of this one in CI, but running locally we
// don't want a stale generated tree to mask a regression.
const gen = spawnSync('node', ['scripts/generate-indexes.mjs'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});
if (gen.status !== 0) {
  throw new Error(
    `generator failed before worker tests:\nstdout:\n${gen.stdout}\nstderr:\n${gen.stderr}`,
  );
}

// Stub global fetch to read from the local repo. The Worker only ever
// pulls from a single raw.githubusercontent.com host; anything else is a
// test-setup bug and throws so it cannot pass silently.
globalThis.fetch = async (input) => {
  const u = typeof input === 'string' ? input : input.url;
  const m = u.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
  if (!m) throw new Error(`unexpected fetch in test: ${u}`);
  try {
    const buf = await readFile(join(REPO_ROOT, m[1]));
    return new Response(buf, { status: 200 });
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Response('', { status: 404 });
    throw err;
  }
};

// Minimal cache stub. The Worker treats cache misses as "no entry" and
// the writes happen inside ctx.waitUntil so we can no-op both safely.
globalThis.caches = {
  default: {
    match: async () => undefined,
    put: async () => undefined,
  },
};

const ctx = { waitUntil: () => {} };
const mod = await import(pathToFileURL(WORKER_PATH).href);
const worker = mod.default;

async function get(path) {
  const req = new Request(`https://test.example${path}`);
  const res = await worker.fetch(req, {}, ctx);
  const body = await res.text();
  return { res, body };
}

// Discover one real snippet from the local index so detail/module/tag
// assertions are anchored to data that actually exists rather than to
// brittle hard-coded ids.
const indexJson = JSON.parse(
  await readFile(join(REPO_ROOT, 'generated', 'snippets-index.json'), 'utf8'),
);
const sampleSnippet = indexJson[0];
const sampleTag = (sampleSnippet.tags && sampleSnippet.tags[0]) || null;
const sampleModuleSlug = sampleSnippet.module_slug;

test('GET / returns 200 HTML containing the latest snippet', async () => {
  const { res, body } = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(body, /<!doctype html>/i);
  assert.ok(body.includes(sampleSnippet.module));
});

test('GET /archive returns 200 HTML listing every snippet', async () => {
  const { res, body } = await get('/archive');
  assert.equal(res.status, 200);
  assert.match(body, /<h1>Archive<\/h1>/);
  assert.ok(body.includes(`${indexJson.length} snippet`));
});

test('GET /snippet/:id returns 200 HTML for a known snippet', async () => {
  const { res, body } = await get(`/snippet/${sampleSnippet.id}`);
  assert.equal(res.status, 200);
  assert.match(body, /<h2 id="scenario"/);
  assert.match(body, /<h2 id="snippet"/);
  assert.match(body, /min read/);
});

test('GET /module/:slug returns 200 HTML for the latest snippet in that module', async () => {
  const { res, body } = await get(`/module/${sampleModuleSlug}`);
  assert.equal(res.status, 200);
  assert.match(body, /<!doctype html>/i);
});

test('GET /module/:slug appends an "Earlier in this module" timeline of older snippets linking to /snippet/:id', async () => {
  // Pick a module that has more than one snippet in the fixture corpus
  // so we can assert the timeline renders with the right contents.
  const counts = new Map();
  for (const e of indexJson) {
    counts.set(e.module_slug, (counts.get(e.module_slug) || 0) + 1);
  }
  let multiSlug = null;
  for (const [slug, n] of counts) {
    if (n > 1) { multiSlug = slug; break; }
  }
  assert.ok(multiSlug, 'fixture corpus must contain a module with >1 snippet');

  const latestFile = JSON.parse(
    await readFile(join(REPO_ROOT, 'generated', 'latest-by-module.json'), 'utf8'),
  )[multiSlug];
  const moduleEntries = indexJson.filter((e) => e.module_slug === multiSlug);
  const earlier = moduleEntries.filter((e) => e.file !== latestFile);

  const { res, body } = await get(`/module/${multiSlug}`);
  assert.equal(res.status, 200);
  assert.match(body, /Earlier in this module/);
  // Every older snippet for this module is linked by /snippet/:id.
  for (const e of earlier) {
    assert.ok(
      body.includes(`href="/snippet/${e.id}"`),
      `expected /snippet/${e.id} link for older snippet in module ${multiSlug}`,
    );
  }
  // The latest snippet itself must NOT be duplicated as a row in the
  // earlier list (it is rendered in full above).
  const latestId = moduleEntries.find((e) => e.file === latestFile).id;
  const earlierBlock = body.split('Earlier in this module')[1] || '';
  assert.ok(
    !earlierBlock.includes(`href="/snippet/${latestId}"`),
    'latest snippet must not appear in the earlier-in-module list',
  );
  // Canonical URL and og:type continue to describe the latest snippet
  // (the module page's identity is unchanged).
  assert.match(body, /<link rel="canonical" href="[^"]*\/module\/[a-z0-9-]+"/);
});

test('GET /module/:slug renders no "Earlier in this module" section when the module has only one snippet', async () => {
  const counts = new Map();
  for (const e of indexJson) {
    counts.set(e.module_slug, (counts.get(e.module_slug) || 0) + 1);
  }
  let singleSlug = null;
  for (const [slug, n] of counts) {
    if (n === 1) { singleSlug = slug; break; }
  }
  if (!singleSlug) {
    // Fabricate a single-snippet module by stubbing the index for this call.
    const realFetch = globalThis.fetch;
    const someSlug = indexJson[0].module_slug;
    globalThis.fetch = async (input) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.endsWith('generated/snippets-index.json')) {
        const only = indexJson.filter((e) => e.module_slug === someSlug).slice(0, 1);
        return new Response(JSON.stringify(only), { status: 200 });
      }
      return realFetch(input);
    };
    try {
      const { body } = await get(`/module/${someSlug}`);
      assert.ok(!body.includes('Earlier in this module'));
    } finally {
      globalThis.fetch = realFetch;
    }
    return;
  }
  const { res, body } = await get(`/module/${singleSlug}`);
  assert.equal(res.status, 200);
  assert.ok(!body.includes('Earlier in this module'));
});

test('GET /tag/:tag returns 200 HTML when the tag exists', async (t) => {
  if (!sampleTag) return t.skip('no sample tag in fixtures');
  const { res, body } = await get(`/tag/${encodeURIComponent(sampleTag)}`);
  assert.equal(res.status, 200);
  assert.match(body, new RegExp(`#${sampleTag}`));
});

test('GET /sitemap.xml returns 200 XML with a urlset', async () => {
  const { res, body } = await get('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/xml/);
  assert.match(body, /<urlset/);
  assert.ok(body.includes(`/snippet/${sampleSnippet.id}`));
});

test('GET /healthz returns 200 JSON with snippet_count', async () => {
  const { res, body } = await get('/healthz');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const data = JSON.parse(body);
  assert.equal(typeof data.snippet_count, 'number');
  assert.equal(data.snippet_count, indexJson.length);
});

test('removed search endpoints return 404 so they cannot be reintroduced silently', async () => {
  for (const path of ['/search', '/data/snippets.json', '/data/search-index.json']) {
    const { res } = await get(path);
    assert.equal(res.status, 404, `${path} should be 404 after search removal`);
  }
});

test('sitemap.xml does not list the removed /search page', async () => {
  const { body } = await get('/sitemap.xml');
  assert.ok(!body.includes('/search<'), 'sitemap must not link to /search');
});

test('GET /unknown returns 404 HTML with a recent-snippets list and a skip link', async () => {
  const { res, body } = await get('/this-page-does-not-exist');
  assert.equal(res.status, 404);
  assert.match(body, /Nothing here/);
  assert.match(body, /class="skip-link"/);
  assert.match(body, /Recent snippets/);
});

test('GET /snippet/:id returns 501 when the snippet uses an unsupported schema_version', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.endsWith(`snippets/${sampleSnippet.file}`)) {
      const buf = await readFile(join(REPO_ROOT, 'snippets', sampleSnippet.file));
      const obj = JSON.parse(buf.toString('utf8'));
      obj.schema_version = 999;
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return realFetch(input);
  };
  try {
    const { res, body } = await get(`/snippet/${sampleSnippet.id}`);
    assert.equal(res.status, 501);
    assert.match(body, /schema version\s*999/);
    assert.match(body, /temporarily unavailable/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /snippet/:id renders code_blocks after the image and before the tags with a visible language caption', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.endsWith(`snippets/${sampleSnippet.file}`)) {
      const buf = await readFile(join(REPO_ROOT, 'snippets', sampleSnippet.file));
      const obj = JSON.parse(buf.toString('utf8'));
      obj.code_blocks = [
        { language: 'python', code: 'print("hello & <world>")' },
        { language: 'bash', code: 'echo first\necho second' },
      ];
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return realFetch(input);
  };
  try {
    const { res, body } = await get(`/snippet/${sampleSnippet.id}`);
    assert.equal(res.status, 200);
    // Both languages render as visible captions, not just data-lang attrs.
    assert.match(body, /<div class="code-block-lang">python<\/div>/);
    assert.match(body, /<div class="code-block-lang">bash<\/div>/);
    // Code body is HTML-escaped.
    assert.ok(body.includes('print(&quot;hello &amp; &lt;world&gt;&quot;)'));
    // Each block carries a Copy button bound to its <code> id.
    assert.match(body, /data-target="cb-0"/);
    assert.match(body, /data-target="cb-1"/);
    // Code blocks sit after the snippet body (and image, when present)
    // and before the tags row. We check the relative ordering of two
    // distinctive substrings.
    const snippetIdx = body.indexOf('id="snippet"');
    const blockIdx = body.indexOf('class="code-block"');
    const tagsIdx = body.search(/<div class="tags"|<\/article>/);
    assert.ok(snippetIdx >= 0 && blockIdx > snippetIdx, 'code block must appear after the snippet body');
    assert.ok(tagsIdx > blockIdx, 'code block must appear before the tags / article close');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /snippet/:id auto-prepends the demo/testing disclaimer to every rendered code block, idempotently', async () => {
  const realFetch = globalThis.fetch;
  const disclaimer = '// Provided as-is for demo and testing purposes only.';
  globalThis.fetch = async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.endsWith(`snippets/${sampleSnippet.file}`)) {
      const buf = await readFile(join(REPO_ROOT, 'snippets', sampleSnippet.file));
      const obj = JSON.parse(buf.toString('utf8'));
      obj.code_blocks = [
        { language: 'python', code: 'print("no banner yet")' },
        { language: 'bash', code: `${disclaimer}\necho already disclaimed` },
      ];
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return realFetch(input);
  };
  try {
    const { body } = await get(`/snippet/${sampleSnippet.id}`);
    const escaped = disclaimer.replace(/\//g, '\\/');
    const matches = body.match(new RegExp(escaped, 'g')) || [];
    // One disclaimer per block: the python block gets one prepended,
    // the bash block already had one and must not be doubled.
    assert.equal(matches.length, 2, 'disclaimer must appear exactly once per code block');
    // Banner sits on the first line of each rendered listing.
    assert.match(body, new RegExp(`<code[^>]*id="cb-0"[^>]*>${escaped}\\nprint`));
    assert.match(body, new RegExp(`<code[^>]*id="cb-1"[^>]*>${escaped}\\necho already disclaimed`));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /snippet/:id ignores malformed code_blocks entries instead of leaking "undefined"', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.endsWith(`snippets/${sampleSnippet.file}`)) {
      const buf = await readFile(join(REPO_ROOT, 'snippets', sampleSnippet.file));
      const obj = JSON.parse(buf.toString('utf8'));
      obj.code_blocks = [
        { language: 'python', code: '' },
        { language: 'bash' },
        null,
        { language: 'json', code: '{"ok":true}' },
      ];
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return realFetch(input);
  };
  try {
    const { res, body } = await get(`/snippet/${sampleSnippet.id}`);
    assert.equal(res.status, 200);
    // No literal "undefined" should be rendered into element bodies or
    // attribute values. The inline script legitimately contains the
    // identifier `undefined` (e.g. `Intl.DateTimeFormat(undefined, ...)`)
    // so we look only at text-node and attribute-value positions.
    assert.ok(!/>undefined</.test(body), 'no ">undefined<" text node should leak into the page');
    assert.ok(!/="undefined"/.test(body), 'no ="undefined" attribute value should leak into the page');
    assert.match(body, /<div class="code-block-lang">json<\/div>/);
    assert.ok(!/<div class="code-block-lang">python<\/div>/.test(body), 'empty-code python block must be filtered out');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('every rendered shell starts with a skip link as the first focusable element', async () => {
  for (const path of ['/', '/archive', `/snippet/${sampleSnippet.id}`]) {
    const { body } = await get(path);
    assert.match(
      body,
      /<body>\s*<a class="skip-link" href="#content">/,
      `skip link missing on ${path}`,
    );
  }
});
