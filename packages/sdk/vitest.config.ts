import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { vitestCiReport } from '../../scripts/vitest-ci-report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

// The SDK suite drives Bun-native APIs (`Bun.sleep`, `Bun.spawn`, `Bun.hash`)
// and the bundle scripts shell out to Bun, so it runs under the Bun runtime
// via the package `test` script (`bun --bun vitest run`). Inlining zod keeps
// `import { z } from 'zod'` resolvable under that runtime.
export default defineConfig({
  ssr: {
    noExternal: ['zod'],
  },
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, '../../test-shims/bun-test.ts') },
      { find: 'node:test', replacement: path.resolve(here, '../../test-shims/node-test.ts') },
    ],
  },
  test: {
    ...vitestCiReport('sdk'),
    maxWorkers,
    include: [...configDefaults.include, 'tests/**/*.test.{ts,js}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
