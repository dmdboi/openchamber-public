import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { vitestCiReport } from '../../scripts/vitest-ci-report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, '../../test-shims/bun-test.ts') },
      { find: 'node:test', replacement: path.resolve(here, '../../test-shims/node-test.ts') },
    ],
  },
  test: {
    ...vitestCiReport('electron'),
    maxWorkers,
    include: [...configDefaults.include, 'tests/**/*.test.{mjs,js,ts}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
