#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Validate every snippet under /snippets and regenerate the lightweight index
// files under /generated. Pure Node stdlib, zero runtime dependencies.
//
// Output is grepable. Each line intended for CI consumption begins with one
// of [OK], [INFO], [PASS], [FAIL], [ERROR] followed by a subject and detail.
// The full convention lives alongside the Worker source.
//
// Exit codes:
//   0  validation passed and indexes were written
//   1  one or more snippets failed validation, or an unexpected error occurred

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ID_PATTERN,
  validateFields,
} from './validate-snippet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SNIPPETS_DIR = join(REPO_ROOT, 'snippets');
const GENERATED_DIR = join(REPO_ROOT, 'generated');
const README_PATH = join(REPO_ROOT, 'README.md');
const SCHEMA_PATH = join(HERE, 'snippet.schema.json');

// Public site URL used to build absolute <link> elements in the RSS feed.
// Override via the SITE_URL environment variable in CI so the feed always
// points at the production Worker domain. Trailing slashes are stripped so we
// can safely append paths.
const SITE_URL = (process.env.SITE_URL || 'https://snippets.gocortex.io').replace(/\/+$/, '');
const FEED_TITLE = 'GoCortexIO Snippets';
const FEED_DESCRIPTION = 'Short, actionable Cortex tips, published as they ship.';

const FILENAME_PATTERN = /^(\d{12})_GoCortexSnippet\.json$/;

/**
 * Validate a single snippet object. Per-field rules live in the shared
 * scripts/validate-snippet.mjs module so the browser builder Worker
 * and this generator cannot drift apart. The generator layers on
 * filename-pattern and id-vs-filename
 * checks, which are not meaningful to the browser builder (it produces
 * the filename itself from the id and only ever sees one snippet at a
 * time). Cross-snippet supersedes/superseded_by reciprocity is checked
 * separately in main() because it requires the full corpus.
 */
function validateSnippet(filename, data) {
  const errors = [];
  const match = filename.match(FILENAME_PATTERN);
  if (!match) {
    errors.push(`filename does not match YYYYMMDDHHMM_GoCortexSnippet.json`);
    return errors;
  }
  const filenameId = match[1];

  errors.push(...validateFields(data));

  if (
    data && typeof data === 'object' && !Array.isArray(data) &&
    typeof data.id === 'string' && ID_PATTERN.test(data.id) &&
    data.id !== filenameId
  ) {
    errors.push(`"id" (${data.id}) does not match filename timestamp (${filenameId})`);
  }

  return errors;
}

