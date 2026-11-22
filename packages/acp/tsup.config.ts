import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  outDir: "dist",
  target: "node22",
  platform: "node",
  external: ["@theokit/sdk", "@agentclientprotocol/sdk"],
});
