import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The board server the dev server proxies to; the same origin serves both in production.
const board = process.env["STELLARIS_BOARD_URL"] ?? "http://127.0.0.1:4700";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // React 19's production client alone is about 400 kB minified.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    proxy: { "/api": board, "/health": board },
  },
});
