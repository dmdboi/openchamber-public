import path from 'node:path';
import type { InlineConfig } from 'vitest/node';

export const vitestCiReport = (
  suite: string,
  coverageInclude?: string[],
): Pick<InlineConfig, 'reporters' | 'outputFile' | 'coverage'> => {
  const reportDir = process.env.VITEST_REPORT_DIR;
  if (!reportDir) return {};

  return {
    reporters: ['default', 'junit'],
    outputFile: { junit: path.join(reportDir, 'timings', `${suite}.xml`) },
    ...(coverageInclude
      ? {
          coverage: {
            enabled: true,
            provider: 'v8',
            include: coverageInclude,
            reporter: ['text-summary', 'json-summary'],
            reportsDirectory: path.join(reportDir, 'coverage', suite),
          },
        }
      : {}),
  };
};
