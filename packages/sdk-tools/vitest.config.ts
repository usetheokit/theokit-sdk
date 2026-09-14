import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default is os.availableParallelism(): one fork per core, each booting a full
    // test environment. Capping leaves headroom for the host, and costs no wall-clock
    // because the gain above this point was already noise when measured.
    maxWorkers: Math.max(2, cpus().length - 4),
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    coverage: {
      // `lcov` is the reporter SonarCloud reads, and `sonar-project.properties` has always named
      // `packages/sdk-tools/coverage/lcov.info`. Without this block the default reporters are
      // text/html/clover/json, so that file never existed and every change to this package arrived
      // at the quality gate as `new_coverage = 0.0` — measured on PR #664, whose new code is at 94%.
      //
      // A declared path nothing writes is the failure this repository keeps finding under other
      // names: the gate reads as configured and reports absence as zero.
      //
      // This block is NECESSARY AND NOT SUFFICIENT, and saying so here is the point — the commit
      // that added it did not. `ci.yml` runs `pnpm quality:coverage`, which is
      // `pnpm --filter=@theokit/sdk exec vitest run --coverage`: one package. So the runner still
      // never executes this package's coverage pass, and SonarCloud still receives nothing for it.
      // What changes is that a LOCAL `vitest run --coverage` now writes the file the gate names, so
      // the remaining gap is one decision (what `quality:coverage` should run) rather than two.
      // Tracked in usetheokit/theokit-sdk#665.
      reporter: ["text", "lcov", "html"],
    },
  },
});
