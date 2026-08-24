import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

/**
 * The widget's own build (ADR-021 §1) — separate from `vite.config.ts`
 * entirely, because it produces a different kind of artifact: one
 * dependency-free IIFE file, not the dashboard's SPA.
 *
 * Output lands in `public/widget.js`, which the dashboard's own `vite build`
 * (via `vite.config.ts`) then copies verbatim into `dist/` as part of its
 * normal `publicDir` handling. `npm run build` runs this config first for
 * exactly that reason — see `package.json`. The file is generated, not
 * source, and is `.gitignore`d accordingly.
 */
export default defineConfig({
  // This build's own outDir IS the other config's publicDir; if Vite also
  // treated "public" as ITS publicDir here, it would try to copy the
  // directory into itself. There is no separate set of static assets this
  // build needs to pass through.
  publicDir: false,
  build: {
    outDir: "public",
    // Never wipe the rest of `public/` (or a previous build's own output
    // from a partial run) — this config only ever adds widget.js.
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/widget/main.ts", import.meta.url)),
      // Required by Rollup for the iife format even though main.ts exports
      // nothing — the bundle runs entirely for its side effect (ADR-021 §9).
      name: "ServiqoWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
  },
});
