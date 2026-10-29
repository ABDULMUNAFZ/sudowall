import { defineConfig } from 'vite';

// Served by `tortoisegate ui` on 127.0.0.1 under a strict CSP: one script and one stylesheet from
// the same origin, no inline code, no external requests.
export default defineConfig({
  base: './',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
