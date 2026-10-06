import { carriesFileDiffs, isEditTool, isPatchTool, isWriteTool } from '@/lib/opencode/tools';
import { parsePatchFiles } from '@pierre/diffs';
import { z } from 'zod';

import { isToolDiffPreviewOversized } from './toolDiffPreview';

export type DiffPatchEntry = {
    id: string;
    title: string;
    filePath?: string;
    patch: string;
    renderMode: 'diff' | 'text';
};

const APPLY_PATCH_ENVELOPE_PATTERN = /^\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/m;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;
const GIT_DIFF_FILE_BREAK_PATTERN = /(?=^diff --git\s+)/gm;
const GIT_DIFF_FILE_BREAK_TEST = /^diff --git\s+/m;
const UNIFIED_DIFF_FILE_BREAK_PATTERN = /(?=^---\s+\S)/gm;
const UNIFIED_DIFF_FILE_BREAK_TEST = /^---\s+\S/m;

/** A text field that tolerates a missing or malformed value by becoming undefined. */
const optionalText = z.string().optional().catch(undefined);

/**
 * One `metadata.files` entry. v2 reports `file` (FileDiff.Info); `movePath`,
 * `filePath` and `relativePath` keep MCP and plugin tools that use the older
 * naming working. Malformed fields drop to undefined rather than failing the
 * whole entry, so one bad key cannot hide the rest of a file.
 */
const patchFileSchema = z.object({
    file: optionalText,
    movePath: optionalText,
    filePath: optionalText,
    relativePath: optionalText,
    patch: optionalText,
    diff: optionalText,
    type: optionalText,
    status: optionalText,
});

type PatchFile = z.infer<typeof patchFileSchema>;

const metadataSchema = z
    .object({
        files: z.array(patchFileSchema.nullable().catch(null)).optional().catch(undefined),
        patch: optionalText,
        diff: optionalText,
        filediff: z
            .object({ patch: optionalText, diff: optionalText })
            .nullable()
            .catch(null)
            .optional()
            .catch(undefined),
    })
    .catch({});

type ParsedMetadata = z.infer<typeof metadataSchema>;

const inputPathSchema = z
    .object({ path: optionalText, filePath: optionalText, file_path: optionalText })
    .catch({});

/**
 * Tool metadata and input cross an untyped wire boundary, so each reader below
 * decodes the fields it understands with these schemas. The parameters stay
 * generic because callers hold the raw `Record<string, unknown>` from the part
 * state; decoding is what turns that into a domain value.
 */
const parseMetadata = <TMetadata>(metadata: TMetadata): ParsedMetadata => metadataSchema.parse(metadata ?? {});

const readMetadataFiles = <TMetadata>(metadata: TMetadata): PatchFile[] => {
    const files = parseMetadata(metadata).files ?? [];
    return files.filter((file): file is PatchFile => file !== null);
};

const normalizePatchText = (patch: string): string => {
    return patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

const normalizeBareUnifiedHeaderLines = (patch: string): string => {
    let reachedHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            reachedHunk = true;
            return line;
        }

        if (reachedHunk) {
            return line;
        }

        const headerMatch = line.match(/^\s*(---|\+\+\+)\s+(.+)$/);
        if (!headerMatch) {
            return line;
        }

        const marker = headerMatch[1];
        const rawPath = headerMatch[2] ?? '';
        if (rawPath.trim() === '/dev/null') {
            return `${marker} /dev/null`;
        }

        return `${marker} ${rawPath.replace(/\\/g, '/')}`;
    }).join('\n');
};

const normalizeLooseUnifiedHunkBody = (patch: string): string => {
    let inHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            inHunk = true;
            return line;
        }

        if (!inHunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git')) {
            return line;
        }

        if (line.length === 0) {
            return ' ';
        }

        const first = line[0];
        if (first === ' ' || first === '+' || first === '-' || first === '\\') {
            return line;
        }

        return ` ${line}`;
    }).join('\n');
};

const formatHunkRange = (start: string, count: number): string => {
    return count === 1 ? start : `${start},${count}`;
};

