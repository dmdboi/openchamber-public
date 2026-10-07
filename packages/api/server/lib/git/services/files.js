import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const fsp = fs.promises;
const execFileAsync = promisify(execFile);

export function createFileService({
  createRepositoryGitContext,
  createGit,
  getGitBinary,
  getDiff,
  resolveGitFileContext,
  resolveGitRepositoryRoot,
  normalizeDirectoryPath,
  normalizeFilePathList,
  validateRepositoryFilePaths,
  withGitIndexMutationQueue,
  runGitCommand,
  readSubmoduleState,
  parseGitErrorText,
}) {
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

const BINARY_SNIFF_BYTES = 8192;

function isImageFile(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

function getImageMimeType(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

const parseIsBinaryFromNumstat = (raw) => {
  const text = String(raw || '').trim();
  if (!text) {
    return false;
  }

  // Expected format: <added>\t<deleted>\t<path>
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const [added, deleted] = firstLine.split('\t');
  return added === '-' || deleted === '-';
};

const looksBinaryBySniff = async (absolutePath) => {
  try {
    const handle = await fsp.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      if (bytesRead <= 0) {
        return false;
      }
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const isBinaryDiff = async (directoryPath, filePath, staged) => {
  // Fast path: ask git for numstat. For binary, it returns "-\t-\t<path>".
  const args = ['diff', '--numstat'];
  if (staged) {
    args.push('--cached');
  }
  args.push('--', filePath);

  const result = await runGitCommand(directoryPath, args);
  if (parseIsBinaryFromNumstat(result.stdout)) {
    return true;
  }

  // Fallback for untracked files (diff output is empty): use --no-index against /dev/null
  if (!staged) {
    const tracked = await runGitCommand(directoryPath, ['ls-files', '--error-unmatch', '--', filePath]).then((r) => r.success);
    if (!tracked) {
      const noIndex = await runGitCommand(directoryPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
      if (parseIsBinaryFromNumstat(noIndex.stdout) || parseIsBinaryFromNumstat(noIndex.stderr) || parseIsBinaryFromNumstat(noIndex.message)) {
        return true;
      }
      const text = `${noIndex.stdout || ''}\n${noIndex.stderr || ''}\n${noIndex.message || ''}`.toLowerCase();
      if (text.includes('binary files') || text.includes('git binary patch')) {
        return true;
      }
    }
  }

  return false;
};

async function getFileDiff(directory, { path: filePath, staged = false } = {}) {
  if (!directory || !filePath) {
    throw new Error('directory and path are required for getFileDiff');
  }

  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  const isImage = isImageFile(filePath);
  const mimeType = isImage ? getImageMimeType(filePath) : null;
  const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
  const { absolutePath, repoPath, isSymbolicLink } = fileContext;

  if (fileContext.isSubmodule) {
    // Git's own text form of a gitlink, so a plain two-pane view still shows
    // the recorded commits; `submodule` carries what the text cannot.
    const submodule = await readSubmoduleState(repoRoot, fileContext);
    const describeCommit = (commit) => (commit ? `Subproject commit ${commit}\n` : '');
    return {
      original: describeCommit(submodule.headCommit),
      modified: describeCommit(staged ? submodule.indexCommit : submodule.worktreeCommit),
      path: filePath,
      isBinary: false,
      submodule,
    };
  }

  if (!isImage && !isSymbolicLink) {
    const isBinaryBySniff = await looksBinaryBySniff(absolutePath);
    const isBinary = isBinaryBySniff || (await isBinaryDiff(repoRoot, repoPath, staged));
    if (isBinary) {
      return {
        original: '',
        modified: '',
        path: filePath,
        isBinary: true,
      };
    }
  }

  let original = '';
  try {
    if (isImage) {
      // For images, use git show with raw output and convert to base64
      try {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `HEAD:${repoPath}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024, // 50MB max
        });
        if (stdout && stdout.length > 0) {
          original = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } catch {
        original = '';
      }
    } else {
      original = await git.show([`HEAD:${repoPath}`]);
    }
  } catch {
    original = '';
  }

  let modified = '';
  try {
    if (staged) {
      if (isImage) {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `:${repoPath}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        });
        if (stdout && stdout.length > 0) {
          modified = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } else {
        modified = await git.show([`:${repoPath}`]);
      }
    } else {
      if (isSymbolicLink) {
        modified = await fsp.readlink(absolutePath);
      } else {
        const stat = await fsp.stat(absolutePath);
        if (!stat.isFile()) {
          return {
            original: typeof original === 'string' ? original.replace(/\r\n/g, '\n') : original,
            modified: '',
            path: filePath,
            isBinary: false,
          };
        }
        if (isImage) {
          // For images, read as binary and convert to data URL
          const buffer = await fsp.readFile(absolutePath);
          modified = `data:${mimeType};base64,${buffer.toString('base64')}`;
        } else {
          modified = await fsp.readFile(absolutePath, 'utf8');
        }
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      modified = '';
    } else {
      console.error('Failed to read modified file contents for diff:', error);
      throw error;
    }
  }

  return {
    original: typeof original === 'string' ? original.replace(/\r\n/g, '\n') : original,
    modified: typeof modified === 'string' ? modified.replace(/\r\n/g, '\n') : modified,
    path: filePath,
    isBinary: false,
  };
}

async function revertFile(directory, filePath, options = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const scope = options?.scope === 'working' ? 'working' : 'all';
    const directoryPath = normalizeDirectoryPath(directory);
    const directoryGit = await createGit(directoryPath);
    const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
    const { absolutePath, repoPath } = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    const git = await createGit(repoRoot);

    const isTracked = await git
      .raw(['ls-files', '--error-unmatch', '--', repoPath])
      .then(() => true)
      .catch(() => false);

    if (!isTracked) {
      try {
        await git.raw(['clean', '-f', '-d', '--', repoPath]);
        return;
      } catch (cleanError) {
        try {
          await fsp.rm(absolutePath, { recursive: true, force: true });
          return;
        } catch (fsError) {
          if (fsError && typeof fsError === 'object' && fsError.code === 'ENOENT') {
            return;
          }
          console.error('Failed to remove untracked file during revert:', fsError);
          throw fsError;
        }
      }
    }

    if (scope === 'all') {
      try {
        await git.raw(['restore', '--staged', '--', repoPath]);
      } catch (error) {
        await git.raw(['reset', 'HEAD', '--', repoPath]).catch(() => {});
      }
    }

    try {
      await git.raw(['restore', '--', repoPath]);
    } catch (error) {
      try {
        await git.raw(['checkout', '--', repoPath]);
      } catch (fallbackError) {
        console.error('Failed to revert git file:', fallbackError);
        throw fallbackError;
      }
    }
  });
}

const HUNK_ACTION_FLAGS = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
};

const parsePatchPathToken = (line) => {
  const value = String(line || '').replace(/^(?:-{3}|\+{3})\s+/, '');
  if (!value || value === '/dev/null') {
    return null;
  }

  if (value.startsWith('"')) {
    let token = '"';
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index];
      token += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }

    try {
      return JSON.parse(token);
    } catch {
      return token.slice(1, token.endsWith('"') ? -1 : undefined);
    }
  }

  return value.split('\t', 1)[0] || null;
};

const normalizePatchTargetPath = (value) => {
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
};

const extractPatchTargetPath = (patch) => {
  const firstHunk = patch.search(/^@@\s/m);
  const header = firstHunk < 0 ? patch : patch.slice(0, firstHunk);
  const matches = [...header.matchAll(/^(?:-{3}|\+{3})\s+.+$/gm)];
  const realTargets = matches
    .map((match) => normalizePatchTargetPath(parsePatchPathToken(match[0])))
    .filter(Boolean);
  return realTargets.at(-1) || null;
};

const writeTempPatchFile = async (patch) => {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `openchamber-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  await fsp.writeFile(tmpPath, patch, 'utf8');
  return tmpPath;
};

async function applyHunk(directory, filePath, options = {}) {
  const action = options?.action;
  if (!action || !HUNK_ACTION_FLAGS[action]) {
    throw new Error('Invalid hunk action');
  }
  const patch = typeof options?.patch === 'string' ? options.patch : '';
  if (!patch.trim()) {
    throw new Error('patch is required to apply a hunk');
  }
  if (!/^@@\s/m.test(patch)) {
    throw new Error('patch does not contain a hunk header');
  }

  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    validateRepositoryFilePaths(repoRoot, [fileContext.repoPath]);

    // Applicability alone is insufficient: a previously staged or committed
    // hunk may still reverse cleanly against the working tree. Accept only a
    // canonical hunk from this file's current working/index diff.
    const current = await getDiff(directory, { path: filePath, staged: action === 'unstage', contextLines: 3 });
    const starts = [...current.matchAll(/^@@\s/gm)].map((match) => match.index);
    const header = current.slice(0, starts[0] ?? 0);
    const isCurrentHunk = starts.some((start, index) => (
      header + current.slice(start, starts[index + 1] ?? current.length) === patch
    ));
    if (!isCurrentHunk) {
      const targetPath = extractPatchTargetPath(patch);
      if (targetPath && targetPath !== fileContext.repoPath && targetPath !== filePath) {
        throw new Error('patch target path does not match the requested file');
      }
      throw new Error('Hunk no longer applies — refresh and try again.');
    }

    const flags = HUNK_ACTION_FLAGS[action];
    let tmpPath = null;
    try {
      tmpPath = await writeTempPatchFile(patch);

      try {
        await git.raw(['apply', ...flags, '--check', tmpPath]);
      } catch (checkError) {
        const text = parseGitErrorText(checkError);
        throw new Error(
          text
            ? `Hunk no longer applies — refresh and try again.\n${text}`
            : 'Hunk no longer applies — refresh and try again.'
        );
      }

      await git.raw(['apply', ...flags, tmpPath]);
    } finally {
      if (tmpPath) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  });
}

async function stageFiles(directory, paths) {
  if (!directory) {
    throw new Error('directory and path are required for stageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for stageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['add', '--', ...repoPaths]).catch(async (error) => {
      const gitErrorText = parseGitErrorText(error);
      const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
      if (!isPathspecError) {
        throw error;
      }

      // During rapid stage/unstage toggling the optimistic UI can request staging a
      // path that a prior queued mutation already staged (most visibly a deletion,
      // whose file is gone from the working tree). `git add` aborts the whole batch
      // on a single unmatched pathspec, so retry per-path and skip the ones already
      // in their target state rather than failing the entire "stage all".
      for (const repoPath of repoPaths) {
        await git.raw(['add', '--', repoPath]).catch((perPathError) => {
          const perPathText = parseGitErrorText(perPathError);
          const perPathIsPathspecError =
            perPathText.includes('pathspec') && perPathText.includes('did not match any files');
          if (!perPathIsPathspecError) {
            throw perPathError;
          }
        });
      }
    });
  });
}

async function unstageFiles(directory, paths) {
  if (!directory) {
    throw new Error('directory and path are required for unstageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for unstageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['restore', '--staged', '--', ...repoPaths]).catch(async () => {
      await git.raw(['reset', 'HEAD', '--', ...repoPaths]);
    });
  });
}


  return { getFileDiff, revertFile, applyHunk, stageFiles, unstageFiles };
}
