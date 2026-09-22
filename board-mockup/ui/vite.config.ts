import { defineConfig } from 'vite'

// The UI holds no state of its own: every request under /api goes to the mock
// server, which must be running on its default port (see ../README.md).
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:4317' },
  },
})
