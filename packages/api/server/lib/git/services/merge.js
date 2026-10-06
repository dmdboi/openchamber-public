export function createMergeService({ createRepositoryGitContext, runGitCommandWithoutEditor, resolveGitInternalPath, fsp }) {
  async function rebase(directory, options = {}) {
    const { git } = await createRepositoryGitContext(directory);
    try {
      const { onto } = options;
      if (!onto) throw new Error('onto parameter is required for rebase');
      await git.rebase([onto]);
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') || errorMessage.includes('could not apply') || errorMessage.includes('merge conflict');
      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return { success: false, conflict: true, conflictFiles: status.conflicted || [] };
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
      if (!branch) throw new Error('branch parameter is required for merge');
      await git.merge([branch]);
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') || errorMessage.includes('merge conflict') || errorMessage.includes('automatic merge failed');
      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return { success: false, conflict: true, conflictFiles: status.conflicted || [] };
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
      if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes')) {
        try {
          await runGitCommandWithoutEditor(repoRoot, ['rebase', '--skip']);
          return { success: true, conflict: false };
        } catch {
          const status = await git.status().catch(() => ({ conflicted: [] }));
          if (status.conflicted && status.conflicted.length > 0) return { success: false, conflict: true, conflictFiles: status.conflicted };
          return { success: true, conflict: false };
        }
      }
      const isConflict = errorMessage.includes('conflict') || errorMessage.includes('needs merge') || errorMessage.includes('unmerged') || errorMessage.includes('fix conflicts');
      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return { success: false, conflict: true, conflictFiles: status.conflicted || [] };
      }
      console.error('Failed to continue rebase:', error);
      throw error;
    }
  }

  async function continueMerge(directory) {
    const { git } = await createRepositoryGitContext(directory);
    try {
      const status = await git.status();
      if (status.conflicted && status.conflicted.length > 0) return { success: false, conflict: true, conflictFiles: status.conflicted };
      await git.commit([], { '--no-edit': null });
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict = errorMessage.includes('conflict') || errorMessage.includes('needs merge') || errorMessage.includes('unmerged') || errorMessage.includes('fix conflicts');
      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return { success: false, conflict: true, conflictFiles: status.conflicted || [] };
      }
      if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes added')) return { success: true, conflict: false };
      console.error('Failed to continue merge:', error);
      throw error;
    }
  }

  async function getConflictDetails(directory) {
    const { repoRoot, git } = await createRepositoryGitContext(directory);
    try {
      const statusPorcelain = await git.raw(['status', '--porcelain']).catch(() => '');
      const unmergedFilesRaw = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      const unmergedFiles = unmergedFilesRaw.split('\n').map((line) => line.trim()).filter(Boolean);
      const diff = await git.raw(['diff']).catch(() => '');
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
        if (rebaseHead) { operation = 'rebase'; headInfo = `REBASE_HEAD: ${rebaseHead}`; }
      }
      return { statusPorcelain: statusPorcelain.trim(), unmergedFiles, diff: diff.trim(), headInfo: headInfo.trim(), operation };
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      throw error;
    }
  }

  return { rebase, abortRebase, merge, abortMerge, continueRebase, continueMerge, getConflictDetails };
}
