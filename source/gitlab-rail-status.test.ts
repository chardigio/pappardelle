import {test, expect} from 'bun:test';
import {
	GitLabProvider,
	type GlabExecutor,
} from './providers/gitlab-provider.ts';

const discussion = (resolvable = true, resolved = false) => ({
	resolvable,
	resolved,
});
const page = (
	nodes = [discussion()],
	hasNextPage = false,
	endCursor: string | null = null,
) => ({
	nodes,
	pageInfo: {hasNextPage, endCursor},
});
const mr = (status: string | null = 'SUCCESS', extra = {}) => ({
	iid: '42',
	detailedMergeStatus: 'MERGEABLE',
	headPipeline: status === null ? null : {status},
	discussions: page(),
	...extra,
});
const response = (aliases: Record<string, unknown>, errors?: unknown[]) =>
	JSON.stringify({data: {project: aliases}, errors});
const connection = (node: unknown = mr()) => ({
	nodes: node === null ? [] : [node],
});

function fixture(replies: string[], now = () => 0) {
	const calls: string[][] = [];
	const executor: GlabExecutor = async args => {
		calls.push(args);
		if (args[0] === 'repo')
			return JSON.stringify({path_with_namespace: 'group/sub/repo'});
		const reply = replies.shift();
		if (reply === undefined) throw new Error('unexpected request');
		return reply;
	};
	return {provider: new GitLabProvider(undefined, executor, now), calls};
}

for (const [raw, expected] of [
	['SUCCESS', 'passing'],
	['SKIPPED', 'passing'],
	['FAILED', 'failing'],
	['CANCELED', 'failing'],
	['RUNNING', 'progressing_clean'],
	['CREATED', 'progressing_clean'],
	['PENDING', 'progressing_clean'],
	['WAITING_FOR_RESOURCE', 'progressing_clean'],
	['PREPARING', 'progressing_clean'],
	['MANUAL', 'progressing_clean'],
	['SCHEDULED', 'progressing_clean'],
	['FUTURE_STATUS', 'progressing_clean'],
	[null, null],
] as const) {
	test(`pipeline ${raw} maps to ${expected}`, async () => {
		const {provider} = fixture([response({mr0: connection(mr(raw))})]);
		expect(await provider.getRailStatus('STE-24')).toStrictEqual({
			pipeline: expected,
			unresolvedCommentCount: 1,
			prNumber: 42,
			hasConflict: false,
		});
	});
}

test('one batch maps unique branches and missing MRs; exact newest-open query escapes input', async () => {
	const branch = 'quote"\\branch';
	const {provider, calls} = fixture([
		response({
			mr0: connection(mr('FAILED')),
			mr1: connection(null),
		}),
	]);
	const result = await provider.getBulkRailStatus([branch, 'missing', branch]);
	expect(result.size).toBe(2);
	expect(result.get(branch)?.pipeline).toBe('failing');
	expect(result.get('missing')).toStrictEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
	});
	expect(calls.length).toBe(2);
	const query = calls[1]!.find(arg => arg.startsWith('query='))!;
	expect(query.includes(JSON.stringify(branch))).toBe(true);
	expect(query.includes('group/sub/repo')).toBe(true);
	expect(query.includes('state: opened')).toBe(true);
	expect(query.includes('sort: UPDATED_DESC')).toBe(true);
	expect(query.includes('first: 1')).toBe(true);
	expect(query.includes('mr2:')).toBe(false);
});

test('counts threads once and flags only explicit conflicts', async () => {
	const {provider} = fixture([
		response({
			mr0: connection(
				mr('SUCCESS', {
					detailedMergeStatus: 'CONFLICT',
					discussions: page([
						discussion(),
						discussion(),
						discussion(true, true),
						discussion(false),
					]),
				}),
			),
			mr1: connection(mr('SUCCESS', {detailedMergeStatus: 'NOT_APPROVED'})),
		}),
	]);
	const result = await provider.getBulkRailStatus(['conflict', 'blocked']);
	expect(result.get('conflict')?.unresolvedCommentCount).toBe(2);
	expect(result.get('conflict')?.hasConflict).toBe(true);
	expect(result.get('blocked')?.hasConflict).toBe(false);
});

