import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  inspectContributorCheckoutActions
} from '../../../../server/lib/git/service.js';
const { runGit, createRepositoryWithRemote } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


describe('contributor checkout trust inspection', () => {
  it('inspects the effective relative hooksPath from the worktree directory', async () => {
    const { repository } = createRepositoryWithRemote();
    const hooksDirectory = path.join(repository, 'trusted-hooks');
    fs.mkdirSync(hooksDirectory);
    const hookPath = path.join(hooksDirectory, 'post-checkout');
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hookPath, 0o755);
    runGit(repository, ['config', 'core.hooksPath', 'trusted-hooks']);
    const sourceSha = runGit(repository, ['rev-parse', 'HEAD']).trim();

    const inspection = await inspectContributorCheckoutActions(repository, {
      sourceSha, projectId: 'missing_project', setupCommand: '',
    });

    expect(inspection.actions).toEqual([expect.objectContaining({
      kind: 'post-checkout-hook', path: hookPath,
    })]);
  });

  it('binds checkout trust to the hook invocation path as well as its bytes', async () => {
    const { repository } = createRepositoryWithRemote();
    const firstDirectory = path.join(repository, 'first-hooks');
    const secondDirectory = path.join(repository, 'second-hooks');
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    for (const directory of [firstDirectory, secondDirectory]) {
      const hookPath = path.join(directory, 'post-checkout');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hookPath, 0o755);
    }
    const sourceSha = runGit(repository, ['rev-parse', 'HEAD']).trim();
    const provenance = { sourceSha, projectId: 'missing_project', setupCommand: '' };
    runGit(repository, ['config', 'core.hooksPath', 'first-hooks']);
    const first = await inspectContributorCheckoutActions(repository, provenance);
    runGit(repository, ['config', 'core.hooksPath', 'second-hooks']);
    const second = await inspectContributorCheckoutActions(repository, provenance);

    expect(first.actions[0].contentDigest).toBe(second.actions[0].contentDigest);
    expect(first.digest).not.toBe(second.digest);
  });
});
