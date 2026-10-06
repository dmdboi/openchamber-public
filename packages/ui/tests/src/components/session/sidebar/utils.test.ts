import { describe, expect, test } from 'bun:test';
import {
  isPathWithinProject,
  toggleExpandedParentKey,
} from '../../../../../src/components/session/sidebar/utils';

describe('isPathWithinProject', () => {
  test('matches child directories for root projects', () => {
    expect(isPathWithinProject('/workspace/app', '/')).toBe(true);
    expect(isPathWithinProject('c:\\Users\\Developer', 'C:/')).toBe(true);
    expect(isPathWithinProject('D:/Users/Developer', 'C:/')).toBe(false);
    expect(isPathWithinProject('//?/C:/Users/Developer', '//?/C:/')).toBe(true);
    expect(isPathWithinProject('//Server/Share/Project', '//Server/Share')).toBe(true);
    expect(isPathWithinProject('//Server/Share2/Project', '//Server/Share')).toBe(false);
  });

  test('matches exact project directories', () => {
    expect(isPathWithinProject('/workspace/app', '/workspace/app')).toBe(true);
  });

  test('does not match sibling directory prefixes', () => {
    expect(isPathWithinProject('/workspace/app2', '/workspace/app')).toBe(false);
  });

  test('returns false when directory is null', () => {
    expect(isPathWithinProject(null, '/workspace/app')).toBe(false);
  });

  test('returns false when projectPath is null', () => {
    expect(isPathWithinProject('/workspace/app', null)).toBe(false);
  });

  test('matches deep child directories', () => {
    expect(isPathWithinProject('/workspace/app/sub/dir', '/workspace/app')).toBe(true);
  });
});


describe('parent expansion state', () => {
  const recentKey = 'recent:active:parent-a';
  const projectKey = 'project:active:parent-a';

  test('manually expands and collapses a parent', () => {
    const expanded = toggleExpandedParentKey(new Set(), recentKey);
    expect(expanded).toEqual(new Set([recentKey]));
    expect(toggleExpandedParentKey(expanded, recentKey)).toEqual(new Set());
  });

});
