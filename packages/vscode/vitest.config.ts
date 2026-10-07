import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { vitestCiReport } from '../../scripts/vitest-ci-report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

export default defineConfig({
  ssr: {
    noExternal: ['zod'],
  },
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, '../../test-shims/bun-test.ts') },
      { find: 'node:test', replacement: path.resolve(here, '../../test-shims/node-test.ts') },
      { find: /^bun$/, replacement: path.resolve(here, '../../test-shims/bun.ts') },
      { find: '@openchamber/ui/tests', replacement: path.resolve(here, '../ui/tests') },
      { find: '@openchamber/ui', replacement: path.resolve(here, '../ui/src') },
      { find: '@openchamber/sdk', replacement: path.resolve(here, '../sdk/src/index.ts') },
      {
        find: '@openchamber/contracts',
        replacement: path.resolve(here, '../contracts/src/index.ts'),
      },
      { find: /^@\//, replacement: `${path.resolve(here, '../ui/src')}/` },
    ],
  },
  test: {
    ...vitestCiReport('vscode'),
    maxWorkers,
    include: [...configDefaults.include, 'tests/**/*.test.{ts,js}', 'webview/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
