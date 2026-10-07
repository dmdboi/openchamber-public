import { describe, expect, test } from 'bun:test';

import { agentLabel } from '../../../src/lib/agentLabel';

describe('agentLabel', () => {
    test('prefers the display name', () => {
        expect(agentLabel({ name: 'code-reviewer', displayName: 'Code Reviewer' })).toBe('Code Reviewer');
    });

    test('falls back to the capitalized id when the display name is blank', () => {
        expect(agentLabel({ name: 'build', displayName: '  ' })).toBe('Build');
    });
});
