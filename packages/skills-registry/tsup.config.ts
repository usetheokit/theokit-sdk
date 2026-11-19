import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    entry: {
      index: "src/index.ts",
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  outDir: "dist",
  target: "node22",
  platform: "node",
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