test('shared cache expires at 60 seconds and batches only misses', async () => {
	let now = 0;
	const {provider, calls} = fixture(
		[
			response({mr0: connection()}),
			response({mr0: connection(null)}),
			response({mr0: connection(mr('FAILED')), mr1: connection(null)}),
		],
		() => now,
	);
	await provider.getRailStatus('a');
	now = 59_999;
	const mixed = await provider.getBulkRailStatus(['a', 'b']);
	expect(mixed.get('a')?.pipeline).toBe('passing');
	expect(calls.length).toBe(3);
	const snapshot1 = await provider.getRailStatus('b');
	expect(snapshot1.pipeline).toBe(null);
	expect(calls.length).toBe(3);
	now = 120_000;
	const refreshed = await provider.getBulkRailStatus(['a', 'b']);
	expect(refreshed.get('a')?.pipeline).toBe('failing');
	expect(calls.filter(args => args[0] === 'repo').length).toBe(1);
});

test('empty input does not discover project', async () => {
	const {provider, calls} = fixture([]);
	const snapshot2 = await provider.getBulkRailStatus([]);
	expect(snapshot2.size).toBe(0);
	expect(calls.length).toBe(0);
});

test('paginates discussions using MR identity and counts all pages', async () => {
	const {provider, calls} = fixture([
		response({
			mr0: connection(
				mr('SUCCESS', {
					discussions: page(
						Array.from({length: 100}, () => discussion()),
						true,
						'cursor',
					),
				}),
			),
		}),
		response({
			mr0: {discussions: page([discussion(), discussion(true, true)])},
		}),
	]);
	const snapshot3 = await provider.getRailStatus('a');
	expect(snapshot3.unresolvedCommentCount).toBe(101);
	expect(calls[2]!.join(' ').includes('mergeRequest(iid: "42")')).toBe(true);
	expect(calls[2]!.join(' ').includes('after: "cursor"')).toBe(true);
	await provider.getRailStatus('a');
	expect(calls.length).toBe(3);
});

for (const bad of [
	'not json',
	'{}',
	'{"data":{"project":null}}',
	'{"errors":[{"message":"denied"}]}',
]) {
	test(`failed response is omitted and retried: ${bad}`, async () => {
		const {provider} = fixture([bad, response({mr0: connection()})]);
		const snapshot4 = await provider.getBulkRailStatus(['a']);
		expect(snapshot4.size).toBe(0);
		const snapshot5 = await provider.getRailStatus('a');
		expect(snapshot5.pipeline).toBe('passing');
	});
}

test('partial GraphQL errors omit affected keys and cache successful keys', async () => {
	const {provider, calls} = fixture([
		response({mr0: connection(), mr1: connection(null)}, [
			{message: 'denied', path: ['project', 'mr1']},
		]),
		response({mr0: connection(mr('FAILED'))}),
	]);
	const first = await provider.getBulkRailStatus(['a', 'b']);
	expect(first.has('a')).toBe(true);
	expect(first.has('b')).toBe(false);
	const retry = await provider.getBulkRailStatus(['a', 'b']);
	expect(retry.get('a')?.pipeline).toBe('passing');
	expect(retry.get('b')?.pipeline).toBe('failing');
	expect(calls.length).toBe(3);
});

test('failed continuation never caches an incomplete count', async () => {
	const {provider} = fixture([
		response({
			mr0: connection(mr('SUCCESS', {discussions: page([], true, 'cursor')})),
		}),
		'{}',
		response({mr0: connection()}),
	]);
	const snapshot6 = await provider.getBulkRailStatus(['a']);
	expect(snapshot6.size).toBe(0);
	const snapshot7 = await provider.getRailStatus('a');
	expect(snapshot7.unresolvedCommentCount).toBe(1);
});

test('project discovery retries after rejection', async () => {
	let attempts = 0;
	const executor: GlabExecutor = async args => {
		if (args[0] !== 'repo') return response({mr0: connection()});
		if (++attempts === 1) throw new Error('offline');
		return JSON.stringify({path_with_namespace: 'group/repo'});
	};
	const provider = new GitLabProvider(undefined, executor);
	const snapshot8 = await provider.getBulkRailStatus(['a']);
	expect(snapshot8.size).toBe(0);
	const snapshot9 = await provider.getRailStatus('a');
	expect(snapshot9.pipeline).toBe('passing');
	expect(attempts).toBe(2);
});

