import path from 'node:path';

export function createHistoryService({
    createRepositoryGitContext,
    runGitCommandOrThrow,
    runGitCommand,
    resolveGitFileContext,
    toGitPath,
  }) {
  async function resolveGitCommitFilePath(repoRoot, hash, candidates) {
    for (const candidate of candidates) {
      const [originalTreeResult, modifiedTreeResult] = await Promise.all([
        runGitCommand(repoRoot, ['ls-tree', '--name-only', `${hash}^`, '--', candidate]),
        runGitCommand(repoRoot, ['ls-tree', '--name-only', hash, '--', candidate]),
      ]);
      if ((originalTreeResult.success && originalTreeResult.stdout.trim()) || (modifiedTreeResult.success && modifiedTreeResult.stdout.trim())) {
        return candidate;
      }
    }
    throw new Error('Invalid file path');
  }

  /**
   * Resolve a log base ref using local-first semantics.
   *
   * - If `from` is falsy / whitespace → return undefined.
   * - If the local ref resolves → return it unchanged (caller's intent preserved).
   * - If the local ref is absent but `origin/<from>` exists → return `origin/<from>`
   *   (common when the user has never checked out the base branch locally).
   * - If neither resolves → return `from` unchanged so git surfaces a meaningful error.
   *
   * @param {string | undefined} from   - The raw `from` option value.
   * @param {(ref: string) => Promise<boolean>} checkRef - Returns true when the ref resolves.
   * @returns {Promise<string | undefined>}
   */
  async function resolveBaseRefForLog(from, checkRef) {
    const normalized = typeof from === 'string' ? from.trim() : undefined;
    if (!normalized) return undefined;

    if (await checkRef(normalized)) return normalized;

    const originRef = `refs/remotes/origin/${normalized}`;
    if (await checkRef(originRef)) return `origin/${normalized}`;

    return normalized;
  }

  async function getCommitSummaries(directory, shas) {
    const commits = Array.isArray(shas)
      ? shas.map((sha) => String(sha || '').trim()).filter(Boolean)
      : [];
    if (commits.length === 0) {
      return { commits: [] };
    }
    if (commits.some((sha) => !/^[0-9a-fA-F]{4,64}$/.test(sha))) {
      throw new Error('Invalid commit SHA');
    }
    const result = await runGitCommandOrThrow(
      directory,
      ['show', '-s', '--format=%H%x09%h%x09%s', ...commits, '--'],
      'Failed to get commit summaries'
    );
    const parsed = String(result.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, short, subject] = line.split('\t');
        return { sha: sha || '', short: short || '', subject: subject || '' };
      })
      .filter((entry) => entry.sha && entry.short);
    return { commits: parsed };
  }

  async function getLog(directory, options = {}) {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);

    try {
      const maxCount = options.maxCount || 50;

      if (options.all) {
        const logArgs = [
          'log',
          `--max-count=${maxCount}`,
          '--all',
          '--topo-order',
          '--date=iso',
          '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
          '--shortstat',
        ];

        const rawLog = await git.raw(logArgs);
        const records = rawLog
          .split('\x1e')
          .map((e) => e.trim())
          .filter(Boolean);

        const entries = [];
        for (const record of records) {
          const lines = record.split('\n').filter((l) => l.trim().length > 0);
          const header = lines.shift() || '';
          const [hash, parentsRaw, author_name, author_email, date, message, refsRaw] =
            header.split('\x1f');
          if (!hash) continue;

          const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
          const refs = refsRaw ? refsRaw.trim() : '';

          let filesChanged = 0;
          let insertions = 0;
          let deletions = 0;
          for (const line of lines) {
            const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
            const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
            const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);
            if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
            if (insertMatch) insertions = parseInt(insertMatch[1], 10);
            if (deleteMatch) deletions = parseInt(deleteMatch[1], 10);
          }

          entries.push({
            hash,
            date: date || '',
            message: message || '',
            refs,
            body: '',
            author_name: author_name || '',
            author_email: author_email || '',
            filesChanged,
            insertions,
            deletions,
            parents,
          });
        }

        return { all: entries, latest: entries[0] || null, total: entries.length };
      }

      const filePath = options.file
        ? (await resolveGitFileContext(directoryPath, directoryGit, options.file, repoRoot)).repoPath
        : undefined;

      // Prefer the local ref; fall back to origin/<from> only when the local ref
      // cannot be resolved (e.g. user has never checked out the base branch).
      const checkRef = async (ref) => {
        try {
          const out = await git.raw(['rev-parse', '--verify', ref]);
          return Boolean(out && out.trim());
        } catch {
          return false;
        }
      };
      // A fresh `git init` sits on a branch with no commits yet: HEAD names a
      // branch that does not resolve. Its history is empty, not an error.
      if (!options.to && !(await checkRef('HEAD'))) {
        const unborn = await git.raw(['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false);
        if (unborn) return { all: [], latest: null, total: 0 };
      }

      const resolvedFrom = await resolveBaseRefForLog(options.from, checkRef);

      // simple-git's `to` alone means HEAD..to, which is empty for the current
      // branch. A single requested ref means its reachable history instead.
      const baseLog = options.to && !resolvedFrom
        ? await git.log([`--max-count=${maxCount}`, options.to, ...(filePath ? ['--', filePath] : [])])
        : await git.log({ maxCount, from: resolvedFrom, to: options.to, file: filePath });

      const logArgs = [
        'log',
        `--max-count=${maxCount}`,
        '--date=iso',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s',
        '--shortstat'
      ];

      if (resolvedFrom && options.to) {
        logArgs.push(`${resolvedFrom}..${options.to}`);
      } else if (resolvedFrom) {
        logArgs.push(`${resolvedFrom}..HEAD`);
      } else if (options.to) {
        logArgs.push(options.to);
      }

      if (filePath) {
        logArgs.push('--', filePath);
      }

      const rawLog = await git.raw(logArgs);
      const records = rawLog
        .split('\x1e')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const statsMap = new Map();

      records.forEach((record) => {
        const lines = record.split('\n').filter((line) => line.trim().length > 0);
        const header = lines.shift() || '';
        const [hash, parentsRaw] = header.split('\x1f');
        const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
        if (!hash) {
          return;
        }

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        lines.forEach((line) => {
          const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
          const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
          const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);

          if (filesMatch) {
            filesChanged = parseInt(filesMatch[1], 10);
          }
          if (insertMatch) {
            insertions = parseInt(insertMatch[1], 10);
          }
          if (deleteMatch) {
            deletions = parseInt(deleteMatch[1], 10);
          }
        });

        statsMap.set(hash, { filesChanged, insertions, deletions, parents });
      });

      const merged = baseLog.all.map((entry) => {
        const stats = statsMap.get(entry.hash) || { filesChanged: 0, insertions: 0, deletions: 0, parents: [] };
        return {
          hash: entry.hash,
          date: entry.date,
          message: entry.message,
          refs: entry.refs || '',
          body: entry.body || '',
          author_name: entry.author_name,
          author_email: entry.author_email,
          filesChanged: stats.filesChanged,
          insertions: stats.insertions,
          deletions: stats.deletions,
          parents: stats.parents || [],
        };
      });

      return {
        all: merged,
        latest: merged[0] || null,
        total: baseLog.total
      };
    } catch (error) {
      console.error('Failed to get log:', error);
      throw error;
    }
  }

  async function resolveCommitHash(git, hash) {
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('A commit hash is required');
    return (await git.raw(['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
  }

  const commitShowArgs = (hash) => ['show', '--format=', '--root', '--diff-merges=first-parent', '--find-renames', hash];

  async function getCommitDiff(directory, { hash, path: filePath, previousPath, contextLines = 3 } = {}) {
    const { git } = await createRepositoryGitContext(directory);
    const commit = await resolveCommitHash(git, hash);
    const paths = [filePath, previousPath].filter(Boolean).map((value) => `:(literal)${value}`);
    return git.raw([
      ...commitShowArgs(commit), '--no-color', '--no-ext-diff', `-U${Math.max(0, contextLines)}`,
      '--', ...paths,
    ]);
  }

  async function getCommitFiles(directory, commitHash) {
    const { git } = await createRepositoryGitContext(directory);
    const hash = await resolveCommitHash(git, commitHash);
    const [numstat, nameStatus] = await Promise.all([
      git.raw([...commitShowArgs(hash), '--numstat', '-z', '--']),
      git.raw([...commitShowArgs(hash), '--name-status', '-z', '--']),
    ]);
    const stats = new Map();
    const tokens = numstat.split('\0');
    for (let index = 0; index < tokens.length; index += 1) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]);
      if (!match) continue;
      let destination = match[3];
      if (!destination) {
        destination = tokens[index + 2];
        index += 2;
      }
      stats.set(destination, {
        insertions: Number.parseInt(match[1], 10) || 0,
        deletions: Number.parseInt(match[2], 10) || 0,
        isBinary: match[1] === '-',
      });
    }
    const files = [];
    const names = nameStatus.split('\0');
    for (let index = 0; index < names.length; index += 1) {
      const changeType = names[index].charAt(0);
      if (!changeType) continue;
      const renamed = changeType === 'R' || changeType === 'C';
      const previousPath = renamed ? names[++index] : undefined;
      const filePath = names[++index];
      const fileStats = stats.get(filePath);
      if (!filePath || !fileStats) throw new Error('Incomplete commit file statistics');
      const entry = { path: filePath, ...fileStats, changeType };
      if (previousPath) entry.previousPath = previousPath;
      files.push(entry);
    }
    return { files };
  }

  async function getCommitFileDiff(directory, hash, filePath, isBinary) {
    if (!directory || !hash || !filePath) {
      throw new Error('directory, hash, and path are required for getCommitFileDiff');
    }

    if (isBinary) {
      return { original: '', modified: '', isBinary: true };
    }

    const { directoryPath, repoRoot } = await createRepositoryGitContext(directory);
    const candidates = Array.from(new Set([
      toGitPath(path.relative(repoRoot, path.resolve(repoRoot, filePath))),
      toGitPath(path.relative(repoRoot, path.resolve(directoryPath, filePath))),
    ])).filter((candidate) => candidate && !candidate.startsWith('..') && !path.isAbsolute(candidate));

    let originalResult = null;
    let modifiedResult = null;

    for (const candidate of candidates) {
      const [candidateOriginalResult, candidateModifiedResult] = await Promise.all([
        runGitCommand(repoRoot, ['show', `${hash}^:${candidate}`]),
        runGitCommand(repoRoot, ['show', `${hash}:${candidate}`]),
      ]);

      if (candidateOriginalResult.success || candidateModifiedResult.success) {
        originalResult = candidateOriginalResult;
        modifiedResult = candidateModifiedResult;
        break;
      }
    }

    if (!originalResult || !modifiedResult) {
      const resolvedPath = await resolveGitCommitFilePath(repoRoot, hash, candidates);
      [originalResult, modifiedResult] = await Promise.all([
        runGitCommand(repoRoot, ['show', `${hash}^:${resolvedPath}`]),
        runGitCommand(repoRoot, ['show', `${hash}:${resolvedPath}`]),
      ]);
    }

    const original = originalResult.success ? originalResult.stdout : '';
    const modified = modifiedResult.success ? modifiedResult.stdout : '';

    if (!originalResult.success && !modifiedResult.success) {
      throw new Error(`Failed to read file content at commit ${hash}: ${originalResult.stderr || modifiedResult.stderr}`);
    }

    return { original, modified, isBinary: false };
  }

  return { resolveBaseRefForLog, getLog, getCommitSummaries, getCommitDiff, getCommitFiles, getCommitFileDiff };
}
