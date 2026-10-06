import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  getCurrentIdentity,
  commit,
  resolveBaseRefForLog,
  setLocalIdentity,
  clearLocalIdentity,
  configureRepositoryTransport,
  getGlobalIdentity,
  stageFiles,
  unstageFiles,
  hasLocalIdentity
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit, createTempRepo } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('git index path validation', () => {
  it('rejects stage paths outside the repository before invoking git', async () => {
    await expect(stageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });

  it('rejects unstage paths outside the repository before invoking git', async () => {
    await expect(unstageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });
});

describe.runIf(canRunGit())('configureRepositoryTransport', () => {
  const helper = "!'/data/bin/git-credential-openchamber'";
  const helpers = (repo) => {
    try { return execFileSync('git', ['config', '--local', '--get-all', 'credential.helper'], { cwd: repo, encoding: 'utf8' }).replace(/\n$/, '').split('\n'); }
    catch { return []; }
  };
  const sshCommand = (repo) => {
    try { return execFileSync('git', ['config', '--local', '--get', 'core.sshCommand'], { cwd: repo, encoding: 'utf8' }).trim(); }
    catch { return ''; }
  };

  it('names the helper after a reset, leaves the person\'s own entries, and removes only its own', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', '--local', 'credential.helper', 'osxkeychain']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['osxkeychain', '', helper]);
    // Writing the same thing again changes nothing.
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['osxkeychain', '', helper]);
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(helpers(repo)).toEqual(['osxkeychain']);
  });

  it('keeps the person\'s own empty reset and turns on path matching only while it owns it', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    const local = (key) => {
      try { return execFileSync('git', ['config', '--local', '--get', key], { cwd: repo, encoding: 'utf8' }).trim(); }
      catch { return null; }
    };
    runGit(repo, ['config', '--local', '--add', 'credential.helper', '']);
    runGit(repo, ['config', '--local', '--add', 'credential.helper', 'store']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['', 'store', '', helper]);
    expect(local('credential.useHttpPath')).toBe('true');
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(helpers(repo)).toEqual(['', 'store']);
    expect(local('credential.useHttpPath')).toBeNull();
    // A value the person set is left alone either way.
    runGit(repo, ['config', '--local', 'credential.useHttpPath', 'false']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(local('credential.useHttpPath')).toBe('false');
  });

  it('writes and removes the managed SSH command without touching one the person wrote', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    const managed = "OPENCHAMBER_GIT_SSH_KEY='/data/keys/one' '/usr/bin/bun' '/srv/ssh-wrapper.js'";
    await configureRepositoryTransport(repo, { sshCommand: managed });
    expect(sshCommand(repo)).toBe(managed);
    await configureRepositoryTransport(repo, { sshCommand: null });
    expect(sshCommand(repo)).toBe('');
    runGit(repo, ['config', '--local', 'core.sshCommand', 'ssh -i ~/.ssh/mine']);
    await configureRepositoryTransport(repo, { sshCommand: null });
    expect(sshCommand(repo)).toBe('ssh -i ~/.ssh/mine');
  });
});

