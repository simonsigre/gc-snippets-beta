#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Snippet scaffolder. Computes the next valid filename from the current UTC
// time, accepts a small set of CLI flags to prefill the JSON skeleton, and
// writes the file under /snippets. Refuses to overwrite an existing file.
//
// Usage:
//   node scripts/new-snippet.mjs \
//     --module="Cortex XDR" \
//     --tags=parsing,cloud \
//     --scenario="One sentence describing the situation."
//
// Recognised flags (all optional; unspecified fields are written as empty
// placeholders the author fills in by hand):
//   --module=...        Product module name (e.g. "Cortex XDR")
//   --slug=...          Module slug; auto-derived from --module if omitted
//   --scenario=...      Scenario one-liner
//   --snippet=...       Snippet body
//   --tags=a,b,c        Comma-separated tag list
//   --time=...          time_to_implement (e.g. "5 minutes")
//
// Exits 0 with a grepable [OK] line on success, non-zero on any error.

import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SNIPPETS_DIR = join(REPO_ROOT, 'snippets');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z_-]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] == null ? '' : m[2];
  }
  return out;
}

// Slugify a free-form module name into the kebab-case form the schema
// requires (lowercase, hyphen-separated). "Cortex XDR" -> "cortex-xdr".
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pad(n) { return String(n).padStart(2, '0'); }

// Twelve-digit UTC timestamp matching the FILENAME_PATTERN enforced by the
// generator: YYYYMMDDHHMM. Always taken from the current wall clock; no
// override flag, because backdating snippets defeats the purpose of the
// chronological filename ordering.
function nowStamp() {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}

function nowIso() {
  // Drop fractional seconds; the schema accepts them but plain seconds is
  // more readable in the source file.
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const moduleName = args.module || '';
  const slug = args.slug || (moduleName ? slugify(moduleName) : '');
  const tags = args.tags
    ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const stamp = nowStamp();
  const filename = `${stamp}_GoCortexSnippet.json`;
  const target = join(SNIPPETS_DIR, filename);

  await mkdir(SNIPPETS_DIR, { recursive: true });
  if (await exists(target)) {
    console.error(`[ERROR] Scaffold: ${filename} already exists; refusing to overwrite`);
    process.exit(1);
  }

  // Field order is alphabetical to match the stable JSON output the
  // generator produces, so a freshly scaffolded snippet diffs cleanly
  // against any later edits made through the generator's round-trip.
  const skeleton = {
    created_at: nowIso(),
    id: stamp,
    media_base64: '',
    media_type: '',
    module_slug: slug,
    product_module: moduleName,
    scenario: args.scenario || '',
    schema_version: 1,
    snippet: args.snippet || '',
    tags,
    time_to_implement: args.time || '',
  };

  await writeFile(target, JSON.stringify(skeleton, null, 2) + '\n');
  console.log(`[OK] Scaffold: wrote snippets/${filename}`);
}

main().catch((err) => {
  console.error(`[ERROR] Scaffold: ${err.stack || err.message || String(err)}`);
  process.exit(1);
});
