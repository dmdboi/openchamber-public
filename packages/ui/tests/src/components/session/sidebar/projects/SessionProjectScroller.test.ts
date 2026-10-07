import { describe, expect, test } from 'bun:test';
import { buildGroupRenderDescriptors } from '../../../../../../src/components/session/sidebar/projects/sessionProjectRender';
import type { SessionGroup } from '../../../../../../src/components/session/sidebar/types';

const makeGroup = (id: string, overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'main',
  worktree: null,
  directory: '/workspace',
  sessions: [],
  ...overrides,
});

describe('buildGroupRenderDescriptors', () => {
  test('renders the main group and archived bucket for the main workspace', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('archived', { isArchivedBucket: true })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: true })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:archived',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('renders the primary group without a label and nested groups with labels', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('feature')],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:feature',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('keeps labels when a flat section has no main group', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('feature', { isMain: false }), makeGroup('other', { isMain: false })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false }).map((descriptor) => descriptor.hideGroupLabel)).toEqual([false, false]);
  });
});


