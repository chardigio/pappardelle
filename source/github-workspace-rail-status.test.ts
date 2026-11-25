import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {teardown} from '../test/helpers/teardown.ts';
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

test('batches exact branches across repos and deduplicates shared checkouts', async () => {
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
		async directory =>
			directory === '/a'
				? [shared, {project: 'org/ui', branch: 'feature/ui'}, shared]
				: [shared],
	);
	const result = await provider.getBulkRailStatus(['a', 'b', 'a'], paths);
	expect(result.get('a')).toStrictEqual({
		pipeline: 'progressing_dirty',
		unresolvedCommentCount: 2,
		hasConflict: true,
	});
	expect(result.get('b')).toStrictEqual({
		pipeline: 'failing',
		unresolvedCommentCount: 1,
		hasConflict: true,
		prNumber: 11,
	});
	expect(calls.length).toBe(1);
	const query = calls[0]!.join(' ');
	expect(query.includes('name: "api"')).toBe(true);
	expect(query.includes('name: "ui"')).toBe(true);
	expect(query.includes('qualifiedName: "refs/heads/sd-real-branch"')).toBe(
		true,
	);
	expect(query.includes('qualifiedName: "refs/heads/feature/ui"')).toBe(true);
	expect(query.includes('associatedPullRequests(')).toBe(true);
	expect(query.includes('states: OPEN')).toBe(true);
	expect(query.includes('field: UPDATED_AT, direction: DESC')).toBe(true);
	expect(query.includes('search(')).toBe(false);
	expect(query.includes('pr2:')).toBe(false);
});

test('rereads repository and branch after switching a checkout', async () => {
	let repo = {project: 'org/a', branch: 'first'};
	const queries: string[] = [];
	const provider = new GitHubProvider(
		async args => {
			queries.push(args.join(' '));
			return JSON.stringify({data: {pr0: connection(pr(queries.length))}});
		},
		null,
		async () => [repo],
	);
	await provider.getBulkRailStatus(['a'], paths);
	repo = {project: 'org/b', branch: 'second'};
	const result = await provider.getBulkRailStatus(['a'], paths);
	expect(result.get('a')?.prNumber).toBe(2);
	expect(queries[1]!.includes('name: "b"')).toBe(true);
	expect(queries[1]!.includes('qualifiedName: "refs/heads/second"')).toBe(true);
	expect(queries[1]!.includes('refs/heads/first')).toBe(false);
});

test('partial repository failure preserves the whole workspace, not independent workspaces', async () => {
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
		async directory =>
			directory === '/a'
				? [
						{project: 'org/a', branch: 'one'},
						{project: 'org/b', branch: 'two'},
					]
				: [{project: 'org/a', branch: 'three'}],
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	expect(result.has('a')).toBe(false);
	expect(result.get('b')?.prNumber).toBe(3);
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
	test(`failed response preserves previous workspace status: ${reply}`, async () => {
		const provider = new GitHubProvider(
			async () => reply,
			null,
			async () => [{project: 'org/a', branch: 'one'}],
		);
		const result = await provider.getBulkRailStatus(['a'], paths);
		expect(result.size).toBe(0);
	});
}

test('discovery failures and empty discovery do not query an unrelated root repo', async () => {
	const provider = new GitHubProvider(
		async () => {
			unreachable('No API request without discovered repositories');
			return '{}';
		},
		'unrelated/root',
		async directory => {
			if (directory === '/a') throw new Error('unavailable checkout');
			return [];
		},
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	expect(result.has('a')).toBe(false);
	expect(result.get('b')).toStrictEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
	});
});

test('an unpublished branch has no PR, while a missing repository preserves status', async () => {
	const provider = new GitHubProvider(
		async () => JSON.stringify({data: {pr0: {ref: null}, pr1: null}}),
		null,
		async directory => [{project: `org/${directory.slice(1)}`, branch: 'new'}],
	);
	const result = await provider.getBulkRailStatus(['a', 'b'], paths);
	expect(result.get('a')).toStrictEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
	});
	expect(result.has('b')).toBe(false);
});

test('no-PR repos do not suppress a matching PR and pathless callers still search by issue key', async () => {
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
		async () => [
			{project: 'org/root', branch: 'a'},
			{project: 'org/nested', branch: 'feature'},
		],
	);
	const result = await provider.getBulkRailStatus(['a', 'pathless'], paths);
	expect(result.get('a')?.prNumber).toBe(7);
	expect(result.get('pathless')?.prNumber).toBe(9);
	expect(queries[1]!.includes('head:pathless')).toBe(true);
});

test('discovery and API requests use the same enterprise host', async () => {
	const previous = process.env['GH_HOST'];
	process.env['GH_HOST'] = 'github.example.com';
	teardown(() => {
		if (previous === undefined) delete process.env['GH_HOST'];
		else process.env['GH_HOST'] = previous;
	});
	const provider = new GitHubProvider(
		async args => {
			expect(args[args.indexOf('--hostname') + 1]).toBe('github.example.com');
			return JSON.stringify({data: {pr0: connection()}});
		},
		null,
		async (_, host) => {
			expect(host).toBe('github.example.com');
			return [{project: 'org/repo', branch: 'feature'}];
		},
	);
	const result = await provider.getBulkRailStatus(['a'], paths);
	expect(result.get('a')).toStrictEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
	});
});
