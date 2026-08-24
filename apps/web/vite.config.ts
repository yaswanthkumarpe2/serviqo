import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /*
      Keeps the API same-origin during development.

      This is not only convenience: the refresh cookie is SameSite=Strict and
      Path=/api/v1/auth, so a cross-origin call to the backend's port would
      never receive it, and the server has no CORS layer by design. Proxying
      means the browser sees one origin, exactly as it will in production
      behind a single edge.
    */
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
      },
      /*
        The same treatment for the socket transport (ADR-025 §11).

        Socket.IO attaches at the server root rather than under the REST
        prefix, so it needs its own entry — and `ws: true`, or the upgrade
        request is proxied as plain HTTP and the handshake never completes.

        Without this the dashboard's socket would be CROSS-origin in
        development while being same-origin in production, which is exactly
        the kind of difference the `/api` entry above exists to prevent.
      */
      "/socket.io": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