test('cache expires exactly at the boundary without exposing mutable cached objects', async () => {
	let now = 0;
	const {provider, calls} = fixture(
		[response({mr0: connection()}), response({mr0: connection(mr('FAILED'))})],
		() => now,
	);
	const first = await provider.getRailStatus('a');
	first.pipeline = 'failing';
	const cached = await provider.getRailStatus('a');
	expect(cached.pipeline).toBe('passing');
	cached.pipeline = 'failing';
	now = 59_999;
	const beforeExpiry = await provider.getRailStatus('a');
	expect(beforeExpiry.pipeline).toBe('passing');
	expect(calls.length).toBe(2);
	now = 60_000;
	const expired = await provider.getRailStatus('a');
	expect(expired.pipeline).toBe('failing');
	expect(calls.length).toBe(3);
});

test('expired failure stays absent and retries immediately', async () => {
	let now = 0;
	const {provider} = fixture(
		[
			response({mr0: connection()}),
			'{}',
			response({mr0: connection(mr('FAILED'))}),
		],
		() => now,
	);
	await provider.getRailStatus('a');
	now = 60_000;
	const failed = await provider.getBulkRailStatus(['a']);
	expect(failed.has('a')).toBe(false);
	const retry = await provider.getRailStatus('a');
	expect(retry.pipeline).toBe('failing');
});

test('configured host is explicit on API requests', async () => {
	const previous = process.env['GITLAB_HOST'];
	try {
		const calls: string[][] = [];
		const provider = new GitLabProvider('gitlab.example.com', async args => {
			calls.push(args);
			return args[0] === 'repo'
				? '{"path_with_namespace":"group/repo"}'
				: response({mr0: connection()});
		});
		await provider.getRailStatus('a');
		expect(calls[1]!.slice(-2)).toStrictEqual([
			'--hostname',
			'gitlab.example.com',
		]);
	} finally {
		if (previous === undefined) delete process.env['GITLAB_HOST'];
		else process.env['GITLAB_HOST'] = previous;
	}
});

test('API subprocess failure returns empty bulk and empty single status', async () => {
	const provider = new GitLabProvider(undefined, async args => {
		if (args[0] === 'repo') return '{"path_with_namespace":"group/repo"}';
		throw new Error('request timed out');
	});
	const bulk = await provider.getBulkRailStatus(['a']);
	expect(bulk.size).toBe(0);
	expect(await provider.getRailStatus('a')).toStrictEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
	});
});

test('multiple continuation requests are batched and completed MRs survive page failure', async () => {
	const {provider, calls} = fixture([
		response({
			mr0: connection(
				mr('SUCCESS', {discussions: page([discussion()], true, 'first')}),
			),
			mr1: connection(
				mr('FAILED', {iid: '43', discussions: page([], true, 'second')}),
			),
			mr2: connection(mr('SUCCESS')),
		}),
		response({
			mr0: {discussions: page([discussion()], true, 'next')},
			mr1: {discussions: page([discussion()])},
		}),
		response({mr0: {discussions: page([], true, 'next')}}),
	]);
	const result = await provider.getBulkRailStatus(['a', 'b', 'c']);
	expect(result.has('a')).toBe(false);
	expect(result.get('b')?.unresolvedCommentCount).toBe(1);
	expect(result.get('c')?.pipeline).toBe('passing');
	expect(calls[2]!.join(' ').includes('mr0:')).toBe(true);
	expect(calls[2]!.join(' ').includes('mr1:')).toBe(true);
});

test('malformed MR does not clear the branch or prevent valid siblings', async () => {
	const {provider} = fixture([
		response({
			mr0: connection({iid: 'not-a-number'}),
			mr1: connection(
				mr('SUCCESS', {
					discussions: {nodes: [], pageInfo: {hasNextPage: true}},
				}),
			),
			mr2: connection(),
		}),
	]);
	const result = await provider.getBulkRailStatus(['a', 'b', 'c']);
	expect([...result.keys()]).toStrictEqual(['c']);
});

const SELECTION =
	/(\w+): project\(fullPath: "[^"]*"\)|(mr\d+): mergeRequests\(sourceBranches: \[("(?:[^"\\]|\\.)*")\]|(mr\d+): mergeRequest\(iid: "(\d+)"\)/g;