const recountUnifiedHunkHeaders = (patch: string): string => {
    const lines = patch.split('\n');
    const result = [...lines];

    for (let index = 0; index < lines.length; index += 1) {
        const header = lines[index] ?? '';
        const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (!match) {
            continue;
        }

        let oldCount = 0;
        let newCount = 0;
        for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
            const line = lines[bodyIndex] ?? '';
            if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('diff --git')) {
                break;
            }

            if (line.startsWith('\\')) {
                continue;
            }

            if (line.startsWith('+')) {
                newCount += 1;
                continue;
            }

            if (line.startsWith('-')) {
                oldCount += 1;
                continue;
            }

            oldCount += 1;
            newCount += 1;
        }

        result[index] = `@@ -${formatHunkRange(match[1] ?? '0', oldCount)} +${formatHunkRange(match[2] ?? '0', newCount)} @@${match[3] ?? ''}`;
    }

    return result.join('\n');
};

const normalizeLooseUnifiedPatch = (patch: string): string => {
    return recountUnifiedHunkHeaders(normalizeLooseUnifiedHunkBody(normalizeBareUnifiedHeaderLines(normalizePatchText(patch))));
};

/**
 * Reads a patch out of a raw value: a string is the patch itself, an object
 * carries it under `patch`. Anything else answers undefined.
 */
export const getPatchText = <TValue>(value: TValue): string | undefined => {
    const direct = z.string().safeParse(value);
    if (direct.success) {
        return /\S/.test(direct.data) ? direct.data : undefined;
    }

    const nested = z.object({ patch: z.string() }).safeParse(value);
    if (!nested.success) {
        return undefined;
    }

    return /\S/.test(nested.data.patch) ? nested.data.patch : undefined;
};

/** The path a `metadata.files` entry points at, decoded from the raw entry. */
export const getApplyPatchFilePath = <TFile>(file: TFile): string | null => {
    const parsed = patchFileSchema.safeParse(file);
    if (!parsed.success) {
        return null;
    }

    // v2 reports `file` (FileDiff.Info); the other keys keep MCP and plugin
    // tools that use the older naming working.
    const { file: primary, movePath, filePath, relativePath } = parsed.data;
    return primary ?? movePath ?? filePath ?? relativePath ?? null;
};

/** v2 file tools report `path`; the other keys cover MCP and plugin tools. */
const readInputPath = <TInput>(input: TInput): string | null => {
    const parsed = inputPathSchema.parse(input ?? {});
    return parsed.path ?? parsed.filePath ?? parsed.file_path ?? null;
};

export const getPrimaryToolPath = <TInput, TMetadata>(
    toolName: string,
    input: TInput,
    metadata: TMetadata,
): string | null => {
    if (isPatchTool(toolName)) {
        for (const file of readMetadataFiles(metadata)) {
            if (file.type !== 'delete' && file.status !== 'deleted') {
                const filePath = getApplyPatchFilePath(file);
                if (filePath) {
                    return filePath;
                }
            }
        }
        return null;
    }

    if (isEditTool(toolName)) {
        const first = readMetadataFiles(metadata)[0];
        const fromMetadata = first ? getApplyPatchFilePath(first) : null;
        return fromMetadata ?? readInputPath(input);
    }

    if (isWriteTool(toolName)) {
        return readInputPath(input);
    }

    return null;
};

/** Only `edit` and `patch` results carry `metadata.files` with diffs in v2. */
const supportsDiffMetadata = (toolName: string): boolean => carriesFileDiffs(toolName);

const getMetadataFileForPath = (
    parsed: ParsedMetadata,
    preferredPath?: string,
): PatchFile | undefined => {
    const files = (parsed.files ?? []).filter((file): file is PatchFile => file !== null);
    if (!preferredPath) {
        return files[0];
    }

    return files.find((file) => (
        file.file === preferredPath
        || file.relativePath === preferredPath
        || file.filePath === preferredPath
        || file.movePath === preferredPath
    ));
};

export const getPrimaryDiffFromMetadata = <TMetadata>(
    toolName: string,
    metadata?: TMetadata,
    preferredPath?: string,
): string | undefined => {
    if (metadata === undefined || !supportsDiffMetadata(toolName)) {
        return undefined;
    }

    const parsed = parseMetadata(metadata);
    const matchedFile = getMetadataFileForPath(parsed, preferredPath);
    const filePatch = getPatchText(matchedFile?.patch) ?? getPatchText(matchedFile?.diff);
    if (filePatch) {
        return filePatch;
    }

    return getPatchText(parsed.patch) ?? getPatchText(parsed.diff);
};

/** Top-level patch a tool card falls back to when metadata carries no per-file entries. */
export const getToolFallbackDiff = <TMetadata>(metadata: TMetadata): string | undefined => {
    const parsed = parseMetadata(metadata);
    const fileDiff = parsed.filediff ?? undefined;
    return getPatchText(parsed.patch)
        ?? getPatchText(parsed.diff)
        ?? getPatchText(fileDiff?.patch)
        ?? getPatchText(fileDiff?.diff);
};

