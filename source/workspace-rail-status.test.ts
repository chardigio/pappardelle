import test from 'ava';
import {GitLabProvider} from './providers/gitlab-provider.ts';
import type {RepositoryDiscovery} from './providers/workspace-repositories.ts';

const page = (hasNextPage = false) => ({
	nodes: [{resolvable: true, resolved: false}],
	pageInfo: {hasNextPage, endCursor: hasNextPage ? 'cursor' : null},
});
const mr = (status = 'SUCCESS', extra = {}) => ({
	iid: '42',
	detailedMergeStatus: 'MERGEABLE',
	headPipeline: {status},
	discussions: page(),
	...extra,
});
const response = (aliases: Record<string, unknown>) =>
	JSON.stringify({data: {project: aliases}});
const connection = (node = mr()) => ({nodes: [node]});

test('workspace repos and actual branches are batched across projects and aggregated', async t => {
	const calls: string[][] = [];
	const discover: RepositoryDiscovery = async directory =>
		directory === '/a'
			? [
					{project: 'rex/agent', branch: 'sd-RXAI-197-feature'},
					{project: 'rex/catalyst', branch: 'sd-ui'},
					{project: 'rex/agent', branch: 'sd-RXAI-197-feature'},
				]
			: [{project: 'rex/agent', branch: 'sd-other'}];
	const provider = new GitLabProvider(
		undefined,
		async args => {
			calls.push(args);
			return JSON.stringify({
				data: {
					project: {
						mr0: connection(mr('FAILED', {detailedMergeStatus: 'CONFLICT'})),
						mr2: connection(mr('SUCCESS', {iid: '55'})),
					},
					project1: {mr1: connection(mr('RUNNING', {iid: '42'}))},
				},
			});
		},
		() => 0,
		discover,
	);
	const statuses = await provider.getBulkRailStatus(
		['RXAI-197', 'RXAI-181'],
		new Map([
			['RXAI-197', '/a'],
			['RXAI-181', '/b'],
		]),
	);
	t.deepEqual(statuses.get('RXAI-197'), {
		pipeline: 'progressing_dirty',
		unresolvedCommentCount: 2,
		hasConflict: true,
	});
	t.is(statuses.get('RXAI-181')?.prNumber, 55);
	t.is(calls.length, 1);
	const query = calls[0]!.join(' ');
	t.true(query.includes('rex/agent'));
	t.true(query.includes('rex/catalyst'));
	t.true(query.includes('sd-RXAI-197-feature'));
	t.false(query.includes('mr3:'));
});

test('branch switches and project changes bypass the cache', async t => {
	let repository = {project: 'rex/a', branch: 'first'};
	let calls = 0;
	const provider = new GitLabProvider(
		undefined,
		async () => {
			calls++;
			return response({
				mr0: connection(mr(calls === 1 ? 'SUCCESS' : 'FAILED')),
			});
		},
		() => 0,
		async () => [repository],
	);
	const paths = new Map([['ticket', '/workspace']]);
	await provider.getBulkRailStatus(['ticket'], paths);
	await provider.getBulkRailStatus(['ticket'], paths);
	t.is(calls, 1);
	repository = {...repository, branch: 'second'};
	const switched = await provider.getBulkRailStatus(['ticket'], paths);
	t.is(switched.get('ticket')?.pipeline, 'failing');
	t.is(calls, 2);
	repository = {...repository, project: 'rex/b'};
	await provider.getBulkRailStatus(['ticket'], paths);
	t.is(calls, 3);
});

test('failed project preserves entire workspace while independent workspace updates', async t => {
	const discover: RepositoryDiscovery = async directory =>
		directory === '/a'
			? [
					{project: 'rex/a', branch: 'one'},
					{project: 'rex/b', branch: 'two'},
				]
			: [{project: 'rex/a', branch: 'three'}];
	const provider = new GitLabProvider(
		undefined,
		async () =>
			JSON.stringify({
				data: {
					project: {mr0: connection(), mr2: connection()},
					project1: null,
				},
				errors: [{message: 'denied', path: ['project1']}],
			}),
		() => 0,
		discover,
	);
	const statuses = await provider.getBulkRailStatus(
		['a', 'b'],
		new Map([
			['a', '/a'],
			['b', '/b'],
		]),
	);
	t.false(statuses.has('a'));
	t.is(statuses.get('b')?.pipeline, 'passing');
});

test('nested repo discovery failure preserves state instead of reporting no MR', async t => {
	const provider = new GitLabProvider(
		undefined,
		async () => {
			t.fail('No API request for a failed discovery');
			return '{}';
		},
		() => 0,
		async () => {
			throw new Error('checkout unavailable');
		},
	);
	const statuses = await provider.getBulkRailStatus(
		['a'],
		new Map([['a', '/a']]),
	);
	t.is(statuses.size, 0);
});

test('cross-project pagination stays on the MR project', async t => {
	const queries: string[] = [];
	const replies = [
		JSON.stringify({
			data: {
				project: {mr0: connection()},
				project1: {mr1: connection(mr('SUCCESS', {discussions: page(true)}))},
			},
		}),
		response({mr1: {discussions: page()}}),
	];
	const provider = new GitLabProvider(
		undefined,
		async args => {
			queries.push(args.join(' '));
			return replies.shift()!;
		},
		() => 0,
		async () => [
			{project: 'rex/a', branch: 'one'},
			{project: 'rex/b', branch: 'two'},
		],
	);
	const statuses = await provider.getBulkRailStatus(
		['a'],
		new Map([['a', '/a']]),
	);
	t.is(statuses.get('a')?.unresolvedCommentCount, 3);
	t.is(statuses.get('a')?.pipeline, 'passing');
	t.true(queries[1]!.includes('rex/b'));
	t.false(queries[1]!.includes('rex/a'));
});
