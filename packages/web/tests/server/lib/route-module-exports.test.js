import { describe, expect, it } from 'vitest';

describe('lazy-loaded route module exports', () => {
  it.each([
    ['./../../../server/lib/git/index.js', [
      'computeIntegratePlan',
      'createBranch',
      'deleteProfile',
      'getCommitSummaries',
      'listStashes',
    ]],
    ['./../../../server/lib/quota/index.js', ['fetchQuotaForProvider', 'listConfiguredQuotaProviders']],
    ['./../../../server/lib/tts/index.js', ['ttsService', 'TTS_VOICES']],
    ['./../../../server/lib/walkthrough/index.js', ['getRepositoryRootFor']],
  ])('%s keeps the exports its routes load dynamically', async (specifier, names) => {
    const routeModule = await import(specifier);

    for (const name of names) {
      expect(routeModule[name], `${specifier} must export ${name}`).toBeDefined();
    }
  });
});
