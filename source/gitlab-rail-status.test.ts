import test from 'ava';
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
	test(`pipeline ${raw} maps to ${expected}`, async t => {
		const {provider} = fixture([response({mr0: connection(mr(raw))})]);
		t.deepEqual(await provider.getRailStatus('STE-24'), {
			pipeline: expected,
			unresolvedCommentCount: 1,
			prNumber: 42,
			hasConflict: false,
		});
	});
}

test('one batch maps unique branches and missing MRs; exact newest-open query escapes input', async t => {
	const branch = 'quote"\\branch';
	const {provider, calls} = fixture([
		response({
			mr0: connection(mr('FAILED')),
			mr1: connection(null),
		}),
	]);
	const result = await provider.getBulkRailStatus([branch, 'missing', branch]);
	t.is(result.size, 2);
	t.is(result.get(branch)?.pipeline, 'failing');
	t.deepEqual(result.get('missing'), {
		pipeline: null,
		unresolvedCommentCount: 0,
	});
	t.is(calls.length, 2);
	const query = calls[1]!.find(arg => arg.startsWith('query='))!;
	t.true(query.includes(JSON.stringify(branch)));
	t.true(query.includes('group/sub/repo'));
	t.true(query.includes('state: opened'));
	t.true(query.includes('sort: UPDATED_DESC'));
	t.true(query.includes('first: 1'));
	t.false(query.includes('mr2:'));
});

test('counts threads once and flags only explicit conflicts', async t => {
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
	t.is(result.get('conflict')?.unresolvedCommentCount, 2);
	t.true(result.get('conflict')?.hasConflict);
	t.false(result.get('blocked')?.hasConflict);
});

test('shared cache expires at 60 seconds and batches only misses', async t => {
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
	t.is(mixed.get('a')?.pipeline, 'passing');
	t.is(calls.length, 3);
	const snapshot1 = await provider.getRailStatus('b');
	t.is(snapshot1.pipeline, null);
	t.is(calls.length, 3);
	now = 120_000;
	const refreshed = await provider.getBulkRailStatus(['a', 'b']);
	t.is(refreshed.get('a')?.pipeline, 'failing');
	t.is(calls.filter(args => args[0] === 'repo').length, 1);
});

test('empty input does not discover project', async t => {
	const {provider, calls} = fixture([]);
	const snapshot2 = await provider.getBulkRailStatus([]);
	t.is(snapshot2.size, 0);
	t.is(calls.length, 0);
});

test('paginates discussions using MR identity and counts all pages', async t => {
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
	t.is(snapshot3.unresolvedCommentCount, 101);
	t.true(calls[2]!.join(' ').includes('mergeRequest(iid: "42")'));
	t.true(calls[2]!.join(' ').includes('after: "cursor"'));
	await provider.getRailStatus('a');
	t.is(calls.length, 3);
});

for (const bad of [
	'not json',
	'{}',
	'{"data":{"project":null}}',
	'{"errors":[{"message":"denied"}]}',
]) {
	test(`failed response is omitted and retried: ${bad}`, async t => {
		const {provider} = fixture([bad, response({mr0: connection()})]);
		const snapshot4 = await provider.getBulkRailStatus(['a']);
		t.is(snapshot4.size, 0);
		const snapshot5 = await provider.getRailStatus('a');
		t.is(snapshot5.pipeline, 'passing');
	});
}

test('partial GraphQL errors omit affected keys and cache successful keys', async t => {
	const {provider, calls} = fixture([
		response({mr0: connection(), mr1: connection(null)}, [
			{message: 'denied', path: ['project', 'mr1']},
		]),
		response({mr0: connection(mr('FAILED'))}),
	]);
	const first = await provider.getBulkRailStatus(['a', 'b']);
	t.true(first.has('a'));
	t.false(first.has('b'));
	const retry = await provider.getBulkRailStatus(['a', 'b']);
	t.is(retry.get('a')?.pipeline, 'passing');
	t.is(retry.get('b')?.pipeline, 'failing');
	t.is(calls.length, 3);
});

test('failed continuation never caches an incomplete count', async t => {
	const {provider} = fixture([
		response({
			mr0: connection(mr('SUCCESS', {discussions: page([], true, 'cursor')})),
		}),
		'{}',
		response({mr0: connection()}),
	]);
	const snapshot6 = await provider.getBulkRailStatus(['a']);
	t.is(snapshot6.size, 0);
	const snapshot7 = await provider.getRailStatus('a');
	t.is(snapshot7.unresolvedCommentCount, 1);
});

test('project discovery retries after rejection', async t => {
	let attempts = 0;
	const executor: GlabExecutor = async args => {
		if (args[0] !== 'repo') return response({mr0: connection()});
		if (++attempts === 1) throw new Error('offline');
		return JSON.stringify({path_with_namespace: 'group/repo'});
	};
	const provider = new GitLabProvider(undefined, executor);
	const snapshot8 = await provider.getBulkRailStatus(['a']);
	t.is(snapshot8.size, 0);
	const snapshot9 = await provider.getRailStatus('a');
	t.is(snapshot9.pipeline, 'passing');
	t.is(attempts, 2);
});

test('cache expires exactly at the boundary without exposing mutable cached objects', async t => {
	let now = 0;
	const {provider, calls} = fixture(
		[response({mr0: connection()}), response({mr0: connection(mr('FAILED'))})],
		() => now,
	);
	const first = await provider.getRailStatus('a');
	first.pipeline = 'failing';
	const cached = await provider.getRailStatus('a');
	t.is(cached.pipeline, 'passing');
	cached.pipeline = 'failing';
	now = 59_999;
	const beforeExpiry = await provider.getRailStatus('a');
	t.is(beforeExpiry.pipeline, 'passing');
	t.is(calls.length, 2);
	now = 60_000;
	const expired = await provider.getRailStatus('a');
	t.is(expired.pipeline, 'failing');
	t.is(calls.length, 3);
});

test('expired failure stays absent and retries immediately', async t => {
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
	t.false(failed.has('a'));
	const retry = await provider.getRailStatus('a');
	t.is(retry.pipeline, 'failing');
});

test.serial('configured host is explicit on API requests', async t => {
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
		t.deepEqual(calls[1]!.slice(-2), ['--hostname', 'gitlab.example.com']);
	} finally {
		if (previous === undefined) delete process.env['GITLAB_HOST'];
		else process.env['GITLAB_HOST'] = previous;
	}
});

test('API subprocess failure returns empty bulk and empty single status', async t => {
	const provider = new GitLabProvider(undefined, async args => {
		if (args[0] === 'repo') return '{"path_with_namespace":"group/repo"}';
		throw new Error('request timed out');
	});
	const bulk = await provider.getBulkRailStatus(['a']);
	t.is(bulk.size, 0);
	t.deepEqual(await provider.getRailStatus('a'), {
		pipeline: null,
		unresolvedCommentCount: 0,
	});
});

test('multiple continuation requests are batched and completed MRs survive page failure', async t => {
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
	t.false(result.has('a'));
	t.is(result.get('b')?.unresolvedCommentCount, 1);
	t.is(result.get('c')?.pipeline, 'passing');
	t.true(calls[2]!.join(' ').includes('mr0:'));
	t.true(calls[2]!.join(' ').includes('mr1:'));
});

test('malformed MR does not clear the branch or prevent valid siblings', async t => {
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
	t.deepEqual([...result.keys()], ['c']);
});