/** Stable JSON: sorted object keys, two-space indent, trailing newline. */
function stableStringify(value) {
  const sorted = sortKeys(value);
  return JSON.stringify(sorted, null, 2) + '\n';
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Escape the five XML special characters for use inside element text. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert an ISO-8601 UTC timestamp to RFC-822 (RSS pubDate format).
 *
 * `toUTCString()` ends with the literal "GMT". RFC-822 accepts both "GMT"
 * and "+0000", but the latter spells out the zero offset (Zulu) explicitly
 * and is universally accepted by RSS readers, so we emit that form.
 */
function toRfc822(iso) {
  return new Date(iso).toUTCString().replace(/ GMT$/, ' +0000');
}

/**
 * Build an RSS 2.0 document from a (already sorted, newest-first) snippet
 * list. Each item links to /module/<slug> on the public site, includes the
 * scenario and the snippet body as the description, and uses the snippet
 * id as a stable non-permalink GUID so feed readers can dedupe correctly.
 *
 * Optional opts:
 *   title       channel title; defaults to the site-wide FEED_TITLE.
 *   description channel description; defaults to FEED_DESCRIPTION.
 *   selfPath    path of the feed itself, relative to SITE_URL; used for
 *               the <atom:link rel="self"> element. Defaults to /rss.xml.
 */
function buildRssXml(snippets, opts) {
  opts = opts || {};
  const title = opts.title || FEED_TITLE;
  const description = opts.description || FEED_DESCRIPTION;
  const selfPath = opts.selfPath || '/rss.xml';
  const lastBuildDate = toRfc822(snippets[0]?.data.created_at ?? new Date().toISOString());
  const channelLink = `${SITE_URL}/`;
  const feedSelfLink = `${SITE_URL}${selfPath}`;

  const items = snippets
    .map(({ data }) => {
      const itemLink = `${SITE_URL}/module/${data.module_slug}`;
      const title = `[${data.product_module}] ${data.scenario}`;
      const description = `${data.scenario}\n\n${data.snippet}`;
      return [
        '    <item>',
        `      <title>${xmlEscape(title)}</title>`,
        `      <link>${xmlEscape(itemLink)}</link>`,
        `      <guid isPermaLink="false">gocortex-snippet-${xmlEscape(data.id)}</guid>`,
        `      <pubDate>${xmlEscape(toRfc822(data.created_at))}</pubDate>`,
        `      <category>${xmlEscape(data.product_module)}</category>`,
        `      <description>${xmlEscape(description)}</description>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(title)}</title>`,
    `    <link>${xmlEscape(channelLink)}</link>`,
    `    <description>${xmlEscape(description)}</description>`,
    '    <language>en-us</language>',
    `    <lastBuildDate>${xmlEscape(lastBuildDate)}</lastBuildDate>`,
    `    <atom:link href="${xmlEscape(feedSelfLink)}" rel="self" type="application/rss+xml" />`,
  ];
  if (items) lines.push(items);
  lines.push('  </channel>', '</rss>');
  return lines.join('\n') + '\n';
}

/** Escape a single value for safe inclusion inside a Markdown table cell. */
function mdCellEscape(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

// Maximum number of snippet rows shown in the README table. The live site's
// Archive page shows the full history; the README is a landing page on
// GitHub and is capped so it stays a quick scan rather than a long scroll
// as the snippet count grows.
const README_MAX_ROWS = 10;

/**
 * Build the auto-generated README.md from the (already sorted, newest-first)
 * snippet list. Only the most recent README_MAX_ROWS rows are shown, with
 * the scenario printed in full because the GitHub table renders at full
 * width.
 *
 * The leading HTML comment block carries the SPDX header pair and warns
 * against hand-edits, since the generator will overwrite this file on every
 * push.
 */
function buildReadmeMarkdown(snippets) {
  const visible = snippets.slice(0, README_MAX_ROWS);
  const rows = visible.map(({ filename, data }) => {
    const stamp = data.created_at.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC');
    return `| [${mdCellEscape(stamp)}](snippets/${mdCellEscape(filename)}) | ${mdCellEscape(data.product_module)} | ${mdCellEscape(data.scenario)} |`;
  });
  const shown = visible.length;
  const countLine = shown === 0
    ? 'No snippets published yet.'
    : `${shown} snippet${shown === 1 ? '' : 's'} published. Newest first.`;
  const table = shown === 0
    ? ''
    : [
        '',
        '| Published (UTC) | Module | Scenario |',
        '| --- | --- | --- |',
        ...rows,
        '',
      ].join('\n');
  const lines = [
    '<!--',
    'SPDX-License-Identifier: AGPL-3.0-or-later',
    'SPDX-FileCopyrightText: GoCortexIO',
    '',
    'This file is generated by scripts/generate-indexes.mjs from the contents',
    'of /snippets and is rewritten on every push by the GitHub Action. Do not',
    'edit by hand: any manual change is overwritten on the next CI run. To',
    'change the structure of this page, edit the generator.',
    '-->',
    '',
    '# GoCortex Snippets',
    '',
    countLine,
    table,
    '## Licence',
    '',
    '[GNU Affero General Public License v3.0 or later](LICENSE).',
    '',
  ];
  return lines.join('\n');
}

// CLI flag handling. --check runs validation only and exits without
// writing any output, so the pre-commit hook can use the same script as
// the CI generator without dirtying the worktree.
const CHECK_ONLY = process.argv.includes('--check');

// Resolve the timestamp that will be baked into generated/status.json.
// Honours the SOURCE_DATE_EPOCH convention used by reproducible-builds
// tooling so the snapshot test can pin the value for byte-stable output.
function resolveGeneratedAt() {
  const sde = process.env.SOURCE_DATE_EPOCH;
  if (sde && /^\d+$/.test(sde)) {
    return new Date(parseInt(sde, 10) * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function main() {
  // Schema is loaded for documentation/error messages only; validation is
  // performed inline above to keep the script dependency-free.
  await readFile(SCHEMA_PATH, 'utf8');

  let entries;
  try {
    entries = await readdir(SNIPPETS_DIR);
  } catch (err) {
    console.error(`[ERROR] Snippets directory: cannot read ${SNIPPETS_DIR}: ${err.message}`);
    process.exit(1);
  }

  const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();
  const failures = [];
  const snippets = [];

  for (const filename of jsonFiles) {
    const filePath = join(SNIPPETS_DIR, filename);
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      failures.push({ filename, errors: [`unable to read file: ${err.message}`] });
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      failures.push({ filename, errors: [`invalid JSON: ${err.message}`] });
      continue;
    }
    const errors = validateSnippet(filename, data);
    if (errors.length > 0) {
      failures.push({ filename, errors });
      continue;
    }
    snippets.push({ filename, data });
  }

  // Cross-snippet relationship check. supersedes/superseded_by must
  // resolve to a known snippet, and the relationship must be mutual:
  // if A.supersedes = B then B.superseded_by must equal A.id, and the
  // mirror direction likewise. Catching this here keeps the rendered
  // pages honest - a one-sided pointer would leave the partner snippet
  // silently un-flagged in the UI.
  const byId = new Map(snippets.map((s) => [s.data.id, s]));
  for (const { filename, data } of snippets) {
    const localErrors = [];
    if (typeof data.supersedes === 'string') {
      const target = byId.get(data.supersedes);
      if (!target) {
        localErrors.push(`"supersedes" points at unknown snippet id "${data.supersedes}"`);
      } else if (target.data.superseded_by !== data.id) {
        localErrors.push(
          `"supersedes" points at "${data.supersedes}", but that snippet's "superseded_by" is ` +
            `"${target.data.superseded_by ?? 'missing'}" (expected "${data.id}")`,
        );
      }
    }
    if (typeof data.superseded_by === 'string') {
      const target = byId.get(data.superseded_by);
      if (!target) {
        localErrors.push(`"superseded_by" points at unknown snippet id "${data.superseded_by}"`);
      } else if (target.data.supersedes !== data.id) {
        localErrors.push(
          `"superseded_by" points at "${data.superseded_by}", but that snippet's "supersedes" is ` +
            `"${target.data.supersedes ?? 'missing'}" (expected "${data.id}")`,
        );
      }
    }
    if (localErrors.length > 0) failures.push({ filename, errors: localErrors });
  }

  if (failures.length > 0) {
    for (const { filename, errors } of failures) {
      for (const err of errors) {
        console.error(`[FAIL] ${filename}: ${err}`);
      }
    }
    console.error(`[ERROR] Validation: ${failures.length} snippet(s) rejected`);
    process.exit(1);
  }
  console.log(`[PASS] Validation: ${snippets.length} snippet(s) accepted`);

  if (CHECK_ONLY) {
    console.log('[OK] Check: validation only, no files written');
    return;
  }

  // Sort chronologically descending by created_at, then by filename for stability.
  snippets.sort((a, b) => {
    const ta = Date.parse(a.data.created_at);
    const tb = Date.parse(b.data.created_at);
    if (tb !== ta) return tb - ta;
    return a.filename.localeCompare(b.filename);
  });

  const latest = snippets[0];
  const latestByModule = {};
  for (const { filename, data } of snippets) {
    if (!(data.module_slug in latestByModule)) {
      latestByModule[data.module_slug] = filename;
    }
  }

  // The full scenario text and the tags travel on every index entry so
  // renderers downstream (the Worker's archive page, the on-site search
  // page, future feed widgets) can filter and excerpt without a second
  // fetch. Tags are normalised to an array even when the snippet omits
  // them so consumers never have to handle `undefined`.
  const index = snippets.map(({ filename, data }) => ({
    id: data.id,
    module: data.product_module,
    module_slug: data.module_slug,
    file: filename,
    created_at: data.created_at,
    scenario: data.scenario,
    tags: Array.isArray(data.tags) ? [...data.tags] : [],
  }));

  // Tags index: each tag maps to the chronological (newest-first) list of
  // snippet filenames that carry it. Snippets are already sorted that way,
  // so we just append in order. Tags themselves are written with sorted keys
  // by stableStringify so diffs stay deterministic.
  const tagsIndex = {};
  for (const { filename, data } of snippets) {
    if (!Array.isArray(data.tags)) continue;
    for (const tag of data.tags) {
      if (!tagsIndex[tag]) tagsIndex[tag] = [];
      tagsIndex[tag].push(filename);
    }
  }

  // Group snippets by module and by tag so per-slice RSS feeds can be
  // emitted alongside the site-wide feed. Both groupings preserve the
  // newest-first ordering of the parent list, since we walk it in order.
  const snippetsByModule = new Map();
  const snippetsByTag = new Map();
  for (const s of snippets) {
    const slug = s.data.module_slug;
    if (!snippetsByModule.has(slug)) snippetsByModule.set(slug, []);
    snippetsByModule.get(slug).push(s);
    if (Array.isArray(s.data.tags)) {
      for (const tag of s.data.tags) {
        if (!snippetsByTag.has(tag)) snippetsByTag.set(tag, []);
        snippetsByTag.get(tag).push(s);
      }
    }
  }

  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(
    join(GENERATED_DIR, 'latest.json'),
    stableStringify(latest ? { latest: latest.filename } : { latest: null }),
  );
  await writeFile(
    join(GENERATED_DIR, 'latest-by-module.json'),
    stableStringify(latestByModule),
  );
  await writeFile(
    join(GENERATED_DIR, 'snippets-index.json'),
    stableStringify(index),
  );
  await writeFile(
    join(GENERATED_DIR, 'rss.xml'),
    buildRssXml(snippets),
  );
  await writeFile(
    join(GENERATED_DIR, 'tags-index.json'),
    stableStringify(tagsIndex),
  );

  // The per-slice feed directories are recreated from scratch on every
  // run so a renamed module or removed tag stops serving its old feed.
  // CI commits the regenerated tree as a whole, so deletions surface in
  // git as expected.
  await rm(join(GENERATED_DIR, 'rss'), { recursive: true, force: true });

  // Per-module RSS feeds. Filename matches the module_slug; the Worker
  // serves it at /module/<slug>.rss. Sorted iteration keeps directory
  // listings stable across runs.
  const moduleRssDir = join(GENERATED_DIR, 'rss', 'module');
  await mkdir(moduleRssDir, { recursive: true });
  for (const slug of Array.from(snippetsByModule.keys()).sort()) {
    const list = snippetsByModule.get(slug);
    const moduleName = list[0].data.product_module;
    await writeFile(
      join(moduleRssDir, `${slug}.xml`),
      buildRssXml(list, {
        title: `${FEED_TITLE} - ${moduleName}`,
        description: `${FEED_DESCRIPTION} (${moduleName} only.)`,
        selfPath: `/module/${slug}.rss`,
      }),
    );
  }

  // Per-tag RSS feeds. Tag names are free-form strings, so the filename
  // is the URL-encoded tag to keep it filesystem-safe across the full
  // ASCII range. The Worker serves these at /tag/<encoded-tag>.rss.
  const tagRssDir = join(GENERATED_DIR, 'rss', 'tag');
  await mkdir(tagRssDir, { recursive: true });
  for (const tag of Array.from(snippetsByTag.keys()).sort()) {
    const list = snippetsByTag.get(tag);
    await writeFile(
      join(tagRssDir, `${encodeURIComponent(tag)}.xml`),
      buildRssXml(list, {
        title: `${FEED_TITLE} - #${tag}`,
        description: `${FEED_DESCRIPTION} (Tagged "${tag}".)`,
        selfPath: `/tag/${encodeURIComponent(tag)}.rss`,
      }),
    );
  }

  // Small status document consumed by the Worker's /healthz endpoint.
  // generated_at honours SOURCE_DATE_EPOCH for reproducible builds; in
  // CI it is the wall-clock UTC time of the run.
  await writeFile(
    join(GENERATED_DIR, 'status.json'),
    stableStringify({
      generated_at: resolveGeneratedAt(),
      latest_created_at: latest ? latest.data.created_at : null,
      latest_id: latest ? latest.data.id : null,
      snippet_count: snippets.length,
    }),
  );

  await writeFile(README_PATH, buildReadmeMarkdown(snippets));

  const moduleFeeds = snippetsByModule.size;
  const tagFeeds = snippetsByTag.size;
  console.log(`[INFO] Output: ${GENERATED_DIR}`);
  console.log(`[INFO] Readme: ${README_PATH}`);
  console.log(
    `[OK] Indexes: wrote 7 core file(s) (latest, latest-by-module, snippets-index, tags-index, rss, status, README.md) plus ${moduleFeeds} module feed(s) and ${tagFeeds} tag feed(s)`,
  );
}

main().catch((err) => {
  console.error(`[ERROR] Generator: ${err.stack || err.message || String(err)}`);
  process.exit(1);
});
