import { defineConfig } from 'vitest/config'

// Standalone Vitest config so the test runner uses the PROJECT root (not the
// renderer/ root from vite.config.js) and finds the suite under /test.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
