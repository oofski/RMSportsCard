import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Standalone Vitest config so the test runner uses the PROJECT root (not the
// renderer/ root from vite.config.js) and finds the suite under /test. The React
// plugin lets a handful of `.test.jsx` files render components (e.g. a
// SalesDashboard render smoke test) to catch render-time regressions the
// backend unit tests can't. renderToStaticMarkup needs no DOM, so 'node' stays.
export default defineConfig({
  plugins: [react()],
  test: {
    root: '.',
    include: ['test/**/*.test.js', 'test/**/*.test.jsx'],
    environment: 'node',
  },
})
