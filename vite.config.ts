import { defineConfig } from "vite";

export default defineConfig({
  // relative paths, so the built app also loads from a file inside the desktop app
  base: "./",
  server: { port: 5173, open: true },
  build: { chunkSizeWarningLimit: 4000 },
});