export const extractFirstChangedLineFromDiff = (diffText: string): number | undefined => {
    if (!diffText) {
        return undefined;
    }

    let currentNewLine: number | undefined;
    let firstHunkStart: number | undefined;
    for (const rawLine of diffText.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
            const parsed = Number.parseInt(hunkMatch[1] ?? '', 10);
            if (Number.isFinite(parsed)) {
                currentNewLine = Math.max(1, parsed);
                firstHunkStart ??= currentNewLine;
            }
            continue;
        }

        if (currentNewLine === undefined) {
            continue;
        }
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
            continue;
        }
        if (line.startsWith('+')) {
            return currentNewLine;
        }
        if (line.startsWith(' ')) {
            currentNewLine += 1;
        }
    }

    return firstHunkStart;
};

export const getFirstChangedLineFromMetadata = <TMetadata>(
    toolName: string,
    metadata?: TMetadata,
    preferredPath?: string,
): number | undefined => {
    if (metadata === undefined || !supportsDiffMetadata(toolName)) {
        return undefined;
    }

    const parsed = parseMetadata(metadata);

    if (preferredPath) {
        const matchedFile = getMetadataFileForPath(parsed, preferredPath);
        const matchedPatch = getPatchText(matchedFile?.patch) ?? getPatchText(matchedFile?.diff);
        if (matchedPatch) {
            const matchedLine = extractFirstChangedLineFromDiff(matchedPatch);
            if (matchedLine !== undefined) {
                return matchedLine;
            }
        }
    }

    const topLevelPatch = getPatchText(parsed.patch) ?? getPatchText(parsed.diff);
    if (topLevelPatch) {
        const topLevelLine = extractFirstChangedLineFromDiff(topLevelPatch);
        if (topLevelLine !== undefined) {
            return topLevelLine;
        }
    }

    const firstFile = getMetadataFileForPath(parsed);
    const firstPatch = getPatchText(firstFile?.patch) ?? getPatchText(firstFile?.diff);
    return firstPatch ? extractFirstChangedLineFromDiff(firstPatch) : undefined;
};

/**
 * Quick-open target for a tool card: the primary mutated file plus the diff
 * entry the expanded card renders for it. Both the collapsed header icon and
 * the expanded "open file" button resolve their line from the same entry
 * patch, so they always land on the same line.
 */
export const resolveToolQuickOpenTarget = <TInput, TMetadata>(
    toolName: string,
    input: TInput,
    metadata: TMetadata,
): { filePath: string; line?: number; patch?: string } | null => {
    const filePath = getPrimaryToolPath(toolName, input, metadata);
    if (!filePath) {
        return null;
    }

    const entries = getDiffPatchEntries(metadata, getToolFallbackDiff(metadata), (path) => path);
    const matchedEntry = entries.find((entry) => entry.filePath === filePath)
        ?? (entries.length === 1 ? entries[0] : undefined);
    const patch = matchedEntry?.patch;
    return {
        filePath,
        line: patch ? extractFirstChangedLineFromDiff(patch) : undefined,
        patch,
    };
};

const normalizeParsedPath = (path: string | undefined): string => {
    const trimmed = (path ?? '').trim().replace(/\t.*$/, '');
    if (!trimmed || trimmed === '/dev/null') {
        return '';
    }
    return trimmed.replace(/^[ab]\//, '');
};

const makeSyntheticPath = (title: string): string => {
    const normalized = title.trim().replace(/\s+/g, '-');
    return normalized.length > 0 ? normalized : 'file';
};

const hasOnlyUnifiedDiffBodyLines = (patch: string): boolean => {
    let inHunk = false;
    for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
            if (!HUNK_HEADER_PATTERN.test(line)) {
                return false;
            }
            inHunk = true;
            continue;
        }

        if (!inHunk || line.length === 0) {
            continue;
        }

        const first = line[0];
        if (first !== ' ' && first !== '+' && first !== '-' && first !== '\\') {
            return false;
        }
    }

    return true;
};

