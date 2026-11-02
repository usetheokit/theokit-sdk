import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Own entry, not the barrel: `dist/index.js` has a gzip budget (.bundle-budget.json).
    "extract-document": "src/extract-document-entry.ts",
    "read-pdf": "src/read-pdf-entry.ts",
    "github-link-preview": "src/github-link-preview-entry.ts",
    "screenshot-logbook": "src/screenshot-logbook-entry.ts",
    "structured-output": "src/structured-output-entry.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    entry: {
      index: "src/index.ts",
      "extract-document": "src/extract-document-entry.ts",
      "read-pdf": "src/read-pdf-entry.ts",
      "github-link-preview": "src/github-link-preview-entry.ts",
      "screenshot-logbook": "src/screenshot-logbook-entry.ts",
      "structured-output": "src/structured-output-entry.ts",
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  outDir: "dist",
  target: "node22",
  platform: "node",
  // EC-2 absorbed (SDK 2.0 plan T5.1): mark @theokit/* + optional peers as
  // external. Without `^@theokit/` regex, tsup bundles a copy of sdk-core
  // primitives (defineTool, CustomTool types) into sdk-tools/dist.
  external: [/^@theokit\//, "zod", "simple-git", "vitest"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
