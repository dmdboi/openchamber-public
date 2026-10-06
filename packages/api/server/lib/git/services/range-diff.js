import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createRangeDiffService({
  createGit,
  createRepositoryGitContext,
  resolveGitFileContext,
  gitPathNotFound,
  isInsideOrSameDirectory,
  toGitPath,
}) {
  const fsp = fs.promises;

  const refResolvesToCommit = async (git, ref) => git
    .raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    .then((value) => Boolean(String(value || '').trim()))
    .catch(() => false);

  async function assertRangeRefsResolve(git, refs) {
    for (const ref of refs) {
      if (!(await refResolvesToCommit(git, ref))) {
        throw new Error(`Ref "${ref}" is not available locally. Fetch it before comparing.`);
      }
    }
  }

  // A private index lets git include untracked paths in the same tree comparison
  // as tracked files, including a staged deletion recreated at the same path.
  // Intent-to-add records only their existence; diff reads current file contents.
  async function runWorkingTreeRangeDiff(context, baseRef, headRef, args, paths = []) {
    const { git, repoRoot } = context;
    const readHead = async () => {
      const commit = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
      const ref = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
      return `${commit}\n${ref}`;
    };
    const startingHead = await readHead();
    const [headCommit, currentRef] = startingHead.split('\n');
    const requestedRef = (await git.raw(['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', headRef])).trim();
    if (requestedRef !== currentRef) {
      throw new Error('Working-tree comparisons require the checked-out branch. Refresh and try again.');
    }
    const mergeBase = (await git.raw(['merge-base', baseRef, headCommit])).trim();
    const readDiff = async (comparisonGit) => {
      const diff = await comparisonGit.raw([...args, mergeBase, '--', ...paths]);
      if (await readHead() !== startingHead) {
        throw new Error('The checked-out branch changed during comparison. Refresh and try again.');
      }
      return diff;
    };
    const untracked = await git.raw(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]);
    if (!untracked) return readDiff(git);

    const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-branch-diff-'));
    try {
      const indexPath = (await git.raw(['rev-parse', '--git-path', 'index'])).trim();
      const temporaryIndex = path.join(temporaryDirectory, 'index');
      await fsp.copyFile(path.resolve(repoRoot, indexPath), temporaryIndex);
      const pathspecFile = path.join(temporaryDirectory, 'paths');
      await fsp.writeFile(pathspecFile, untracked);
      const comparisonGit = await createGit(repoRoot);
      comparisonGit.env('GIT_INDEX_FILE', temporaryIndex);
      comparisonGit.env('GIT_LITERAL_PATHSPECS', '1');
      await comparisonGit.raw(['add', '--intent-to-add', '--pathspec-from-file=' + pathspecFile, '--pathspec-file-nul']);
      return await readDiff(comparisonGit);
    } finally {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async function getRangeDiff(directory, { base, head, path: filePath, contextLines = 3, includeWorkingTree = false } = {}) {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const baseRef = typeof base === 'string' ? base.trim() : '';
    const headRef = typeof head === 'string' ? head.trim() : '';
    if (!baseRef || !headRef) throw new Error('base and head are required');

    await assertRangeRefsResolve(git, [baseRef, headRef]);

    const args = ['diff', '--no-color'];
    if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
      args.push(`-U${Math.max(0, contextLines)}`);
    }
    const paths = [];
    if (filePath) {
      try {
        const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
        paths.push(fileContext.repoPath);
      } catch (error) {
        if (error.code !== gitPathNotFound) throw error;
        // A committed deletion is absent from HEAD, the index, and the working
        // tree. It is still a valid range path when it exists at the merge base.
        const mergeBase = (await git.raw(['merge-base', baseRef, headRef])).trim();
        for (const root of new Set([repoRoot, directoryPath])) {
          const target = path.resolve(root, filePath);
          if (!isInsideOrSameDirectory(repoRoot, target)) continue;
          const repoPath = toGitPath(path.relative(repoRoot, target));
          const exists = await git.raw(['cat-file', '-e', `${mergeBase}:${repoPath}`]).then(() => true).catch(() => false);
          if (exists) {
            paths.push(repoPath);
            break;
          }
        }
        if (paths.length === 0) throw error;
      }
    }
    if (includeWorkingTree) return runWorkingTreeRangeDiff({ git, repoRoot }, baseRef, headRef, args, paths);
    args.push(`${baseRef}...${headRef}`, '--', ...paths);
    return git.raw(args);
  }

  async function getRangeFiles(directory, { base, head, includeWorkingTree = false } = {}) {
    const { git, repoRoot } = await createRepositoryGitContext(directory);
    const baseRef = typeof base === 'string' ? base.trim() : '';
    const headRef = typeof head === 'string' ? head.trim() : '';
    if (!baseRef || !headRef) throw new Error('base and head are required');

    await assertRangeRefsResolve(git, [baseRef, headRef]);

    // `-C` detects copies among changed files only; rename detection is on by default.
    const args = ['diff', '--name-status', '-z', '-C'];
    const raw = includeWorkingTree
      ? await runWorkingTreeRangeDiff({ git, repoRoot }, baseRef, headRef, args)
      : await git.raw([...args, `${baseRef}...${headRef}`, '--']);
    const tokens = String(raw || '').split('\0');
    const files = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const status = (tokens[index] || '').trim();
      if (!status) continue;
      const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
      const filePath = isRenameOrCopy ? (tokens[index + 2] || '') : (tokens[index + 1] || '');
      index += isRenameOrCopy ? 2 : 1;
      if (filePath) files.push({ path: filePath, status: status.charAt(0) });
    }
    return files;
  }

  return { getRangeDiff, getRangeFiles };
}