export const getRenderablePatchInfo = (patch: string): { patch: string; title?: string } | null => {
    const normalized = normalizeLooseUnifiedPatch(patch);
    if (
        !normalized
        || APPLY_PATCH_ENVELOPE_PATTERN.test(normalized)
        || !HUNK_HEADER_PATTERN.test(normalized)
        || !hasOnlyUnifiedDiffBodyLines(normalized)
    ) {
        return null;
    }

    try {
        const parsedPatches = parsePatchFiles(normalized, undefined, true);
        if (parsedPatches.length !== 1) {
            return null;
        }

        const files = parsedPatches[0]?.files ?? [];
        const file = files[0];
        if (files.length !== 1 || !file || file.hunks.length === 0) {
            return null;
        }

        return {
            patch: normalized,
            title: normalizeParsedPath(file.name),
        };
    } catch {
        return null;
    }
};

const getPatchChunks = (patch: string): string[] => {
    const isGitDiff = GIT_DIFF_FILE_BREAK_TEST.test(patch);
    const hasUnifiedDiff = UNIFIED_DIFF_FILE_BREAK_TEST.test(patch);
    if (!isGitDiff && !hasUnifiedDiff) {
        return [];
    }

    return patch
        .split(isGitDiff ? GIT_DIFF_FILE_BREAK_PATTERN : UNIFIED_DIFF_FILE_BREAK_PATTERN)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
};

const getPatchEntriesFromText = (
    patch: string,
    fallbackTitle: string,
    idPrefix: string,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    if (isToolDiffPreviewOversized(patch)) {
        return [{
            id: `${idPrefix}-0`,
            title: resolveTitle(fallbackTitle),
            patch,
            renderMode: 'text',
        }];
    }

    const normalized = normalizeLooseUnifiedPatch(patch);
    if (!normalized) {
        return [];
    }

    const direct = getRenderablePatchInfo(normalized);
    if (direct) {
        const title = direct.title ? resolveTitle(direct.title) : resolveTitle(fallbackTitle);
        return [{ id: `${idPrefix}-0`, title, patch: direct.patch, renderMode: 'diff' }];
    }

    const chunkEntries: DiffPatchEntry[] = [];
    for (const chunk of getPatchChunks(normalized)) {
        const info = getRenderablePatchInfo(chunk);
        const title = info?.title ? resolveTitle(info.title) : resolveTitle(fallbackTitle);
        if (!info) {
            if (HUNK_HEADER_PATTERN.test(chunk) || GIT_DIFF_FILE_BREAK_TEST.test(chunk) || UNIFIED_DIFF_FILE_BREAK_TEST.test(chunk)) {
                chunkEntries.push({
                    id: `${idPrefix}-${chunkEntries.length}`,
                    title,
                    patch: chunk,
                    renderMode: 'text',
                });
            }
            continue;
        }
        chunkEntries.push({
            id: `${idPrefix}-${chunkEntries.length}`,
            title,
            patch: info.patch,
            renderMode: 'diff',
        });
    }

    if (chunkEntries.length > 0) {
        return chunkEntries;
    }

    if (!APPLY_PATCH_ENVELOPE_PATTERN.test(normalized) && HUNK_HEADER_PATTERN.test(normalized)) {
        const syntheticPath = makeSyntheticPath(fallbackTitle);
        const synthetic = getRenderablePatchInfo(`--- ${syntheticPath}\n+++ ${syntheticPath}\n${normalized}`);
        if (synthetic) {
            return [{
                id: `${idPrefix}-0`,
                title: resolveTitle(fallbackTitle),
                patch: synthetic.patch,
                renderMode: 'diff',
            }];
        }
    }

    return [{
        id: `${idPrefix}-0`,
        title: resolveTitle(fallbackTitle),
        patch: normalized,
        renderMode: 'text',
    }];
};

const getFilePatch = (file: PatchFile): { filePath?: string; patch: string; title: string } | null => {
    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    if (!patch) {
        return null;
    }

    const rawPath = file.relativePath ?? file.filePath ?? '';

    return {
        filePath: getApplyPatchFilePath(file) ?? undefined,
        patch,
        title: rawPath,
    };
};

export const getDiffPatchEntries = <TMetadata>(
    metadata: TMetadata,
    fallbackDiff: string | undefined,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const fileEntries = readMetadataFiles(metadata).flatMap((file, index) => {
        const filePatch = getFilePatch(file);
        if (!filePatch) {
            return [];
        }
        return getPatchEntriesFromText(
            filePatch.patch,
            filePatch.title || `File ${index + 1}`,
            `file-${index}`,
            resolveTitle,
        ).map((entry) => ({ ...entry, filePath: filePatch.filePath }));
    });

    if (fileEntries.length > 0) {
        return fileEntries;
    }

    const diff = fallbackDiff ?? '';
    return getPatchEntriesFromText(diff, 'Diff', 'fallback', resolveTitle);
};
