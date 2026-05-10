// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: GoCortexIO
//
// Tiny shared helpers for the test suite under scripts/test/.
//
// findRepoFile(repoRoot, filename) walks the repository looking for a
// file whose basename matches `filename`, skipping common ignored
// directories. Used by tests that need to locate optional sources
// (such as the Cloudflare Worker files) without hard-coding the
// directory those sources happen to live in. The Worker source files
// are deployed by paste-into-Cloudflare and are not guaranteed to
// ship with every clone, so the tests skip cleanly when the file is
// absent rather than failing the suite.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function findRepoFile(root, filename) {
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
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile() && e.name === filename) {
        return join(dir, e.name);
      }
    }
  }
  return null;
}
