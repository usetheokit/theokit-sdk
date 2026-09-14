#!/usr/bin/env node
/**
 * Print the repo-relative directory of every publishable package, one per line.
 *
 * Exists for `.github/workflows/preview.yml`, which needs that list as argv for
 * `pkg-pr-new publish`. Globbing `./packages/*` instead would hand the tool the three
 * private packages as well, and what it does with those is not documented — so the list
 * is derived from the `private` flag rather than bet on.
 *
 * The enumeration itself is NOT reimplemented here: `publishablePackages()` already
 * answers exactly this question for the workspace-protocol guard, and a second copy would
 * be a second definition of "publishable" free to drift from the one the release path
 * uses. This file converts that answer to relative paths and prints it.
 */
import { relative } from "node:path";

import { publishablePackages } from "./check-publish-no-workspace.mjs";

const dirs = publishablePackages();

// An empty set means the enumeration broke, not that there is nothing to publish: this
// repository ships twelve packages. Reporting it as success would let a preview run go
// green having previewed nothing, which is the failure shape a caller cannot see.
if (dirs.length === 0) {
  console.error(
    "no publishable package found under packages/ — the enumeration is wrong, not the repository",
  );
  process.exit(1);
}

for (const dir of dirs) {
  console.log(`./${relative(process.cwd(), dir)}`);
}
