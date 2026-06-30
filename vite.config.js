import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer (React UI) lives in /renderer. We build it to /renderer/dist,
// which the Electron main process loads via file:// in production.
//
// `base: './'` makes all asset URLs relative so they resolve correctly when
// the bundle is loaded from the local filesystem inside the packaged .exe
// (absolute "/assets/..." paths break under the file:// protocol).
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Allow importing the single-source-of-truth shared/reference.json which
    // lives one level above the renderer root.
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
