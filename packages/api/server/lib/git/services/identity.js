export const createIdentityService = ({ createGit, createGitForGlobalConfig, normalizeDirectoryPath, runGitCommand }) => {
  async function getGlobalIdentity() {
    const git = await createGitForGlobalConfig();

    try {
      const userName = await git.getConfig('user.name', 'global').catch(() => null);
      const userEmail = await git.getConfig('user.email', 'global').catch(() => null);
      const sshCommand = await git.getConfig('core.sshCommand', 'global').catch(() => null);

      return {
        userName: userName?.value || null,
        userEmail: userEmail?.value || null,
        sshCommand: sshCommand?.value || null
      };
    } catch (error) {
      console.error('Failed to get global Git identity:', error);
      return { userName: null, userEmail: null, sshCommand: null };
    }
  }

  async function getCurrentIdentity(directory) {
    const git = await createGit(directory);
    // An unset key reads as a null value rather than an error, so the fallback
    // to the person's global configuration has to look at the value.
    const localOrGlobal = async (key) => {
      const local = await git.getConfig(key, 'local').catch(() => null);
      if (local?.value) return local.value;
      const global = await git.getConfig(key, 'global').catch(() => null);
      return global?.value || null;
    };

    try {
      const [userName, userEmail, sshCommand] = await Promise.all([
        localOrGlobal('user.name'),
        localOrGlobal('user.email'),
        localOrGlobal('core.sshCommand'),
      ]);
      return { userName, userEmail, sshCommand };
    } catch (error) {
      console.error('Failed to get current Git identity:', error);
      return { userName: null, userEmail: null, sshCommand: null };
    }
  }

  async function hasLocalIdentity(directory) {
    const git = await createGit(directory);
    try {
      const localUserName = await git.getConfig('user.name', 'local').catch(() => null);
      const localUserEmail = await git.getConfig('user.email', 'local').catch(() => null);
      return Boolean(localUserName?.value?.trim() && localUserEmail?.value?.trim());
    } catch {
      return false;
    }
  }

  /** Removes the author override, without changing repository transport. */
  async function clearLocalIdentity(directory) {
    const directoryPath = normalizeDirectoryPath(directory);
    for (const key of ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format']) {
      const removed = await runGitCommand(directoryPath, ['config', '--local', '--unset-all', key]);
      if (!removed.success && removed.exitCode !== 5) {
        throw new Error(removed.stderr.trim() || `Failed to clear ${key}`);
      }
    }
    return true;
  }

  async function setLocalIdentity(directory, profile) {
    const git = await createGit(directory);
    try {
      // Author profiles do not own transport configuration, including legacy auth fields.
      await git.addConfig('user.name', profile.userName, false, 'local');
      await git.addConfig('user.email', profile.userEmail, false, 'local');
      if (profile.signCommits === true && typeof profile.signingKey === 'string' && profile.signingKey.trim()) {
        await git.addConfig('gpg.format', 'ssh', false, 'local');
        await git.addConfig('user.signingkey', profile.signingKey.trim(), false, 'local');
        await git.addConfig('commit.gpgsign', 'true', false, 'local');
      }
      return true;
    } catch (error) {
      console.error('Failed to set Git identity:', error);
      throw error;
    }
  }

  async function configureRepositoryTransport(directory, { credentialHelper = null, sshCommand = null } = {}) {
    const directoryPath = normalizeDirectoryPath(directory);
    if (typeof directoryPath !== 'string' || !directoryPath.trim()) throw new Error('Git directory is required');
    const config = (args) => runGitCommand(directoryPath, ['config', '--local', ...args]);
    const ourHelper = (value) => value.startsWith('!') && /git-credential-openchamber/.test(value);
    const helpers = await config(['--get-all', 'credential.helper']);
    if (!helpers.success && helpers.exitCode !== 1) throw new Error(helpers.stderr || 'Failed to read the repository credential helper');
    const current = helpers.success ? helpers.stdout.replace(/\n$/, '').split('\n') : [];
    // OpenChamber's entries are its helper and the empty reset written right
    // before it. Any other empty value is the person's own reset and stays.
    const others = [];
    for (const value of current) {
      if (!ourHelper(value)) { others.push(value); continue; }
      if (others.at(-1) === '') others.pop();
    }
    const wanted = credentialHelper ? [...others, '', credentialHelper] : others;
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      // Identical values cannot be removed one by one, so the list is rewritten
      // in order: the person's entries as they were, then OpenChamber's.
      const removed = await config(['--unset-all', 'credential.helper']);
      if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to update the repository credential helper');
      for (const value of wanted) {
        const added = await config(['--add', 'credential.helper', value]);
        if (!added.success) throw new Error(added.stderr || 'Failed to write the repository credential helper');
      }
    }
    // The helper picks the grant by repository path; the ownership marker
    // ensures only settings OpenChamber introduced are removed later.
    const ownedPathKey = 'openchamber.credentialusehttppath';
    const owned = (await config(['--get', ownedPathKey])).success;
    if (credentialHelper && !owned) {
      const existingPath = await config(['--get', 'credential.useHttpPath']);
      if (!existingPath.success && existingPath.exitCode !== 1) throw new Error(existingPath.stderr || 'Failed to read the repository credential settings');
      if (!existingPath.success) {
        for (const args of [['credential.useHttpPath', 'true'], [ownedPathKey, 'true']]) {
          const written = await config(args);
          if (!written.success) throw new Error(written.stderr || 'Failed to write the repository credential settings');
        }
      }
    } else if (!credentialHelper && owned) {
      for (const key of ['credential.useHttpPath', ownedPathKey]) {
        const removed = await config(['--unset-all', key]);
        if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to remove the repository credential settings');
      }
    }
    const currentSsh = await config(['--get', 'core.sshCommand']);
    const existingSsh = currentSsh.success ? currentSsh.stdout.trim() : '';
    const oursSsh = /ssh-wrapper\.js/.test(existingSsh);
    if (sshCommand) {
      if (existingSsh !== sshCommand) {
        const written = await config(['core.sshCommand', sshCommand]);
        if (!written.success) throw new Error(written.stderr || 'Failed to write the repository SSH command');
      }
    } else if (oursSsh) {
      const removed = await config(['--unset', 'core.sshCommand']);
      if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to remove the repository SSH command');
    }
    return true;
  }

  return { getGlobalIdentity, getCurrentIdentity, hasLocalIdentity, clearLocalIdentity, setLocalIdentity, configureRepositoryTransport };
};
