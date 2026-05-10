#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Post-merge setup hook. This project has zero third-party dependencies
# (no package.json, no lockfile, no native build), so there is nothing
# to install or migrate after a task merge. Validation and tests run in
# the GitHub Actions workflow, not here.
#
# Kept as an explicit no-op so the platform's post-merge hook succeeds
# instead of erroring on a missing script.
set -e
echo "[OK] post-merge: nothing to do (zero-dep repository)"
