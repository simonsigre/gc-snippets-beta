// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Single source of truth for per-field snippet validation rules.
//
// This module is consumed by two completely different runtimes:
//
//   1. The generator (scripts/generate-indexes.mjs) imports it directly
//      under Node 24. The generator wraps validateFields() with a
//      filename-pattern check, an id-vs-filename consistency check, and
//      a cross-snippet supersedes/superseded_by reciprocity check; those
//      live in the generator because they are not meaningful to the
//      browser builder, which knows about exactly one snippet at a time
//      and produces the filename itself from the id.
//
//   2. The browser snippet builder Worker inlines the source of this
//      module verbatim into the HTML it serves so the page can run the
//      same validateFields() in the browser, with no network round-trip.
//      The inlining is performed by scripts/build-builder-worker.mjs.
//      Both the pre-commit hook and CI run that script in --check mode
//      so a generator-side rule change without a matching builder
//      regeneration fails the commit, not production.
//
// Hard constraints, intentionally enforced by code review rather than a
// linter:
//
//   - Pure JavaScript. No imports of any kind, including from `node:`.
//     The browser builder runs this file's source in V8 with no module
//     resolver.
//   - No template literals containing ${...}, no backtick strings. The
//     build step embeds the source inside a backtick-delimited string in
//     the builder Worker; backslashes and backticks are escaped, but
//     keeping the source free of those constructs avoids future
//     accidents.
//   - ASCII only.
//   - Side-effect free at import time.

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ID_PATTERN = /^\d{12}$/;
// Strict ISO-8601 UTC: YYYY-MM-DDTHH:MM:SS(.fff)?Z. Offsets like "+01:00"
// are deliberately rejected so every snippet is anchored to UTC, matching
// the brief and the filename convention.
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const MEDIA_TYPE_PATTERN = /^[a-z]+\/[a-zA-Z0-9.+-]+$/;
// Short language identifier. Accepts the names in common use (python,
// bash, yaml, json, xql, c++) and rejects anything that looks like a
// path or a sentence.
export const CODE_BLOCK_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+-]{0,15}$/;

// Bounds for the optional code_blocks array. The maximum count keeps a
// single snippet detail page scannable; the per-listing length cap stops
// a single tip from inflating any one snippet's payload.
export const CODE_BLOCK_MAX_ITEMS = 8;
export const CODE_BLOCK_MAX_CODE_LENGTH = 16384;

// Bounds for top-level text fields and media. These caps prevent a
// single oversized snippet from bloating generated indexes, feeds, and
// rendered detail pages to resource-exhaustion levels.
export const SCENARIO_MAX_LENGTH = 2000;
export const SNIPPET_MAX_LENGTH = 10000;
export const TIME_TO_IMPLEMENT_MAX_LENGTH = 100;
// 1 048 576 base64 characters corresponds to roughly 768 KB of binary
// payload, which comfortably covers realistic screenshot embeds.
export const MEDIA_BASE64_MAX_LENGTH = 1048576;
// Tags are a closed enum so maxItems equals the allowed-list length.
export const TAGS_MAX_ITEMS = 15;

export const REQUIRED_FIELDS = [
  'schema_version',
  'id',
  'created_at',
  'product_module',
  'module_slug',
  'scenario',
  'snippet',
  'time_to_implement',
];

export const OPTIONAL_FIELDS = [
  'tags',
  'media_type',
  'media_base64',
  'supersedes',
  'superseded_by',
  'code_blocks',
];

export const CODE_BLOCK_FIELDS = ['language', 'code'];

// Schema versions this generator and the builder both know how to
// render. Advance the set when (and only when) every consumer has
// learned the new shape; the validator refuses any snippet declaring a
// version not listed here so a stray future-version snippet cannot
// silently break older tooling.
export const SUPPORTED_SCHEMA_VERSIONS = [1];

