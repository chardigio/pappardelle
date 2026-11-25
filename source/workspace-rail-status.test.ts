import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
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

test('workspace repos and actual branches are batched across projects and aggregated', async () => {
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
	expect(statuses.get('RXAI-197')).toStrictEqual({
		pipeline: 'progressing_dirty',
		unresolvedCommentCount: 2,
		hasConflict: true,
	});
	expect(statuses.get('RXAI-181')?.prNumber).toBe(55);
	expect(calls.length).toBe(1);
	const query = calls[0]!.join(' ');
	expect(query.includes('rex/agent')).toBe(true);
	expect(query.includes('rex/catalyst')).toBe(true);
	expect(query.includes('sd-RXAI-197-feature')).toBe(true);
	expect(query.includes('mr3:')).toBe(false);
});

test('branch switches and project changes bypass the cache', async () => {
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
	expect(calls).toBe(1);
	repository = {...repository, branch: 'second'};
	const switched = await provider.getBulkRailStatus(['ticket'], paths);
	expect(switched.get('ticket')?.pipeline).toBe('failing');
	expect(calls).toBe(2);
	repository = {...repository, project: 'rex/b'};
	await provider.getBulkRailStatus(['ticket'], paths);
	expect(calls).toBe(3);
});

test('failed project preserves entire workspace while independent workspace updates', async () => {
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
	expect(statuses.has('a')).toBe(false);
	expect(statuses.get('b')?.pipeline).toBe('passing');
});

test('nested repo discovery failure preserves state instead of reporting no MR', async () => {
	const provider = new GitLabProvider(
		undefined,
		async () => {
			unreachable('No API request for a failed discovery');
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
	expect(statuses.size).toBe(0);
});

test('cross-project pagination stays on the MR project', async () => {
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
	expect(statuses.get('a')?.unresolvedCommentCount).toBe(3);
	expect(statuses.get('a')?.pipeline).toBe('passing');
	expect(queries[1]!.includes('rex/b')).toBe(true);
	expect(queries[1]!.includes('rex/a')).toBe(false);
});