describe.runIf(canRunGit())('setLocalIdentity', () => {
  beforeEach(() => {
    const home = createTempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, '.gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('SSH_AUTH_SOCK', path.join(home, 'unused-agent.sock'));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('reads the global author for a repository that sets none, and the local one when set', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', '--global', 'user.name', 'Global Author']);
    runGit(tmpDir, ['config', '--global', 'user.email', 'global@example.com']);
    expect(await getCurrentIdentity(tmpDir)).toEqual({ userName: 'Test User', userEmail: 'test@example.com', sshCommand: null });

    runGit(tmpDir, ['config', '--local', '--unset-all', 'user.name']);
    runGit(tmpDir, ['config', '--local', '--unset-all', 'user.email']);
    // An unset local key is a null value, not an error: the global author answers.
    expect(await getCurrentIdentity(tmpDir)).toEqual({ userName: 'Global Author', userEmail: 'global@example.com', sshCommand: null });
  });

  it('clears the author, tolerates keys that are not set, and reports a config it could not write', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(clearLocalIdentity(tmpDir)).resolves.toBe(true);
    expect(await getCurrentIdentity(tmpDir)).toMatchObject({ userName: null, userEmail: null });
    // Already clear: every key exits 5, which is success.
    await expect(clearLocalIdentity(tmpDir)).resolves.toBe(true);
    runGit(tmpDir, ['config', '--local', 'user.name', 'Stays']);
    fs.writeFileSync(path.join(tmpDir, '.git', 'config.lock'), '');
    await expect(clearLocalIdentity(tmpDir)).rejects.toThrow();
    fs.rmSync(path.join(tmpDir, '.git', 'config.lock'));
    expect((await getCurrentIdentity(tmpDir)).userName).toBe('Stays');
  });

  it.each([
    ['SSH', { authType: 'ssh', sshKey: '/unused/test key' }],
    ['legacy default SSH', { sshKey: '~/unused/legacy key' }],
    ['token', { authType: 'token', host: 'example.invalid' }],
    ['HTTPS', { authType: 'https', host: 'example.invalid' }],
    ['author only', {}],
    ['global', { id: 'global' }],
  ])('preserves authentication when applying a %s profile', async (_mode, legacyFields) => {
    for (const localAuth of [false, true]) {
      const { tmpDir } = await createTempRepo();
      runGit(tmpDir, ['config', '--global', 'user.name', 'Global Author']);
      runGit(tmpDir, ['config', '--global', 'user.email', 'global@example.com']);
      runGit(tmpDir, ['config', '--global', 'core.sshCommand', "ssh -i '/unused/global key' -o IdentitiesOnly=yes"]);
      runGit(tmpDir, ['config', '--global', '--replace-all', 'credential.helper', 'global-helper']);
      if (localAuth) {
        runGit(tmpDir, ['config', '--local', 'core.sshCommand', 'ssh -F /unused/repository-config']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', '']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', 'repository-helper']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', 'second-helper']);
      }
      const readAuth = () => runGit(tmpDir, ['config', '--null', '--get-regexp', '^(core\\.sshcommand|credential\\.helper)$']);
      const authBefore = readAuth();
      const globalBefore = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8');
      const global = await getGlobalIdentity();
      const profile = {
        userName: 'New Author',
        userEmail: 'new@example.com',
        ...legacyFields,
      };
      if (profile.id === 'global') {
        profile.userName = global.userName;
        profile.userEmail = global.userEmail;
        profile.sshKey = global.sshCommand.replace('ssh -i ', '');
      }
      Object.freeze(profile);

      await expect(setLocalIdentity(tmpDir, profile)).resolves.toBe(true);

      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.name']).trim()).toBe(profile.userName);
      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe(profile.userEmail);
      expect(readAuth()).toBe(authBefore);
      expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(globalBefore);
      const localConfig = runGit(tmpDir, ['config', '--local', '--list']);
      expect(localConfig.includes('core.sshcommand=')).toBe(localAuth);
      expect(localConfig.includes('credential.helper=')).toBe(localAuth);
    }
  });

  it('preserves signing settings unless SSH signing is explicitly enabled with a key', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', '--local', 'gpg.format', 'openpgp']);
    runGit(tmpDir, ['config', '--local', 'user.signingkey', 'existing-signing-key']);
    runGit(tmpDir, ['config', '--local', 'commit.gpgsign', 'false']);
    const profile = { userName: 'Signing Author', userEmail: 'signing@example.com' };
    for (const signing of [{}, { signCommits: false, signingKey: 'ignored' }, { signCommits: true, signingKey: ' ' }]) {
      await setLocalIdentity(tmpDir, { ...profile, ...signing });
      expect(runGit(tmpDir, ['config', '--local', '--get', 'gpg.format']).trim()).toBe('openpgp');
      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.signingkey']).trim()).toBe('existing-signing-key');
      expect(runGit(tmpDir, ['config', '--local', '--get', 'commit.gpgsign']).trim()).toBe('false');
    }
    await setLocalIdentity(tmpDir, { ...profile, signCommits: true, signingKey: ' /unused/signing.pub ' });
    expect(runGit(tmpDir, ['config', '--local', '--get', 'gpg.format']).trim()).toBe('ssh');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.signingkey']).trim()).toBe('/unused/signing.pub');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'commit.gpgsign']).trim()).toBe('true');
  });

  it('commits with the machine author when the repository overrides none, and refuses when there is none at all', async () => {
    const tmpDir = createTempDir();
    runGit(tmpDir, ['init']);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# identity\n');
    runGit(tmpDir, ['add', 'README.md']);

    // Nothing anywhere: the refusal says how to fix it rather than naming an internal rule.
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(false);
    await expect(commit(tmpDir, 'No author')).rejects.toThrow('No Git author is configured');

    // A repository on the System identity has no local author on purpose; the
    // machine's own author answers, exactly as plain Git would resolve it.
    runGit(tmpDir, ['config', '--global', 'user.name', 'Machine Author']);
    runGit(tmpDir, ['config', '--global', 'user.email', 'machine@example.com']);
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(false);
    await expect(commit(tmpDir, 'System identity')).resolves.toMatchObject({ success: true });
    expect(runGit(tmpDir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Machine Author <machine@example.com>');

    // An applied identity still decides: its author is the repository's own.
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# identity two\n');
    runGit(tmpDir, ['add', 'README.md']);
    runGit(tmpDir, ['config', '--local', 'user.name', 'Test User']);
    runGit(tmpDir, ['config', '--local', 'user.email', 'test@example.com']);
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(true);
    await expect(commit(tmpDir, 'Complete identity')).resolves.toMatchObject({ success: true });
    expect(runGit(tmpDir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Test User <test@example.com>');
  });

  // Author profiles no longer carry transport configuration: `setLocalIdentity`
  // writes only user.name, user.email and commit signing. Transport lives in the
  // repository binding, and HTTPS credentials come from the loopback credential
  // broker as single-use leases instead of a plaintext `credential.helper store`.
  it('writes only author fields and never a transport credential helper', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'Token User',
      userEmail: 'token@example.com',
      authType: 'token',
      host: 'github.com',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.name']).trim()).toBe('Token User');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe('token@example.com');
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'credential.helper'])).toThrow();
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand'])).toThrow();
  });

  it('never writes an ssh command for an ssh author profile', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'SSH User',
      userEmail: 'ssh@example.com',
      authType: 'ssh',
      sshKey: '/tmp/test key',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe('ssh@example.com');
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand'])).toThrow();
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'credential.helper'])).toThrow();
  });
});
