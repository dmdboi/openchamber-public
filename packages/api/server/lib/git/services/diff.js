import fs from 'node:fs';

export function createDiffService({
  createRepositoryGitContext,
  readSubmoduleState,
  resolveGitFileContext,
  runGitCommand,
}) {
  const fsp = fs.promises;

  const getNoIndexDiff = async (repoRoot, repoPath, contextLines) => {
    const args = ['diff', '--no-color', '--full-index'];
    if (Number.isFinite(contextLines)) {
      args.push(`-U${Math.max(0, contextLines)}`);
    }
    args.push('--no-index', '--', '/dev/null', repoPath);
    const result = await runGitCommand(repoRoot, args);
    // Exit 1 means differences, even when Git also writes warnings to stderr.
    // Spawn and buffer errors have no numeric exit code and must still fail.
    if (result.exitCode === 0 || result.exitCode === 1) {
      return result.stdout;
    }
    throw new Error(result.stderr || result.message || 'Failed to get untracked Git diff');
  };

  async function getDiff(directory, { path: filePath, staged = false, contextLines = 3 } = {}) {
    const context = await createRepositoryGitContext(directory);
    const fileContext = filePath
      ? await resolveGitFileContext(context.directoryPath, context.directoryGit, filePath, context.repoRoot)
      : null;
    return readDiff(context, fileContext, { staged, contextLines });
  }

  /**
   * `getDiff` for one path, plus what a submodule records. A submodule patch is
   * empty when only untracked files changed inside it, so callers need the state
   * to show anything truthful.
   */
  async function getPathDiff(directory, { path: filePath, staged = false, contextLines = 3 } = {}) {
    const context = await createRepositoryGitContext(directory);
    const fileContext = await resolveGitFileContext(context.directoryPath, context.directoryGit, filePath, context.repoRoot);
    const diff = await readDiff(context, fileContext, { staged, contextLines });
    if (!fileContext.isSubmodule) return { diff, submodule: null };
    return { diff, submodule: await readSubmoduleState(context.repoRoot, fileContext) };
  }

  async function readDiff({ repoRoot, git }, fileContext, { staged, contextLines }) {
    try {
      const args = ['diff', '--no-color', '--full-index'];

      if (Number.isFinite(contextLines) || contextLines === Infinity || contextLines === -Infinity) {
        args.push(`-U${Math.max(0, contextLines)}`);
      }

      if (staged) {
        args.push('--cached');
      }

      if (fileContext) {
        args.push('--', fileContext.repoPath);
      }

      const diff = await git.raw(args);
      if (diff && diff.trim().length > 0) {
        return diff;
      }

      if (staged) {
        return diff;
      }

      if (!fileContext) {
        return diff;
      }

      try {
        await git.raw(['ls-files', '--error-unmatch', '--', fileContext.repoPath]);
        return diff;
      } catch {
        if (fileContext.isSymbolicLink) {
          const target = await fsp.readlink(fileContext.absolutePath);
          return [
            `diff --git a/${fileContext.repoPath} b/${fileContext.repoPath}`,
            'new file mode 120000',
            '--- /dev/null',
            `+++ b/${fileContext.repoPath}`,
            '@@ -0,0 +1 @@',
            `+${target}`,
            '\\ No newline at end of file',
            '',
          ].join('\n');
        }

        return await getNoIndexDiff(repoRoot, fileContext.repoPath, contextLines);
      }
    } catch (error) {
      console.error('Failed to get Git diff:', error);
      throw error;
    }
  }


    return { getDiff, getPathDiff, readDiff, getNoIndexDiff };
}
