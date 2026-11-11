import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// Shown in exported diagnostic reports so a bug report names the exact build.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * The whole point of this app is that it never talks to a network.
 * The production build therefore ships a CSP that forbids every outbound
 * connection, so the claim is enforced by the browser instead of trusted.
 * It is injected only for builds: the dev server needs its HMR websocket.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'pic-privacy-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), cspPlugin()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
  server: { port: 5188, strictPort: true },
  // Dev and preview must not fight for one port: e2e drives both at once.
  preview: { port: 5190, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Entry point and the worker shim are exercised through the browser only.
      exclude: ['src/main.tsx', 'src/workers/**'],
      reporter: ['text', 'html'],
    },
  },
});
