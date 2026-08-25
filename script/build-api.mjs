import { build } from "esbuild";

await build({
  entryPoints: ["api-src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "api/index.js",
  packages: "bundle",
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});
