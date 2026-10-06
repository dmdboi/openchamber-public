import { promises as fsp } from 'node:fs';

export function createMergeService({ createRepositoryGitContext, runGitCommandWithoutEditor, resolveGitInternalPath }) {
  async function rebase(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const { onto } = options;
      if (!onto) {
        throw new Error('onto parameter is required for rebase');
      }

      await git.rebase([onto]);

      return {
        success: true,
        conflict: false
      };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') ||
                         errorMessage.includes('could not apply') ||
                         errorMessage.includes('merge conflict');

      if (isConflict) {
        // Get list of conflicted files
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || []
        };
      }

      console.error('Failed to rebase:', error);
      throw error;
    }
  }

  async function abortRebase(directory) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      await git.rebase(['--abort']);
      return { success: true };
    } catch (error) {
      console.error('Failed to abort rebase:', error);
      throw error;
    }
  }

  async function merge(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const { branch } = options;
      if (!branch) {
        throw new Error('branch parameter is required for merge');
      }

      await git.merge([branch]);

      return {
        success: true,
        conflict: false
      };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') ||
                         errorMessage.includes('merge conflict') ||
                         errorMessage.includes('automatic merge failed');

      if (isConflict) {
        // Get list of conflicted files
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || []
        };
      }

      console.error('Failed to merge:', error);
      throw error;
    }
  }

  async function abortMerge(directory) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      await git.merge(['--abort']);
      return { success: true };
    } catch (error) {
      console.error('Failed to abort merge:', error);
      throw error;
    }
  }

  async function continueRebase(directory) {
    const { git, repoRoot } = await createRepositoryGitContext(directory);

    try {
      await runGitCommandWithoutEditor(repoRoot, ['rebase', '--continue']);
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();

      // Check for "nothing to commit" which means rebase step is complete. Git's
      // hints for this case mention resolving conflicts, so check it first.
      if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes')) {
        // Skip this commit and continue
        try {
          await runGitCommandWithoutEditor(repoRoot, ['rebase', '--skip']);
          return { success: true, conflict: false };
        } catch {
          // Skipping applies the next commit, which can conflict too
          const status = await git.status().catch(() => ({ conflicted: [] }));
          if (status.conflicted && status.conflicted.length > 0) {
            return {
              success: false,
              conflict: true,
              conflictFiles: status.conflicted
            };
          }
          // If skip also fails, the rebase may be complete
          return { success: true, conflict: false };
        }
      }

      const isConflict = errorMessage.includes('conflict') ||
                         errorMessage.includes('needs merge') ||
                         errorMessage.includes('unmerged') ||
                         errorMessage.includes('fix conflicts');

      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || []
        };
      }

      console.error('Failed to continue rebase:', error);
      throw error;
    }
  }

  async function continueMerge(directory) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      // Check if there are still unmerged files
      const status = await git.status();
      if (status.conflicted && status.conflicted.length > 0) {
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted
        };
      }

      // For merge, we commit after resolving conflicts
      // Use --no-edit to use the default merge commit message
      await git.commit([], { '--no-edit': null });
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') ||
                         errorMessage.includes('needs merge') ||
                         errorMessage.includes('unmerged') ||
                         errorMessage.includes('fix conflicts');

      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || []
        };
      }

      // "nothing to commit" can happen if all conflicts resolved to one side
      if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes added')) {
        // The merge is effectively complete (all changes already committed or no changes needed)
        return { success: true, conflict: false };
      }

      console.error('Failed to continue merge:', error);
      throw error;
    }
  }

  async function getConflictDetails(directory) {
    const { repoRoot, git } = await createRepositoryGitContext(directory);

    try {
      // Get git status --porcelain
      const statusPorcelain = await git.raw(['status', '--porcelain']).catch(() => '');

      // Get unmerged files
      const unmergedFilesRaw = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      const unmergedFiles = unmergedFilesRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      // Get current diff
      const diff = await git.raw(['diff']).catch(() => '');

      // simple-git resolves a quiet `rev-parse --verify` miss with empty output instead of rejecting.
      let operation = 'merge';
      let headInfo = '';

      const mergeHead = (await git.raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim();

      if (mergeHead) {
        operation = 'merge';
        const mergeMsgPath = await resolveGitInternalPath(repoRoot, git, 'MERGE_MSG').catch(() => '');
        const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
        headInfo = `MERGE_HEAD: ${mergeHead}\n${mergeMsg}`;
      } else {
        const rebaseHead = (await git.raw(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).catch(() => '')).trim();

        if (rebaseHead) {
          operation = 'rebase';
          headInfo = `REBASE_HEAD: ${rebaseHead}`;
        }
      }

      return {
        statusPorcelain: statusPorcelain.trim(),
        unmergedFiles,
        diff: diff.trim(),
        headInfo: headInfo.trim(),
        operation,
      };
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      throw error;
    }
  }

  return { rebase, abortRebase, merge, abortMerge, continueRebase, continueMerge, getConflictDetails };
}
