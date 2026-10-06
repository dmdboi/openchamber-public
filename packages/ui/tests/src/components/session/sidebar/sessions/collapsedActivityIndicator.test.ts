import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../../../../../../src/components/session/sidebar/types';

// SAFETY: the fixture supplies the minimal SDK identity fields used by the activity projection.
const node = (id: string, parentID?: string, children: SessionNode[] = []): SessionNode => ({
  session: { id, parentID } as Session,
  children,
  worktree: null,
});

