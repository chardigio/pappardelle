import test from 'ava';
import {GitHubProvider} from './providers/github-provider.ts';

const pr = (number: number, conclusion = 'SUCCESS', extra = {}) => ({
	number,
	mergeable: 'MERGEABLE',
	commits: {
		nodes: [
			{
				commit: {
					statusCheckRollup: {
						contexts: {
							nodes: [
								{
									status:
										conclusion === 'RUNNING' ? 'IN_PROGRESS' : 'COMPLETED',
									conclusion,
								},
							],
						},
					},
				},
			},
		],
	},
	reviewThreads: {nodes: [{isResolved: false}, {isResolved: true}]},
	...extra,
});
const connection = (...nodes: Array<ReturnType<typeof pr>>) => ({
	ref: {associatedPullRequests: {nodes}},
});
const paths = new Map([
	['a', '/a'],
	['b', '/b'],
]);

test('batches exact branches across repos and deduplicates shared checkouts', async t => {
	const calls: string[][] = [];
	const shared = {project: 'org/api', branch: 'sd-real-branch'};
	const provider = new GitHubProvider(
		async args => {
			calls.push(args);
			return JSON.stringify({
				data: {
					pr0: connection(pr(11, 'FAILURE', {mergeable: 'CONFLICTING'})),
					pr1: connection(pr(11, 'RUNNING')),
				},
			});
		},
		null,
		undefined,
		async directory =>
			directory === '/a'
				? [shared, {project: 'org/ui', branch: 'feature/ui'}, shared]
				: [shared],
	);
	const result = await provider.getBulkRailStatus(['a', 'b', 'a'], paths);
	t.deepEqual(result.get('a'), {
		pipeline: 'progressing_dirty',
		unresolvedCommentCount: 2,
		hasConflict: true,
	});
	t.deepEqual(result.get('b'), {
		pipeline: 'failing',
		unresolvedCommentCount: 1,
		hasConflict: true,
		prNumber: 11,
	});
	t.is(calls.length, 1);
	const query = calls[0]!.join(' ');
	t.true(query.includes('name: "api"'));
	t.true(query.includes('name: "ui"'));
	t.true(query.includes('qualifiedName: "refs/heads/sd-real-branch"'));
	t.true(query.includes('qualifiedName: "refs/heads/feature/ui"'));
	t.true(query.includes('associatedPullRequests('));
	t.true(query.includes('states: OPEN'));
	t.true(query.includes('field: UPDATED_AT, direction: DESC'));
	t.false(query.includes('search('));
	t.false(query.includes('pr2:'));
});

test('rereads repository and branch after switching a checkout', async t => {
	let repo = {project: 'org/a', branch: 'first'};
	const queries: string[] = [];
	const provider = new GitHubProvider(
		async args => {
			queries.push(args.join(' '));
			return JSON.stringify({data: {pr0: connection(pr(queries.length))}});
		},
		null,
		undefined,
		async () => [repo],
	);
	await provider.getBulkRailStatus(['a'], paths);
	repo = {project: 'org/b', branch: 'second'};
	const result = await provider.getBulkRailStatus(['a'], paths);
	t.is(result.get('a')?.prNumber, 2);
	t.true(queries[1]!.includes('name: "b"'));
	t.true(queries[1]!.includes('qualifiedName: "refs/heads/second"'));
	t.false(queries[1]!.includes('refs/heads/first'));
});

test('partial repository failure preserves the whole workspace, not independent workspaces', async t => {
	const provider = new GitHubProvider(
		async () =>
			JSON.stringify({
				data: {
					pr0: connection(pr(1)),
					pr1: connection(pr(2)),
					pr2: connection(pr(3)),
				},
				errors: [
					{message: 'denied', path: ['pr1', 'ref', 'associatedPullRequests']},
				],
			}),
		null,
		undefined,
		async directory =>
			directory === '/a'
				? [
						{project: 'org/a', branch: 'one'},
						{project: 'org/b', branch: 'two'},
					]
				: [{project: 'org/a', branch: 'three'}],
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	t.false(result.has('a'));
	t.is(result.get('b')?.prNumber, 3);
});

for (const reply of [
	'{}',
	'not json',
	JSON.stringify({data: {pr0: null}}),
	JSON.stringify({
		data: {pr0: connection(pr(1))},
		errors: [{message: 'unscoped failure'}],
	}),
]) {
	test(`failed response preserves previous workspace status: ${reply}`, async t => {
		const provider = new GitHubProvider(
			async () => reply,
			null,
			undefined,
			async () => [{project: 'org/a', branch: 'one'}],
		);
		const result = await provider.getBulkRailStatus(['a'], paths);
		t.is(result.size, 0);
	});
}

test('discovery failures and empty discovery do not query an unrelated root repo', async t => {
	const provider = new GitHubProvider(
		async () => {
			t.fail('No API request without discovered repositories');
			return '{}';
		},
		'unrelated/root',
		undefined,
		async directory => {
			if (directory === '/a') throw new Error('unavailable checkout');
			return [];
		},
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	t.false(result.has('a'));
	t.deepEqual(result.get('b'), {pipeline: null, unresolvedCommentCount: 0});
});

test('an unpublished branch has no PR, while a missing repository preserves status', async t => {
	const provider = new GitHubProvider(
		async () => JSON.stringify({data: {pr0: {ref: null}, pr1: null}}),
		null,
		undefined,
		async directory => [{project: `org/${directory.slice(1)}`, branch: 'new'}],
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	t.deepEqual(result.get('a'), {pipeline: null, unresolvedCommentCount: 0});
	t.false(result.has('b'));
});

test('no-PR repos do not suppress a matching PR and pathless callers still search by issue key', async t => {
	const queries: string[] = [];
	const provider = new GitHubProvider(
		async args => {
			queries.push(args.join(' '));
			return JSON.stringify({
				data:
					queries.length === 1
						? {pr0: connection(), pr1: connection(pr(7))}
						: {pr0: {nodes: [pr(9)]}},
			});
		},
		'org/root',
		undefined,
		async () => [
			{project: 'org/root', branch: 'a'},
			{project: 'org/nested', branch: 'feature'},
		],
	);
	const result = await provider.getBulkRailStatus(['a', 'pathless'], paths);
	t.is(result.get('a')?.prNumber, 7);
	t.is(result.get('pathless')?.prNumber, 9);
	t.true(queries[1]!.includes('head:pathless'));
});

test.serial(
	'discovery and API requests use the same enterprise host',
	async t => {
		const previous = process.env['GH_HOST'];
		process.env['GH_HOST'] = 'github.example.com';
		t.teardown(() => {
			if (previous === undefined) delete process.env['GH_HOST'];
			else process.env['GH_HOST'] = previous;
		});
		const provider = new GitHubProvider(
			async args => {
				t.is(args[args.indexOf('--hostname') + 1], 'github.example.com');
				return JSON.stringify({data: {pr0: connection()}});
			},
			null,
			undefined,
			async (_, host) => {
				t.is(host, 'github.example.com');
				return [{project: 'org/repo', branch: 'feature'}];
			},
		);
		const result = await provider.getBulkRailStatus(['a'], paths);
		t.deepEqual(result.get('a'), {
			pipeline: null,
			unresolvedCommentCount: 0,
		});
	},
);
