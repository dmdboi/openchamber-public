export function createRepositoryOperationsService({
  createRepositoryGitContext,
  runGitCommand,
  normalizeDirectoryPath,
  resolveGitFileContext,
  getNoIndexDiff,
  withGitIndexMutationQueue,
  parseGitErrorText,
}) {
  // Whether `sha` is reachable from the checked-out HEAD. An object git has never
  // fetched fails the same way an unrelated commit does: not an ancestor.
  async function isAncestorOfHead(directory, sha) {
    const normalizedDirectory = normalizeDirectoryPath(directory);
    const normalizedSha = typeof sha === 'string' ? sha.trim() : '';
    if (!normalizedDirectory || !/^[0-9a-f]{7,64}$/i.test(normalizedSha)) {
      return false;
    }
    const result = await runGitCommand(normalizedDirectory, ['merge-base', '--is-ancestor', normalizedSha, 'HEAD']);
    return result.success;
  }

  /**
   * Individual untracked file paths, honoring ignore rules.
   *
   * Deliberately not `--directory`: collapsed directory entries end in a slash
   * and are not valid inputs to the per-file diff helpers, so a caller would
   * silently lose every file inside a new directory. Listing files costs more
   * entries but each one is usable.
   *
   * Callers that only need this list should not pay for `getStatus`, which also
   * computes ahead/behind, diff stats, and merge state — an order of magnitude
   * more work for an answer they throw away.
   */
  async function listUntrackedPaths(directory) {
    const { repoRoot } = await createRepositoryGitContext(directory);
    const result = await runGitCommand(repoRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ]);
    if (!result.success) return [];
    return String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Diffs for untracked files, produced against an empty tree.
   *
   * `getDiff` re-resolves the repository context on every call, which costs an
   * extra `rev-parse` per file; a walkthrough of a branch with thirty new files
   * pays that thirty times. This resolves once and reuses it, with a bounded pool
   * so a repository full of new files cannot flood the process table.
   *
   * Returns one entry per input path, in order; unreadable paths yield `''`
   * rather than failing the batch.
   */
  async function getUntrackedDiffs(directory, filePaths = [], { concurrency = 8, contextLines = 3 } = {}) {
    const paths = (Array.isArray(filePaths) ? filePaths : []).filter((value) => typeof value === 'string' && value);
    if (paths.length === 0) return [];

    const { directoryPath, directoryGit, repoRoot } = await createRepositoryGitContext(directory);
    const results = new Array(paths.length).fill('');
    let cursor = 0;

    const worker = async () => {
      while (cursor < paths.length) {
        const index = cursor++;
        try {
          const fileContext = await resolveGitFileContext(directoryPath, directoryGit, paths[index], repoRoot);
          results[index] = await getNoIndexDiff(repoRoot, fileContext.repoPath, contextLines);
        } catch {
          results[index] = '';
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return results;
  }

  async function listStashes(directory) {
    const { git } = await createRepositoryGitContext(directory);
    const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H']);
    return String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
        return { ref, message, relativeTime, hash };
      })
      .filter((entry) => entry.ref);
  }

  /** @public */
  async function countStashFiles(directory, refs = []) {
    const { git } = await createRepositoryGitContext(directory);
    const uniqueRefs = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
    const counts = {};
    const concurrency = 4;
    let cursor = 0;

    const worker = async () => {
      while (cursor < uniqueRefs.length) {
        const ref = uniqueRefs[cursor++];
        if (!ref) continue;
        try {
          const names = await git.raw(['stash', 'show', '--name-only', ref]);
          counts[ref] = String(names || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
        } catch {
          counts[ref] = 0;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
    return counts;
  }

  /** @public */
  async function stashPush(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);
    const message = typeof options.message === 'string' && options.message.trim()
      ? options.message.trim()
      : `OpenChamber stash ${new Date().toISOString()}`;
    const output = await git.raw(['stash', 'push', '--include-untracked', '-m', message]);
    return {
      success: true,
      created: !/no local changes/i.test(String(output || '')),
      message,
      output: String(output || '').trim(),
    };
  }

  /** @public */
  async function stashApply(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);
    const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
    // Prefer --index so the staged/unstaged split captured in the stash is restored
    // faithfully. Fall back to a plain apply when the index can't be reinstated
    // cleanly (e.g. conflicts), which is the prior behavior.
    await git.raw(['stash', 'apply', '--index', ref]).catch(async () => {
      await git.raw(['stash', 'apply', ref]);
    });
    return { success: true, ref };
  }

  /** @public */
  async function stashDrop(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);
    const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
    await git.raw(['stash', 'drop', ref]);
    return { success: true, ref };
  }

  /** @public */
  async function stashPop(directory, options = {}) {
    const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
    await stashApply(directory, { ref });
    await stashDrop(directory, { ref });
    return { success: true, ref };
  }

  async function commit(directory, message, options = {}) {
    return withGitIndexMutationQueue(directory, async () => {
      const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
      // An identity applied here writes the repository's own author, and that is
      // what a commit uses. A repository on the System identity deliberately has
      // none: it says no override applies, so the machine's own author answers,
      // which is what Git itself would do. The panel names that author before
      // the commit, so it is a stated choice rather than an ambient surprise.
      const [localUserName, localUserEmail] = await Promise.all([
        git.getConfig('user.name', 'local').catch(() => null),
        git.getConfig('user.email', 'local').catch(() => null),
      ]);
      if (!localUserName?.value?.trim() || !localUserEmail?.value?.trim()) {
        const [globalUserName, globalUserEmail] = await Promise.all([
          git.getConfig('user.name', 'global').catch(() => null),
          git.getConfig('user.email', 'global').catch(() => null),
        ]);
        if (!globalUserName?.value?.trim() || !globalUserEmail?.value?.trim()) {
          throw new Error('No Git author is configured. Choose an identity for this repository, or set user.name and user.email on this computer.');
        }
      }
      let temporarilyUnstagedFiles = [];

      try {
        const requestedFiles = Array.isArray(options.files)
          ? options.files
            .map((value) => String(value || '').trim())
            .filter(Boolean)
          : [];
        const requestedStageFiles = Array.isArray(options.stageFiles)
          ? options.stageFiles
            .map((value) => String(value || '').trim())
            .filter(Boolean)
          : null;
        let filesToCommit = [];
        let commitFromIndexOnly = false;

        if (options.addAll) {
          await git.add('.');
        } else if (requestedFiles.length > 0) {
          filesToCommit = Array.from(new Set(await Promise.all(requestedFiles.map(async (filePath) => {
            const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
            return fileContext.repoPath;
          }))));

          const stageFilesToCommit = requestedStageFiles
            ? Array.from(new Set(await Promise.all(requestedStageFiles.map(async (filePath) => {
              const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
              return fileContext.repoPath;
            }))))
            : null;

          const status = await git.status();
          const fileStatusByPath = new Map(status.files.map((file) => [file.path, file]));
        filesToCommit = filesToCommit.filter((filePath) => fileStatusByPath.has(filePath));

          if (filesToCommit.length === 0) {
            throw new Error('No selected files are available to commit. Refresh git status and try again.');
          }

          if (requestedStageFiles) {
            commitFromIndexOnly = true;
            const selectedFileSet = new Set(filesToCommit);
            temporarilyUnstagedFiles = status.files
              .filter((file) => {
                const indexStatus = (file.index || '').trim();
                return indexStatus && indexStatus !== '?' && !selectedFileSet.has(file.path);
              })
              .map((file) => file.path);

            if (temporarilyUnstagedFiles.length > 0) {
              await git.raw(['restore', '--staged', '--', ...temporarilyUnstagedFiles]);
            }
          }

          const filesNeedingAdd = requestedStageFiles
            ? (stageFilesToCommit || []).filter((filePath) => fileStatusByPath.has(filePath))
            : filesToCommit.filter((filePath) => {
              const fileStatus = fileStatusByPath.get(filePath);
              if (!fileStatus) {
                return false;
              }

              const alreadyFullyStaged = fileStatus.index !== ' ' && fileStatus.working_dir === ' ';
              return !alreadyFullyStaged;
            });

          if (filesNeedingAdd.length > 0) {
            await git.raw(['add', '--', ...filesNeedingAdd]);
          }
        }

        const commitArgs =
          !commitFromIndexOnly && !options.addAll && filesToCommit.length > 0
            ? filesToCommit
            : undefined;

        let result;
        try {
          result = await git.commit(message, commitArgs);
        } catch (error) {
          const gitErrorText = parseGitErrorText(error);
          const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
          if (!isPathspecError || !commitArgs || commitArgs.length === 0) {
            throw error;
          }

          // Fallback for deleted/stale selections: commit currently staged changes.
          result = await git.commit(message);
        }

        if (temporarilyUnstagedFiles.length > 0) {
          await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
            console.error('Failed to restore temporarily unstaged files:', restoreError);
          });
        }

        return {
          success: true,
          commit: result.commit,
          branch: result.branch,
          summary: result.summary
        };
      } catch (error) {
        if (temporarilyUnstagedFiles.length > 0) {
          await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
            console.error('Failed to restore temporarily unstaged files after commit failure:', restoreError);
          });
        }
        console.error('Failed to commit:', error);
        throw error;
      }
    });
  }

  return {
    isAncestorOfHead,
    listUntrackedPaths,
    getUntrackedDiffs,
    listStashes,
    countStashFiles,
    stashPush,
    stashApply,
    stashDrop,
    stashPop,
    commit,
  };
}
