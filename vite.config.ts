import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Wallpaper Engine loads index.html straight off disk / its own local file server,
// so every asset must resolve with a relative path — hence base: './'.
// (@swc/helpers is Apache-2.0, which can't go into a GPL-2.0-only program: the few of its helpers
// wasm-media-encoders asks for are our own — src/shims/swc)
const swcHelpers = { find: /^@swc\/helpers\/_\/(_[a-z_]+)$/, replacement: fileURLToPath(new URL('./src/shims/swc/$1.ts', import.meta.url)) };

export default defineConfig({
  base: './',
  resolve: { alias: [swcHelpers] },
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        preview: fileURLToPath(new URL('./preview.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [],
  },
});
