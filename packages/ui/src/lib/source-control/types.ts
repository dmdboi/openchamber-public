export type * from '@openchamber/contracts';

import type {
  SourceControlBindingRead,
  SourceControlRepositoryBinding,
} from '@openchamber/contracts';

/**
 * The binding a repository acts under, whether or not one was configured.
 *
 * A repository nobody configured uses the machine's own Git for every remote,
 * as it did before bindings existed: every remote is a ready System grant, and
 * the read's revision (the store's tombstone revision) pins the plan so a later
 * configuration still invalidates it.
 */
export const effectiveRepositoryBinding = (read: SourceControlBindingRead): SourceControlRepositoryBinding => {
  if (read.binding) return read.binding;
  return {
    repositoryId: read.repository.repositoryId,
    revision: read.revision,
    providers: [],
    remotes: read.repository.remotes.map((remote) => ({ ...remote, mode: 'system', readiness: 'ready' })),
    auxiliary: [],
    state: 'bound',
    configRevision: read.repository.configRevision,
  };
};
