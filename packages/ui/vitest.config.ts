import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

// UI suites build their own happy-dom `Window` and install it on `globalThis`,
// so the runner environment stays `node`. Each file gets its own Vitest worker
// module registry, which is what the old per-file process isolation protected.
export default defineConfig({
  // Under the Bun runtime Vite externalizes zod and Bun's ESM interop hands
  // back a namespace without `z`, so `import { z } from 'zod'` is undefined.
  // Inlining zod in the test server restores the namespace.
  ssr: {
    noExternal: ['zod'],
  },
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, '../../test-shims/bun-test.ts') },
      { find: 'node:test', replacement: path.resolve(here, '../../test-shims/node-test.ts') },
      { find: /^bun$/, replacement: path.resolve(here, '../../test-shims/bun.ts') },
      { find: '@openchamber/sdk/schemas', replacement: path.resolve(here, '../sdk/src/schemas.ts') },
      { find: '@openchamber/sdk', replacement: path.resolve(here, '../sdk/src/index.ts') },
      { find: '@openchamber/ui/tests', replacement: path.resolve(here, './tests') },
      { find: '@openchamber/ui', replacement: path.resolve(here, './src') },
      { find: /^@\//, replacement: `${path.resolve(here, './src')}/` },
    ],
  },
  test: {
    maxWorkers,
    setupFiles: ['./tests/vitest.setup.ts'],
    include: [...configDefaults.include, 'tests/src/**/*.vitest.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
