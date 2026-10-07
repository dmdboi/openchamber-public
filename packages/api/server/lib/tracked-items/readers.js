// The provider reads behind tracked items, each answering one batch in the
// service's terms: `ok` with GitHub-shaped summaries, `disconnected` when no
// account on that host can answer, `unavailable` when it should be asked
// again later. Accounts are the ones the app is signed in to now, the way
// linked items have always been read.
import { z } from 'zod';
import { jsonValueSchema } from './items.js';
const providerHeadersSchema = z.union([
    z.custom((value) => Object.prototype.toString.call(value) === '[object Headers]'),
    z.record(z.string(), z.union([z.string(), z.number()])),
]);
const providerErrorSchema = z.object({
    status: z.number().optional(),
    response: z.object({
        status: z.number().optional(),
        headers: providerHeadersSchema.optional(),
    }).optional(),
    errors: z.array(jsonValueSchema).optional(),
    message: z.string().optional(),
});
/** Decodes a thrown value into the fields the rate-limit recognizers read. */
const decodeProviderError = (cause) => {
    const parsed = providerErrorSchema.safeParse(cause);
    return parsed.success ? parsed.data : null;
};
const callable = (member) => Object.prototype.toString.call(member) === '[object Function]';
const moduleNamespace = (cause) => {
    if (Object.prototype.toString.call(cause) !== '[object Module]')
        return null;
    // SAFETY: an ES module namespace is a null-prototype object whose exports are
    // its properties; a missing export reads as undefined.
    return cause;
};
const hasCallables = (cause, names) => {
    const namespace = moduleNamespace(cause);
    return namespace !== null && names.every((name) => callable(namespace[name]));
};
const githubReaderModuleSchema = z.custom((candidate) => hasCallables(candidate, ['getOctokitOrNull', 'getOctokitForAccountId']));
const githubSummariesModuleSchema = z.custom((candidate) => hasCallables(candidate, ['fetchPrSummaries', 'isGraphqlRateLimitError']));
const githubRateLimitModuleSchema = z.custom((candidate) => hasCallables(candidate, ['isGitHubRateLimited', 'isGitHubRateLimitError', 'noteGitHubRateLimit']));
const linearReaderModuleSchema = z.custom((candidate) => hasCallables(candidate, ['getLinearIssueSummaries']));
// The default loaders pull the real JavaScript modules at call time and decode
// their namespace against a contract, rather than casting an untyped import.
const loadModule = async (specifier, decode) => {
    const loaded = await import(specifier);
    const parsed = decode.safeParse(loaded);
    if (!parsed.success)
        throw new Error(`provider module ${specifier} does not match its contract`);
    return parsed.data;
};
export function createTrackedItemReaders({ loadGitHub = () => loadModule('../github/index.js', githubReaderModuleSchema), loadGitHubSummaries = () => loadModule('../github/pr-summaries.js', githubSummariesModuleSchema), loadGitHubRateLimit = () => loadModule('../github/rate-limit.js', githubRateLimitModuleSchema), loadLinear = () => loadModule('../linear/index.js', linearReaderModuleSchema), readGitLabLiveSummaries, } = {}) {
    return {
        async github({ accountId = null, pulls, issues }) {
            const [github, summaries, rateLimit] = await Promise.all([
                loadGitHub(), loadGitHubSummaries(), loadGitHubRateLimit(),
            ]);
            if (rateLimit.isGitHubRateLimited())
                return { status: 'unavailable' };
            // A bound repository is read with its own account, a linked item with the current one.
            const octokit = accountId
                ? (await github.getOctokitForAccountId(accountId))?.octokit ?? null
                : await github.getOctokitOrNull();
            if (!octokit)
                return { status: 'disconnected' };
            try {
                const { summaries: pullsAnswered, issueSummaries } = await summaries.fetchPrSummaries({ octokit, refs: pulls, issueRefs: issues });
                return { status: 'ok', pulls: pullsAnswered, issues: issueSummaries };
            }
            catch (cause) {
                // Any thrown value is decoded: a plain object with a status is handled
                // exactly like an Error subclass, and anything else is rethrown.
                const error = decodeProviderError(cause);
                if (error) {
                    if ((error.status ?? error.response?.status) === 401)
                        return { status: 'disconnected' };
                    if (summaries.isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
                        // The shared cooldown also holds back every other GitHub read.
                        rateLimit.noteGitHubRateLimit(error);
                        return { status: 'unavailable' };
                    }
                }
                throw cause;
            }
        },
        async gitlab({ instance, accountId = null, pulls, issues }) {
            if (!(readGitLabLiveSummaries instanceof Function))
                return { status: 'disconnected' };
            const result = await readGitLabLiveSummaries({ instance, accountId, refs: pulls, issueRefs: issues });
            if (!result.connected)
                return { status: 'disconnected' };
            return { status: 'ok', pulls: result.summaries, issues: result.issueSummaries };
        },
        async linear({ identifiers }) {
            const { getLinearIssueSummaries } = await loadLinear();
            const result = await getLinearIssueSummaries(identifiers);
            if (!result?.connected)
                return { status: 'disconnected' };
            return { status: 'ok', issues: result.issues };
        },
    };
}
