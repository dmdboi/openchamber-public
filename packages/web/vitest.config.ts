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
      { find: 'bun:test', replacement: path.resolve(here, '../api/test/bun-test-shim.ts') },
      {
        find: '@openchamber/sdk/schemas',
        replacement: path.resolve(here, '../sdk/src/schemas.ts'),
      },
      { find: '@openchamber/sdk', replacement: path.resolve(here, '../sdk/src/index.ts') },
      { find: '@openchamber/ui/tests', replacement: path.resolve(here, '../ui/tests') },
      { find: '@openchamber/ui', replacement: path.resolve(here, '../ui/src') },
      { find: '@web', replacement: path.resolve(here, './src') },
      { find: /^@\//, replacement: `${path.resolve(here, '../ui/src')}/` },
    ],
  },
  test: {
    ...vitestCiReport('web'),
    maxWorkers,
    include: [...configDefaults.include, '../ui/tests/src/**/*.vitest.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      OPENCHAMBER_ENTERPRISE_MODE: '',
      OPENCHAMBER_RELAY_URL: '',
      OPENCHAMBER_JEV_URL: '',
      OPENCHAMBER_JEV_MODEL: '',
      OPENCHAMBER_JEV_API_KEY: '',
    },
  },
});