// Field names that used to exist in the schema and were renamed. When
// one of these turns up on a snippet (typically because someone copied
// an older file as a template) the validator emits a targeted hint
// instead of the generic "unknown field" line, so the fix is obvious
// from the CI log or the builder error panel.
export const LEGACY_FIELD_RENAMES = {
  problem_statement: 'scenario',
  solution: 'snippet',
};

// Closed enums shared with the browser builder Worker. The builder
// inlines this module verbatim, so populating its <select> and checkbox
// widgets from these constants and validating against them in CI gives
// us a single source of truth: a value is acceptable on the site iff
// the builder offered it. Extending any list is a one-line code change
// here followed by `node scripts/build-builder-worker.mjs`.
export const ALLOWED_MODULES = [
  { product_module: 'Cortex XSIAM', module_slug: 'cortex-xsiam' },
  { product_module: 'Cortex XDR', module_slug: 'cortex-xdr' },
  { product_module: 'Cortex XSOAR', module_slug: 'cortex-xsoar' },
];

export const ALLOWED_TAGS = [
  'agent',
  'alerts',
  'asset-inventory',
  'authentication',
  'deduplication',
  'detection',
  'enrichment',
  'ingestion',
  'multi-tenant',
  'parsing',
  'phishing',
  'playbook',
  'reporting',
  'tuning',
  'xql',
];

export const ALLOWED_LANGUAGES = ['bash', 'python', 'powershell', 'xql'];

/**
 * Per-field validation. Returns an array of error strings (empty means
 * valid). Performs no I/O and knows nothing about filenames or other
 * snippets in the corpus; the generator layers those checks on top.
 */
