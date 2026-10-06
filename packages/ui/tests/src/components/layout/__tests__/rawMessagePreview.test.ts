import { describe, expect, test } from 'bun:test';
import type { Part } from '@/lib/opencode/model';

import {
  derivePartsLabel,
  deriveUserSnippet,
  formatAssistantTokens,
  formatMessagePreviewTime,
} from '../../../../../src/components/layout/rawMessagePreview';

const part = (data: Record<string, unknown>): Part => data as unknown as Part;


describe('derivePartsLabel', () => {
  test('returns empty for no parts', () => {
    expect(derivePartsLabel([])).toBe('');
  });

  test('uses tool name for tool parts', () => {
    expect(derivePartsLabel([part({ type: 'tool', tool: 'bash' })])).toBe('bash');
  });

  test('joins multiple distinct parts with " + "', () => {
    expect(
      derivePartsLabel([
        part({ type: 'text', text: 'hi' }),
        part({ type: 'tool', tool: 'bash' }),
      ]),
    ).toBe('text + bash');
  });

  test('deduplicates labels', () => {
    expect(
      derivePartsLabel([
        part({ type: 'text', text: 'a' }),
        part({ type: 'text', text: 'b' }),
        part({ type: 'tool', tool: 'bash' }),
      ]),
    ).toBe('text + bash');
  });

  test('lowercases tool names', () => {
    expect(derivePartsLabel([part({ type: 'tool', tool: 'Bash' })])).toBe('bash');
  });

  test('falls back to "tool" for tool parts without a tool name', () => {
    expect(derivePartsLabel([part({ type: 'tool' })])).toBe('tool');
  });

  test('falls back to "unknown" for parts without a type', () => {
    expect(derivePartsLabel([part({})])).toBe('unknown');
  });
});

describe('formatMessagePreviewTime', () => {
  // Fixed timestamp: 2024-01-15 14:35:00 UTC. Local rendering will vary; we
  // only assert structural properties (no AM/PM in 24h mode, presence in 12h).
  const ts = Date.UTC(2024, 0, 15, 14, 35, 0);

  test('returns "-" for null', () => {
    expect(formatMessagePreviewTime(null, '24h')).toBe('-');
  });

  test('returns "-" for non-finite', () => {
    expect(formatMessagePreviewTime(Number.NaN, '24h')).toBe('-');
  });

  test('24h mode omits AM/PM markers', () => {
    const result = formatMessagePreviewTime(ts, '24h');
    expect(/AM|PM/i.test(result)).toBe(false);
  });

  test('12h mode includes AM or PM marker', () => {
    const result = formatMessagePreviewTime(ts, '12h');
    expect(/AM|PM/i.test(result)).toBe(true);
  });

  test('auto mode is non-empty', () => {
    expect(formatMessagePreviewTime(ts, 'auto').length > 0).toBe(true);
  });
});

describe('deriveUserSnippet', () => {
  test('returns the first text part verbatim (no length cap)', () => {
    // CSS handles the visual truncation at column width; the helper just
    // returns the cleaned full string so consumers can decide what to do.
    expect(
      deriveUserSnippet([part({ type: 'text', text: 'hello world this is long' })]),
    ).toBe('hello world this is long');
  });

  test('preserves punctuation, accents, and unicode (React escapes at render)', () => {
    expect(
      deriveUserSnippet([part({ type: 'text', text: 'olá, mundo! 123' })]),
    ).toBe('olá, mundo! 123');
  });

  test('collapses whitespace runs and trims ends', () => {
    expect(
      deriveUserSnippet([part({ type: 'text', text: '  a\n\n  b\t\tc  ' })]),
    ).toBe('a b c');
  });

  test('uses attachment count fallback when no text part exists', () => {
    expect(deriveUserSnippet([part({ type: 'file' })])).toBe('1 attachment');
    expect(
      deriveUserSnippet([part({ type: 'file' }), part({ type: 'file' })]),
    ).toBe('2 attachments');
  });

  test('skips empty text parts and falls through to next text part', () => {
    expect(
      deriveUserSnippet([
        part({ type: 'text', text: '   ' }),
        part({ type: 'text', text: 'next' }),
      ]),
    ).toBe('next');
  });

  test('returns empty string when there are no parts at all', () => {
    expect(deriveUserSnippet([])).toBe('');
  });

  test('returns empty string when all parts are whitespace-only text (not attachments)', () => {
    expect(
      deriveUserSnippet([
        part({ type: 'text', text: '   ' }),
        part({ type: 'text', text: '' }),
      ]),
    ).toBe('');
  });
});

describe('formatAssistantTokens', () => {
  const fmt = (n: number) => n.toLocaleString('en-US');

  test('renders input and output separated by " / "', () => {
    expect(formatAssistantTokens(340, 1205, fmt)).toBe('340 / 1,205');
  });

  test('renders both zeros explicitly (does not hide 0/0)', () => {
    expect(formatAssistantTokens(0, 0, fmt)).toBe('0 / 0');
  });

  test('honors the caller-provided number formatter', () => {
    expect(formatAssistantTokens(1234, 5678, (n) => String(n))).toBe('1234 / 5678');
  });
});
