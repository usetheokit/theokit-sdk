import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // `lcov` is the reporter SonarCloud reads, and `sonar-project.properties` names this package's
      // `coverage/lcov.info`. Without this block vitest defaults to text/html/clover/json, that file
      // is never written, and the gate reports the absence as `new_coverage = 0.0` — a number about
      // a missing file, not about the code. Measured on #664: 94% code arriving at the gate as zero.
      reporter: ["text", "lcov", "html"],
    },
    // Default is os.availableParallelism(): one fork per core, each booting a full
    // test environment. Capping leaves headroom for the host, and costs no wall-clock
    // because the gain above this point was already noise when measured.
    maxWorkers: Math.max(2, cpus().length - 4),
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
