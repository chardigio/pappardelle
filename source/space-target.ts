import type {SpaceIdentityDao} from './space-identity.ts';

export class NoTargetSpaceError extends Error {
	constructor() {
		super('Not in a Pappardelle workspace; pass --space KEY');
	}
}

/**
 * The space a companion verb acts on: --space when given, else the space
 * this process runs in. A --space value is typed by hand, so it resolves like
 * any issue key (`696` gains the team prefix). PAPPARDELLE_SPACE is already
 * the exact key and is used as is. The main space has no PAPPARDELLE_SPACE,
 * so it is only reachable with --space main.
 */
export function resolveTargetSpace(options: {
	flag?: string;
	env: NodeJS.ProcessEnv;
	resolve: (raw: string) => string;
}): string {
	if (options.flag?.trim()) return options.resolve(options.flag);
	const own = options.env['PAPPARDELLE_SPACE']?.trim();
	if (!own) throw new NoTargetSpaceError();
	return own;
}

/** A git checkout: the repo it belongs to and the root of its main checkout. */
export type Checkout = {repoName: string; mainRoot: string};

export type CheckoutLookup =
	| {kind: 'checkout'; checkout: Checkout}
	| {kind: 'not-in-a-repo'};

/** The checkout the process runs in, from readers that throw outside one. */
export function readCheckout(read: {
	repoName: () => string;
	mainRoot: () => string;
}): CheckoutLookup {
	try {
		return {
			kind: 'checkout',
			checkout: {repoName: read.repoName(), mainRoot: read.mainRoot()},
		};
	} catch {
		return {kind: 'not-in-a-repo'};
	}
}

export type CallerSpace =
	| {kind: 'env'; key: string}
	| {kind: 'cwd'; key: string; checkout: Checkout}
	| {kind: 'none'};

/**
 * The space the caller is in: PAPPARDELLE_SPACE, else the space whose
 * worktree holds `cwd`. Codex starts MCP servers with a filtered environment
 * and OpenCode from a shared service, so PAPPARDELLE_SPACE doesn't reach them,
 * and an agent started by hand in a worktree never had it; all of them run in
 * the space's directory. Outside a git checkout only PAPPARDELLE_SPACE names
 * a space.
 */
export function callerSpace(options: {
	env: NodeJS.ProcessEnv;
	cwd: string;
	checkout: CheckoutLookup;
	/** The identities of a repo's spaces. */
	identities: (repo: string) => Pick<SpaceIdentityDao, 'atPath'>;
}): CallerSpace {
	const own = options.env['PAPPARDELLE_SPACE']?.trim();
	if (own) return {kind: 'env', key: own};
	if (options.checkout.kind === 'not-in-a-repo') return {kind: 'none'};
	const {checkout} = options.checkout;
	const found = options.identities(checkout.repoName).atPath(options.cwd);
	return found.kind === 'identity'
		? {kind: 'cwd', key: found.identity.key, checkout}
		: {kind: 'none'};
}