function aliasFixture({
	failOn,
	answer = () => connection(),
	nextPage = () => page(),
	projectOf = () => 'group/repo',
}: {
	failOn?: number;
	answer?: (branch: string) => unknown;
	nextPage?: (iid: string) => unknown;
	projectOf?: (branch: string) => string;
} = {}) {
	const queries: string[] = [];
	const executor: GlabExecutor = async args => {
		const query = args.find(arg => arg.startsWith('query='))!;
		queries.push(query);
		if (queries.length === failOn) throw new Error('request timed out');
		const data: Record<string, Record<string, unknown>> = {};
		let current: Record<string, unknown> = {};
		for (const match of query.matchAll(SELECTION)) {
			if (match[1]) {
				current = {};
				data[match[1]] = current;
			} else if (match[2])
				current[match[2]] = answer(JSON.parse(match[3]!) as string);
			else current[match[4]!] = {discussions: nextPage(match[5]!)};
		}
		return JSON.stringify({data});
	};
	const provider = new GitLabProvider(
		undefined,
		executor,
		() => 0,
		async branch => [{project: projectOf(branch), branch}],
	);
	const poll = async (branches: string[]) =>
		provider.getBulkRailStatus(
			branches,
			new Map(branches.map(branch => [branch, branch])),
		);
	return {poll, queries};
}

const branches = (count: number) =>
	Array.from({length: count}, (_, i) => `branch-${i}`);
const count = (query: string, selection: string) =>
	query.split(selection).length - 1;
const queriedBranches = (query: string) =>
	[...query.matchAll(SELECTION)]
		.filter(match => match[3])
		.map(match => JSON.parse(match[3]!) as string);

test('many spaces split across requests under the complexity budget', async () => {
	const {poll, queries} = aliasFixture();
	const result = await poll(branches(30));
	expect(queries.length).toBe(3);
	expect(queries.every(query => count(query, 'mergeRequests(') <= 13)).toBe(
		true,
	);
	expect([...result.keys()].sort()).toStrictEqual(branches(30).sort());
});

test('a failed request drops only its spaces and they retry next poll', async () => {
	const {poll, queries} = aliasFixture({failOn: 2});
	const all = branches(30);
	const result = await poll(all);
	expect([...result.keys()]).toStrictEqual([
		...all.slice(0, 13),
		...all.slice(26),
	]);
	const retried = await poll(all);
	expect(retried.size).toBe(30);
	expect(
		queries.slice(3).flatMap(query => queriedBranches(query)),
	).toStrictEqual(all.slice(13, 26));
});

test('discussion continuations split across requests and count every page', async () => {
	const iids = new Map(
		branches(30).map((branch, i) => [branch, String(i + 1)]),
	);
	const {poll, queries} = aliasFixture({
		answer: branch =>
			connection(
				mr('SUCCESS', {
					iid: iids.get(branch),
					discussions: page([discussion()], true, `cursor-${branch}`),
				}),
			),
	});
	const result = await poll(branches(30));
	const continuations = queries.filter(query =>
		query.includes('mergeRequest(iid:'),
	);
	expect(continuations.length).toBe(2);
	expect(
		continuations.every(query => count(query, 'mergeRequest(iid:') <= 24),
	).toBe(true);
	expect(result.size).toBe(30);
	expect(
		[...result.values()].every(status => status.unresolvedCommentCount === 2),
	).toBe(true);
});

test('request budget counts each project alias', async () => {
	const {poll, queries} = aliasFixture({
		projectOf: branch => `group/${branch}`,
	});
	const result = await poll(branches(13));
	expect(queries.length).toBe(2);
	expect(queries.every(query => count(query, 'mergeRequests(') <= 12)).toBe(
		true,
	);
	expect(result.size).toBe(13);
});

test('a failed continuation request drops only its MRs uncached', async () => {
	const iids = new Map(
		branches(30).map((branch, i) => [branch, String(i + 1)]),
	);
	const {poll, queries} = aliasFixture({
		failOn: 4,
		answer: branch =>
			connection(
				mr('SUCCESS', {
					iid: iids.get(branch),
					discussions: page([discussion()], true, `cursor-${branch}`),
				}),
			),
	});
	const all = branches(30);
	const result = await poll(all);
	const failed = new Set(
		[...queries[3]!.matchAll(/mergeRequest\(iid: "(\d+)"\)/g)].map(
			match => match[1]!,
		),
	);
	expect(failed.size).toBe(24);
	expect([...result.keys()].sort()).toStrictEqual(
		all.filter(branch => !failed.has(iids.get(branch)!)).sort(),
	);
	expect(
		[...result.values()].every(status => status.unresolvedCommentCount === 2),
	).toBe(true);
	await poll(all);
	expect(
		queries
			.slice(5)
			.flatMap(query => queriedBranches(query))
			.sort(),
	).toStrictEqual(all.filter(branch => failed.has(iids.get(branch)!)).sort());
});
