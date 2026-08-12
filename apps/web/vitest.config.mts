import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts, mirroring apps/server: the dev-server config
 * (port, API proxy) has nothing to do with how tests run, and Tailwind's
 * plugin is not needed to assert behaviour.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Stylesheets are imported by components under test; they carry no
    // behaviour, so they are not processed.
    css: false,
  },
});
