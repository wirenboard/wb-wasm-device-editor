import path from 'path';

// Unit tests for the TypeScript that has no browser in it: persistence shapes,
// gateway discovery. Everything React or WASM stays under e2e/. Runs on
// homeui's vitest, which this app already resolves its dependencies from:
//   ../submodule/homeui/frontend/node_modules/.bin/vitest run --config vitest.config.ts
// A plain object rather than defineConfig(), because vitest is not resolvable
// from this directory's own node_modules.
const homeuiSrc = path.resolve(__dirname, '../submodule/homeui/frontend/src');

export default {
  resolve: {
    alias: { '@': homeuiSrc },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
};
