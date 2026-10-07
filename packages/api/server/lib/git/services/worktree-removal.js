import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export function createWorktreeRemovalService({
  normalizeDirectoryPath, canonicalPath,
  waitForActiveWorktreeBootstrap, clearWorktreeBootstrapState,
  resolveWorktreeProjectContext, listWorktreeEntries, runGitCommand,
  runGitCommandOrThrow, isInsideOrSameDirectory, checkPathExists,
  getFileIdentity, toGitPath, cleanBranchName,
  wait, isLinkedWorktree, publishWorktreeTopologyChange,
}) {
/**
 * Releases the OpenCode instance that served a removed worktree. The owning
 * runtime injects `disposeInstance`; disposal is best-effort, so a failure is
 * warned about and never fails or rolls back the removal.
 */
const disposeWorktreeInstanceBestEffort = async (disposeInstance, worktreeDirectory) => {
  if (!disposeInstance) {
    return;
  }
  try {
    await disposeInstance(worktreeDirectory);
  } catch (error) {
    console.warn(
      `Failed to dispose the OpenCode instance for removed worktree ${worktreeDirectory}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
};

// Windows refuses to delete a folder another process still holds (a session's
// shell, a file watcher, an editor); those handles are usually released
// moments later, so a busy failure is retried briefly before it is reported.
const WORKTREE_BUSY_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const WORKTREE_BUSY_MESSAGE = 'The worktree folder is still in use by another process (a running session, terminal or editor). Stop it and try again.';

// Only Windows locks a folder that is open elsewhere; on other platforms the
// same words mean a real permission problem and are reported as they are.
const isWorktreeBusyError = (text) => process.platform === 'win32'
  && /Permission denied|EBUSY|EPERM|resource busy|being used by another process/i.test(String(text || ''));

const removeBusyDirectory = async (targetDirectory) => {
  try {
    // fs.rm retries EBUSY/EPERM itself with these options.
    await fsp.rm(targetDirectory, { recursive: true, force: true, maxRetries: WORKTREE_BUSY_RETRY_DELAYS_MS.length, retryDelay: WORKTREE_BUSY_RETRY_DELAYS_MS[0] });
  } catch (error) {
    if (isWorktreeBusyError(error?.code) || isWorktreeBusyError(error?.message)) {
      throw new Error(WORKTREE_BUSY_MESSAGE);
    }
    throw error;
  }
};

const isSameFilesystemEntry = (current, original) => current?.dev === original.dev && current?.ino === original.ino;

// Git removal requires a gitdir file even when Git accepts a directory symlink
// for ordinary worktree operations. Only a registered linked worktree calls here.
const replaceWorktreeGitDirectoryLink = async (primaryWorktree, worktreePath) => {
  const gitEntry = path.join(worktreePath, '.git');
  const linkStat = await fsp.lstat(gitEntry).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!linkStat?.isSymbolicLink() || !(await fsp.stat(gitEntry)).isDirectory()) return null;

  const linkTarget = await fsp.readlink(gitEntry, { encoding: 'buffer' });
  const metadataDirectory = await fsp.realpath(gitEntry);
  const commonResult = await runGitCommandOrThrow(primaryWorktree, ['rev-parse', '--git-common-dir']);
  const commonDirectory = await canonicalPath(path.resolve(primaryWorktree, commonResult.stdout.trim()));
  const metadataRoot = await canonicalPath(path.join(commonDirectory, 'worktrees'));
  if (await canonicalPath(path.dirname(metadataDirectory)) !== metadataRoot) {
    throw new Error('Worktree .git symlink target is outside this repository\'s worktree metadata');
  }

  const commonDir = (await fsp.readFile(path.join(metadataDirectory, 'commondir'), 'utf8')).trim();
  if (!commonDir || await canonicalPath(path.resolve(metadataDirectory, commonDir)) !== commonDirectory) {
    throw new Error('Worktree .git symlink metadata has a different common directory');
  }

  const backlink = (await fsp.readFile(path.join(metadataDirectory, 'gitdir'), 'utf8')).trim();
  const backlinkPath = path.resolve(metadataDirectory, backlink);
  // Compare the .git entry, not its symlink target: another worktree can point
  // at the same metadata directory without owning it.
  if (!backlink || path.basename(backlinkPath) !== '.git'
    || await canonicalPath(path.dirname(backlinkPath)) !== await canonicalPath(worktreePath)) {
    throw new Error('Worktree .git symlink metadata backlink does not name this worktree');
  }

  const worktreeStat = await fsp.stat(worktreePath);
  const metadataStat = await fsp.stat(metadataDirectory);
  const sameDirectoriesExist = async () => {
    const [currentWorktree, currentMetadata] = await Promise.all([
      fsp.stat(worktreePath).catch(() => null),
      fsp.stat(metadataDirectory).catch(() => null),
    ]);
    return currentWorktree?.isDirectory() && isSameFilesystemEntry(currentWorktree, worktreeStat)
      && currentMetadata?.isDirectory() && isSameFilesystemEntry(currentMetadata, metadataStat);
  };
  const restoreClaimedEntry = async (claimedEntry) => {
    const claimedStat = await fsp.lstat(claimedEntry);
    if (claimedStat.isSymbolicLink()) {
      // Hardlink creation can follow symlinks; preserve their target bytes.
      const claimedTarget = await fsp.readlink(claimedEntry, { encoding: 'buffer' });
      await fsp.symlink(claimedTarget, gitEntry);
      const currentLink = await fsp.lstat(claimedEntry).catch(() => null);
      return currentLink?.isSymbolicLink() && isSameFilesystemEntry(currentLink, claimedStat)
        && (await fsp.readlink(claimedEntry, { encoding: 'buffer' })).equals(claimedTarget);
    }
    if (claimedStat.isFile()) {
      await fsp.link(claimedEntry, gitEntry);
      return true;
    }
    return false;
  };
  const contents = `gitdir: ${process.platform === 'win32' ? toGitPath(metadataDirectory) : metadataDirectory}\n`;
  const temporaryEntry = `${gitEntry}.openchamber-${randomUUID()}`;
  const claimedLinkEntry = `${gitEntry}.openchamber-${randomUUID()}`;
  let temporaryIdentity;
  let claimedLink = false;
  let releaseLinkClaim = false;
  try {
    await fsp.writeFile(temporaryEntry, contents, { flag: 'wx', mode: 0o600 });
    temporaryIdentity = await getFileIdentity(temporaryEntry);
    const currentLink = await fsp.lstat(gitEntry);
    if (!currentLink.isSymbolicLink() || !isSameFilesystemEntry(currentLink, linkStat)
      || !(await fsp.readlink(gitEntry, { encoding: 'buffer' })).equals(linkTarget)) {
      throw new Error('Worktree .git entry changed before removal');
    }
    await fsp.rename(gitEntry, claimedLinkEntry);
    claimedLink = true;
    const capturedLink = await fsp.lstat(claimedLinkEntry);
    if (!capturedLink.isSymbolicLink() || !isSameFilesystemEntry(capturedLink, linkStat)
      || !(await fsp.readlink(claimedLinkEntry, { encoding: 'buffer' })).equals(linkTarget)
      || !await sameDirectoriesExist()) {
      throw new Error('Worktree .git entry changed before removal');
    }
    // The complete gitdir file appears only if no newer .git entry exists.
    await fsp.link(temporaryEntry, gitEntry);
    releaseLinkClaim = true;
  } catch (error) {
    if (claimedLink && await sameDirectoriesExist()) {
      try {
        releaseLinkClaim = await restoreClaimedEntry(claimedLinkEntry);
      } catch (restoreError) {
        if (restoreError?.code !== 'EEXIST') {
          console.warn('Failed to restore claimed worktree .git entry before removal:', restoreError);
        }
      }
    }
    throw error;
  } finally {
    if (claimedLink) {
      if (releaseLinkClaim) {
        await fsp.unlink(claimedLinkEntry).catch((error) => {
          if (error?.code !== 'ENOENT') {
            console.warn(`Failed to clean up worktree .git recovery entry: ${claimedLinkEntry}`, error);
          }
        });
      } else {
        console.warn(`Check worktree .git recovery entry: ${claimedLinkEntry}`);
      }
    }
    await fsp.rm(temporaryEntry, { force: true }).catch((error) => {
      console.warn('Failed to clean up temporary worktree gitdir file:', error);
    });
  }

  return async () => {
    const isTemporaryFile = async (entry) => {
      const stat = await fsp.lstat(entry).catch(() => null);
      return stat?.isFile() && await getFileIdentity(entry) === temporaryIdentity
        && await fsp.readFile(entry, 'utf8') === contents;
    };
    if (!await sameDirectoriesExist() || !await isTemporaryFile(gitEntry)) return;

    const claimedEntry = `${gitEntry}.openchamber-${randomUUID()}`;
    try {
      await fsp.rename(gitEntry, claimedEntry);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    let releaseClaim = false;
    try {
      if (!await sameDirectoriesExist()) return;
      if (!await isTemporaryFile(claimedEntry)) {
        releaseClaim = await restoreClaimedEntry(claimedEntry);
        return;
      }
      try {
        await fsp.symlink(linkTarget, gitEntry, 'dir');
        releaseClaim = true;
      } catch (error) {
        if (error?.code === 'EEXIST') {
          releaseClaim = await isTemporaryFile(claimedEntry);
          return;
        }
        if (await sameDirectoriesExist()) {
          await fsp.link(claimedEntry, gitEntry);
          releaseClaim = true;
        }
        throw error;
      }
    } finally {
      if (releaseClaim) {
        await fsp.unlink(claimedEntry);
      } else {
        console.warn(`Check worktree .git recovery entry: ${claimedEntry}`);
      }
    }
  };
};

// Resolves true when git removed the worktree, false when git dropped the
// registration but left the folder behind (the caller removes it as an orphan).
const removeGitWorktreeWhenFree = async (primaryWorktree, worktreePath, targetCanonical) => {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runGitCommand(primaryWorktree, ['worktree', 'remove', '--force', worktreePath]);
    if (result.success) return true;
    if (!isWorktreeBusyError(result.message)) {
      throw new Error(result.message || 'Failed to remove git worktree');
    }
    const stillRegistered = await (async () => {
      for (const entry of await listWorktreeEntries(primaryWorktree)) {
        if (entry?.worktree && await canonicalPath(entry.worktree) === targetCanonical) return true;
      }
      return false;
    })();
    if (!stillRegistered) return false;
    const delay = WORKTREE_BUSY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw new Error(WORKTREE_BUSY_MESSAGE);
    await wait(delay);
  }
};

async function removeWorktree(directory, input = {}, { bootstrapStore } = {}) {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }

  const targetCanonical = await canonicalPath(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetCanonical);

  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const deleteLocalBranch = input?.deleteLocalBranch === true;

  const primaryCanonical = await canonicalPath(context.primaryWorktree);
  if (targetCanonical === primaryCanonical) {
    throw new Error('Cannot remove the primary workspace');
  }
  const worktreeRootCanonical = await canonicalPath(context.worktreeRoot);
  const legacyWorktreeRootCanonical = context.legacyWorktreeRoot
    ? await canonicalPath(context.legacyWorktreeRoot)
    : null;

  const entries = await listWorktreeEntries(context.primaryWorktree);
  const matchedEntry = await (async () => {
    for (const entry of entries) {
      if (!entry?.worktree) {
        continue;
      }
      const entryCanonical = await canonicalPath(entry.worktree);
      if (entryCanonical === targetCanonical) {
        return entry;
      }
    }
    return null;
  })();

  const removeManagedOrphan = async ({ registered }) => {
    // The data-dir root is ours alone, so any leftover inside it may go. A
    // configured worktree.directory can be shared (".." is the repository's
    // parent, holding sibling projects), so there only a directory git had
    // registered as this project's worktree is deleted; an unregistered one
    // could be anything.
    const insideLegacyRoot = legacyWorktreeRootCanonical !== null
      && targetCanonical !== legacyWorktreeRootCanonical
      && isInsideOrSameDirectory(legacyWorktreeRootCanonical, targetCanonical);
    const insideConfiguredRoot = targetCanonical !== worktreeRootCanonical
      && isInsideOrSameDirectory(worktreeRootCanonical, targetCanonical);
    const isManagedOrphan = insideLegacyRoot || (registered && insideConfiguredRoot);

    await clearWorktreeBootstrapState(targetDirectory, bootstrapStore);
    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists && isManagedOrphan) {
      await removeBusyDirectory(targetDirectory);
    }
    // A removal git abandoned halfway leaves `.git/worktrees/<name>` without
    // its gitdir; prune drops that metadata so it cannot linger.
    await runGitCommand(context.primaryWorktree, ['worktree', 'prune']);
  };

  if (!matchedEntry?.worktree) {
    await removeManagedOrphan({ registered: false });
    return true;
  }

  await clearWorktreeBootstrapState(matchedEntry.worktree, bootstrapStore);
  // The directory is a registered linked worktree and still exists here, which
  // is the only point where its OpenCode instance can be released by path.
  await disposeWorktreeInstanceBestEffort(input?.disposeInstance, matchedEntry.worktree);

  const restoreGitDirectoryLink = await replaceWorktreeGitDirectoryLink(context.primaryWorktree, matchedEntry.worktree);
  try {
    const removedByGit = await removeGitWorktreeWhenFree(context.primaryWorktree, matchedEntry.worktree, targetCanonical);
    if (!removedByGit) {
      // Git deleted its registration but not the still-locked folder.
      await removeManagedOrphan({ registered: true });
    }
  } catch (error) {
    if (restoreGitDirectoryLink) {
      await restoreGitDirectoryLink().catch((restoreError) => {
        console.warn('Failed to restore worktree .git symlink after removal failed:', restoreError);
      });
    }
    throw error;
  }
  await publishWorktreeTopologyChange(context.primaryWorktree);

  if (deleteLocalBranch) {
    const branchName = cleanBranchName(String(matchedEntry.branchRef || matchedEntry.branch || '').trim());
    if (branchName) {
      await runGitCommandOrThrow(
        context.primaryWorktree,
        ['branch', '-D', branchName],
        `Failed to delete local branch ${branchName}`
      );
    }
  }

  return true;
}
  return removeWorktree;
}