export function validateFields(data) {
  var errors = [];
  var allFields = {};
  var i;
  for (i = 0; i < REQUIRED_FIELDS.length; i++) allFields[REQUIRED_FIELDS[i]] = true;
  for (i = 0; i < OPTIONAL_FIELDS.length; i++) allFields[OPTIONAL_FIELDS[i]] = true;

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push('top-level value must be a JSON object');
    return errors;
  }

  for (i = 0; i < REQUIRED_FIELDS.length; i++) {
    var key = REQUIRED_FIELDS[i];
    if (!(key in data)) {
      errors.push('missing required field "' + key + '"');
    }
  }

  var dataKeys = Object.keys(data);
  for (i = 0; i < dataKeys.length; i++) {
    var k = dataKeys[i];
    if (!allFields[k]) {
      if (Object.prototype.hasOwnProperty.call(LEGACY_FIELD_RENAMES, k)) {
        errors.push(
          'legacy field "' + k + '" found; rename it to "' + LEGACY_FIELD_RENAMES[k] +
          '" (the field was renamed in the snippet schema)',
        );
      } else {
        errors.push('unknown field "' + k + '"');
      }
    }
  }

  if ('schema_version' in data) {
    if (typeof data.schema_version !== 'number' || !Number.isInteger(data.schema_version)) {
      errors.push('"schema_version" must be an integer');
    } else if (SUPPORTED_SCHEMA_VERSIONS.indexOf(data.schema_version) === -1) {
      var known = SUPPORTED_SCHEMA_VERSIONS.slice().sort(function (a, b) { return a - b; }).join(', ');
      errors.push(
        '"schema_version" ' + data.schema_version +
        ' is not recognised by this validator (supported: ' + known + ')',
      );
    }
  }

  var pointerKeys = ['supersedes', 'superseded_by'];
  for (i = 0; i < pointerKeys.length; i++) {
    var pk = pointerKeys[i];
    if (pk in data) {
      if (typeof data[pk] !== 'string' || !ID_PATTERN.test(data[pk])) {
        errors.push('"' + pk + '" must be a twelve-digit snippet id');
      } else if (typeof data.id === 'string' && data[pk] === data.id) {
        errors.push('"' + pk + '" cannot point at the snippet\'s own id');
      }
    }
  }

  if ('id' in data) {
    if (typeof data.id !== 'string') {
      errors.push('"id" must be a string');
    } else if (!ID_PATTERN.test(data.id)) {
      errors.push('"id" must be a twelve-digit string');
    }
  }

  if ('created_at' in data) {
    if (typeof data.created_at !== 'string') {
      errors.push('"created_at" must be a string');
    } else if (!ISO_UTC_PATTERN.test(data.created_at) || isNaN(Date.parse(data.created_at))) {
      errors.push(
        '"created_at" must be an ISO-8601 UTC timestamp ending in "Z" (e.g. 2026-05-01T10:30:00Z)',
      );
    }
  }

  var stringFields = ['product_module', 'scenario', 'snippet', 'time_to_implement'];
  for (i = 0; i < stringFields.length; i++) {
    var sf = stringFields[i];
    if (sf in data && (typeof data[sf] !== 'string' || data[sf].length === 0)) {
      errors.push('"' + sf + '" must be a non-empty string');
    }
  }

  if ('scenario' in data && typeof data.scenario === 'string' && data.scenario.length > SCENARIO_MAX_LENGTH) {
    errors.push(
      '"scenario" is ' + data.scenario.length +
      ' characters (limit ' + SCENARIO_MAX_LENGTH + ')',
    );
  }
  if ('snippet' in data && typeof data.snippet === 'string' && data.snippet.length > SNIPPET_MAX_LENGTH) {
    errors.push(
      '"snippet" is ' + data.snippet.length +
      ' characters (limit ' + SNIPPET_MAX_LENGTH + ')',
    );
  }
  if (
    'time_to_implement' in data &&
    typeof data.time_to_implement === 'string' &&
    data.time_to_implement.length > TIME_TO_IMPLEMENT_MAX_LENGTH
  ) {
    errors.push(
      '"time_to_implement" is ' + data.time_to_implement.length +
      ' characters (limit ' + TIME_TO_IMPLEMENT_MAX_LENGTH + ')',
    );
  }

  if ('module_slug' in data) {
    if (typeof data.module_slug !== 'string' || !SLUG_PATTERN.test(data.module_slug)) {
      errors.push('"module_slug" must be lowercase, hyphenated (e.g. "cortex-xdr")');
    }
  }

  if ('tags' in data) {
    var tagsOk = Array.isArray(data.tags);
    if (tagsOk) {
      for (i = 0; i < data.tags.length; i++) {
        if (typeof data.tags[i] !== 'string' || data.tags[i].length === 0) {
          tagsOk = false;
          break;
        }
      }
    }
    if (!tagsOk) {
      errors.push('"tags" must be an array of non-empty strings');
    } else if (data.tags.length > TAGS_MAX_ITEMS) {
      errors.push(
        '"tags" may contain at most ' + TAGS_MAX_ITEMS +
        ' entries (got ' + data.tags.length + ')',
      );
    }
  }

  if ('media_type' in data) {
    if (
      typeof data.media_type !== 'string' ||
      (data.media_type !== '' && !MEDIA_TYPE_PATTERN.test(data.media_type))
    ) {
      errors.push('"media_type" must be empty or look like "image/png"');
    }
  }

  if ('media_base64' in data) {
    if (typeof data.media_base64 !== 'string') {
      errors.push('"media_base64" must be a string');
    } else if (data.media_base64.length > MEDIA_BASE64_MAX_LENGTH) {
      errors.push(
        '"media_base64" is ' + data.media_base64.length +
        ' characters (limit ' + MEDIA_BASE64_MAX_LENGTH + ')',
      );
    }
  }

  if ('code_blocks' in data) {
    if (!Array.isArray(data.code_blocks)) {
      errors.push('"code_blocks" must be an array');
    } else if (data.code_blocks.length > CODE_BLOCK_MAX_ITEMS) {
      errors.push(
        '"code_blocks" may contain at most ' + CODE_BLOCK_MAX_ITEMS +
        ' entries (got ' + data.code_blocks.length + ')',
      );
    } else {
      var allowedBlockFields = {};
      for (i = 0; i < CODE_BLOCK_FIELDS.length; i++) allowedBlockFields[CODE_BLOCK_FIELDS[i]] = true;
      for (i = 0; i < data.code_blocks.length; i++) {
        var block = data.code_blocks[i];
        var here = '"code_blocks[' + i + ']"';
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          errors.push(here + ' must be an object with "language" and "code"');
          continue;
        }
        var blockKeys = Object.keys(block);
        for (var j = 0; j < blockKeys.length; j++) {
          if (!allowedBlockFields[blockKeys[j]]) {
            errors.push(here + ' has unknown field "' + blockKeys[j] + '"');
          }
        }
        if (typeof block.language !== 'string' || !CODE_BLOCK_LANGUAGE_PATTERN.test(block.language)) {
          errors.push(
            here + '.language must be a short identifier (lowercase a-z, 0-9, "+", "-", up to 16 characters)',
          );
        }
        if (typeof block.code !== 'string' || block.code.length === 0) {
          errors.push(here + '.code must be a non-empty string');
        } else if (block.code.length > CODE_BLOCK_MAX_CODE_LENGTH) {
          errors.push(
            here + '.code is ' + block.code.length +
            ' characters (limit ' + CODE_BLOCK_MAX_CODE_LENGTH + ')',
          );
        }
      }
    }
  }

  if (
    'product_module' in data &&
    typeof data.product_module === 'string' &&
    data.product_module.length > 0
  ) {
    var moduleLabels = ALLOWED_MODULES.map(function (m) { return m.product_module; });
    if (moduleLabels.indexOf(data.product_module) === -1) {
      errors.push(
        '"product_module" "' + data.product_module +
        '" is not in the allowed list (' + moduleLabels.join(', ') + ')',
      );
    } else if (
      'module_slug' in data &&
      typeof data.module_slug === 'string' &&
      SLUG_PATTERN.test(data.module_slug)
    ) {
      var expectedSlug = '';
      for (i = 0; i < ALLOWED_MODULES.length; i++) {
        if (ALLOWED_MODULES[i].product_module === data.product_module) {
          expectedSlug = ALLOWED_MODULES[i].module_slug;
          break;
        }
      }
      if (expectedSlug && data.module_slug !== expectedSlug) {
        errors.push(
          '"module_slug" "' + data.module_slug +
          '" does not match "product_module" "' + data.product_module +
          '" (expected "' + expectedSlug + '")',
        );
      }
    }
  }

  if ('tags' in data && Array.isArray(data.tags)) {
    for (i = 0; i < data.tags.length; i++) {
      var tagValue = data.tags[i];
      if (
        typeof tagValue === 'string' &&
        tagValue.length > 0 &&
        ALLOWED_TAGS.indexOf(tagValue) === -1
      ) {
        errors.push(
          '"tags[' + i + ']" "' + tagValue +
          '" is not in the allowed list (' + ALLOWED_TAGS.join(', ') + ')',
        );
      }
    }
  }

  if ('code_blocks' in data && Array.isArray(data.code_blocks)) {
    for (i = 0; i < data.code_blocks.length; i++) {
      var cb = data.code_blocks[i];
      if (
        cb && typeof cb === 'object' && !Array.isArray(cb) &&
        typeof cb.language === 'string' &&
        CODE_BLOCK_LANGUAGE_PATTERN.test(cb.language) &&
        ALLOWED_LANGUAGES.indexOf(cb.language) === -1
      ) {
        errors.push(
          '"code_blocks[' + i + ']".language "' + cb.language +
          '" is not in the allowed list (' + ALLOWED_LANGUAGES.join(', ') + ')',
        );
      }
    }
  }

  if (('media_base64' in data) !== ('media_type' in data)) {
    errors.push('"media_type" and "media_base64" must be supplied together');
  } else if (
    'media_type' in data &&
    typeof data.media_type === 'string' &&
    typeof data.media_base64 === 'string'
  ) {
    var typeEmpty = data.media_type === '';
    var dataEmpty = data.media_base64 === '';
    if (typeEmpty !== dataEmpty) {
      errors.push('"media_type" and "media_base64" must both be empty or both be populated');
    }
  }

  return errors;
}
