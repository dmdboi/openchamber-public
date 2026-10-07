import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { vitestCiReport } from './scripts/vitest-ci-report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

// The root build/release scripts' tests. Some drive Bun-only modules
// (`Bun.build`) or spawn `process.execPath`, so the suite runs under the Bun
// runtime via the root `test:scripts` script (`bun --bun vitest run`).
export default defineConfig({
  ssr: {
    noExternal: ['zod'],
  },
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, 'test-shims/bun-test.ts') },
      { find: 'node:test', replacement: path.resolve(here, 'test-shims/node-test.ts') },
      { find: /^bun$/, replacement: path.resolve(here, 'test-shims/bun.ts') },
    ],
  },
  test: {
    ...vitestCiReport('scripts'),
    maxWorkers,
    include: ['scripts/**/*.test.{mjs,cjs,ts,js}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
