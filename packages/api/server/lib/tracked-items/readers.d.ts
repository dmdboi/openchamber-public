import type { JsonValue } from '@opencode/client';
import type { TrackedItemState } from './items.js';
export interface TrackedThreadRef {
    owner: string;
    repo: string;
    number: number;
}
export interface TrackedGithubReadInput {
    accountId?: string | null;
    pulls: TrackedThreadRef[];
    issues: TrackedThreadRef[];
}
export interface TrackedGitlabReadInput {
    instance: string;
    accountId?: string | null;
    pulls: TrackedThreadRef[];
    issues: TrackedThreadRef[];
}
export interface TrackedLinearReadInput {
    identifiers: string[];
}
export interface TrackedReaderOkResult {
    status: 'ok';
    pulls?: TrackedItemState[];
    issues?: TrackedItemState[];
}
export interface TrackedReaderDisconnectedResult {
    status: 'disconnected';
}
export interface TrackedReaderUnavailableResult {
    status: 'unavailable';
    retryAfterMs?: number;
}
export type TrackedReaderResult = TrackedReaderOkResult | TrackedReaderDisconnectedResult | TrackedReaderUnavailableResult;
/**
 * A provider answer may be nothing at all: the JavaScript providers are
 * untyped, so the service decodes every answer before trusting its shape.
 */
export type TrackedReaderAnswer = TrackedReaderResult | null | undefined;
export interface TrackedReaderAnswers {
    github(input: TrackedGithubReadInput): Promise<TrackedReaderAnswer>;
    gitlab(input: TrackedGitlabReadInput): Promise<TrackedReaderAnswer>;
    linear(input: TrackedLinearReadInput): Promise<TrackedReaderAnswer>;
}
/** The decoded shape of a value a provider threw, whatever its class. */
export interface ProviderError {
    status?: number;
    response?: {
        status?: number;
        headers?: Headers | Record<string, string | number>;
    };
    errors?: JsonValue[];
    message?: string;
}
export interface GitHubReaderModule {
    getOctokitForAccountId(accountId: string): Promise<{
        octokit: JsonValue;
    } | null>;
    getOctokitOrNull(): Promise<JsonValue | null>;
}
export interface GitHubSummariesModule {
    fetchPrSummaries(input: {
        octokit: JsonValue;
        refs: TrackedThreadRef[];
        issueRefs: TrackedThreadRef[];
    }): Promise<{
        summaries: TrackedItemState[];
        issueSummaries: TrackedItemState[];
    }>;
    isGraphqlRateLimitError(error: ProviderError): boolean;
}
export interface GitHubRateLimitModule {
    isGitHubRateLimited(): boolean;
    isGitHubRateLimitError(error: ProviderError): boolean;
    noteGitHubRateLimit(error: ProviderError): void;
}
export interface LinearReaderModule {
    getLinearIssueSummaries(identifiers: string[]): Promise<{
        connected?: boolean;
        issues?: TrackedItemState[];
    }>;
}
export interface GitLabLiveSummariesInput {
    instance: string;
    accountId?: string | null;
    refs: TrackedThreadRef[];
    issueRefs: TrackedThreadRef[];
}
export interface GitLabLiveSummariesResult {
    connected: boolean;
    summaries?: TrackedItemState[];
    issueSummaries?: TrackedItemState[];
}
export type GitLabLiveSummariesReader = (input: GitLabLiveSummariesInput) => Promise<GitLabLiveSummariesResult>;
/**
 * `readGitLabLiveSummaries({ instance, refs, issueRefs })` comes from the
 * GitLab routes, which own GitLab accounts and their reconciliation.
 */
export interface TrackedItemReaderDependencies {
    loadGitHub?: () => Promise<GitHubReaderModule>;
    loadGitHubSummaries?: () => Promise<GitHubSummariesModule>;
    loadGitHubRateLimit?: () => Promise<GitHubRateLimitModule>;
    loadLinear?: () => Promise<LinearReaderModule>;
    readGitLabLiveSummaries?: GitLabLiveSummariesReader;
}
export declare function createTrackedItemReaders({ loadGitHub, loadGitHubSummaries, loadGitHubRateLimit, loadLinear, readGitLabLiveSummaries, }?: TrackedItemReaderDependencies): TrackedReaderAnswers;
