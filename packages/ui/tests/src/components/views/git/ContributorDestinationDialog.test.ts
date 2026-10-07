import { describe, expect, test } from 'bun:test';
import { getContributorDestinationLabelKey } from '../../../../../src/components/views/git/contributorDestination';

describe('contributor destination labels', () => {
  test('keeps server classifications distinct in the chooser', () => {
    expect([
      getContributorDestinationLabelKey('contributor-fork'),
      getContributorDestinationLabelKey('own-fork'),
      getContributorDestinationLabelKey('bound-repository'),
      getContributorDestinationLabelKey('other'),
    ]).toEqual([
      'gitView.contributor.destination.contributor-fork',
      'gitView.contributor.destination.own-fork',
      'gitView.contributor.destination.bound-repository',
      'gitView.contributor.destination.other',
    ]);
  });
});
