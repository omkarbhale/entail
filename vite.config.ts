import { defineConfig } from "vite";

// The board app's build (ADR-0021): src/ui/main.ts and what it imports, bundled with React into
// dist/ui/app.js and dist/ui/app.css, which the local server serves under /ui/.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/ui/main.ts",
      output: { entryFileNames: "app.js", chunkFileNames: "app-[name].js", assetFileNames: "app[extname]" },
    },
  },
});
