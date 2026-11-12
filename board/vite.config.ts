import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The board: built into dist/board next to the compiled server, which serves it. */
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/board", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:4380", changeOrigin: false } },
  },
  test: {
    root,
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
