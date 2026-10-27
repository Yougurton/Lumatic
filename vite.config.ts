import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Wallpaper Engine loads index.html straight off disk / its own local file server,
// so every asset must resolve with a relative path — hence base: './'.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
  },
  worker: {
    format: 'es',
  },
});
