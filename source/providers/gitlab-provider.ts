// GitLab VCS host provider — wraps glab CLI
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from '../logger.ts';
import {RAIL_STATUS_POLL_INTERVAL_MS} from '../rail-status.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import type {PRInfo, PRLink, RailStatus, VcsHostProvider} from './types.ts';
import {aggregateRailStatus} from './aggregate-rail-status.ts';

import {
	discoverWorkspaceRepositories,
	type RepositoryDiscovery,
	type WorkspaceRepository,
} from './workspace-repositories.ts';

const log = createLogger('gitlab-provider');
const execFileAsync = promisify(execFile);
export type GlabExecutor = (args: string[]) => Promise<string>;
const emptyStatus = (): RailStatus => ({
	pipeline: null,
	unresolvedCommentCount: 0,
});
type PendingDiscussions = Map<
	string,
	{
		key: string;
		project: string;
		status: RailStatus;
		cursor: string;
		seen: Set<string>;
	}
>;
const DISCUSSION_FIELDS =
	'nodes { resolvable resolved } pageInfo { hasNextPage endCursor }';
// GitLab rejects a whole request above 250 complexity for authenticated
// users. Costs were measured with `queryComplexity { score }`; the budget
// sits below the limit in case GitLab rescores these fields.
const MAX_QUERY_COMPLEXITY = 200;
const PROJECT_COST = 1;
const MR_SELECTION_COST = 15;
const DISCUSSION_SELECTION_COST = 8;
type Selection = {project: string; body: string; cost: number};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Malformed GitLab rail response');
	}
	return value as Record<string, unknown>;
}

function readDiscussions(value: unknown): {
	count: number;
	cursor: string | null;
} {
	const data = object(value);
	if (!Array.isArray(data['nodes']))
		throw new Error('Missing GitLab discussions');
	let count = 0;
	for (const node of data['nodes']) {
		const discussion = object(node);
		if (
			typeof discussion['resolvable'] !== 'boolean' ||
			typeof discussion['resolved'] !== 'boolean'
		) {
			throw new TypeError('Invalid GitLab discussion state');
		}
		if (discussion['resolvable'] && !discussion['resolved']) count++;
	}
	const info = object(data['pageInfo']);
	if (
		typeof info['hasNextPage'] !== 'boolean' ||
		(info['hasNextPage'] &&
			(typeof info['endCursor'] !== 'string' || !info['endCursor']))
	) {
		throw new Error('Invalid GitLab discussion pagination');
	}
	return {
		count,
		cursor: info['hasNextPage'] ? (info['endCursor'] as string) : null,
	};
}

function parseMr(value: unknown): {status: RailStatus; cursor: string | null} {
	const mr = object(value);
	const prNumber = Number(mr['iid']);
	if (
		!Number.isSafeInteger(prNumber) ||
		prNumber <= 0 ||
		typeof mr['detailedMergeStatus'] !== 'string' ||
		!('headPipeline' in mr)
	) {
		throw new Error('Invalid GitLab MR status');
	}
	let pipeline: RailStatus['pipeline'] = null;
	if (mr['headPipeline'] !== null) {
		const raw = object(mr['headPipeline'])['status'];
		if (typeof raw !== 'string')
			throw new Error('Missing GitLab pipeline status');
		pipeline =
			raw === 'SUCCESS' || raw === 'SKIPPED'
				? 'passing'
				: raw === 'FAILED' || raw === 'CANCELED'
					? 'failing'
					: 'progressing_clean';
	}
	const {count, cursor} = readDiscussions(mr['discussions']);
	return {
		status: {
			pipeline,
			prNumber,
			hasConflict: mr['detailedMergeStatus'] === 'CONFLICT',
			unresolvedCommentCount: count,
		},
		cursor,
	};
}

export class GitLabProvider implements VcsHostProvider {
	get name() {
		return 'gitlab';
	}

	private readonly host?: string;
	private readonly executor: GlabExecutor;
	private readonly now: () => number;
	private projectPath?: string;
	private readonly discover: RepositoryDiscovery;
	private readonly railCache = new Map<
		string,
		{status: RailStatus; expiresAt: number}
	>();

	constructor(
		host?: string,
		executor?: GlabExecutor,
		now = Date.now,
		discover = discoverWorkspaceRepositories,
	) {
		this.discover = discover;
		this.host = host;
		this.now = now;
		this.executor =
			executor ??
			(async args => {
				const {stdout} = await execFileAsync('glab', args, {
					encoding: 'utf-8',
					timeout: 15_000,
					env: {...process.env, ...(host ? {GITLAB_HOST: host} : {})},
				});
				return stdout;
			});
	}

	async getPRLink(issueKey: string): Promise<PRLink | null> {
		// GitLab doesn't store MR links in issue tracker attachments like Linear.
		// Discover MR by branch name (branch name matches issue key).
		const mrOutput = await this.executor([
			'mr',
			'list',
			'--source-branch',
			issueKey,
			'-F',
			'json',
		]);
		const mrs = JSON.parse(mrOutput) as Array<{
			iid: number;
			web_url: string;
		}>;

		const mr = mrs[0];
		return mr ? {number: mr.iid, url: mr.web_url} : null;
	}

	async checkIssueHasPRWithCommits(issueKey: string): Promise<PRInfo> {
		try {
			const mr = await this.getPRLink(issueKey);
			if (!mr) return {hasPR: false, hasCommits: false};

			// Check if MR has file changes via diff
			try {
				const diffOutput = await this.executor([
					'mr',
					'diff',
					String(mr.number),
					'--color=never',
				]);
				// Count diff file headers (lines starting with "diff --git")
				const fileCount = (diffOutput.match(/^diff --git/gm) ?? []).length;

				log.debug(
					`Issue ${issueKey} has MR !${mr.number} with ${fileCount} files changed`,
				);
				return {
					hasPR: true,
					hasCommits: fileCount > 0,
					prNumber: mr.number,
					prUrl: mr.url,
				};
			} catch (err) {
				log.warn(
					`Failed to check MR diff for ${issueKey}`,
					err instanceof Error ? err : undefined,
				);
				return {
					hasPR: true,
					hasCommits: false,
					prNumber: mr.number,
					prUrl: mr.url,
				};
			}
		} catch (err) {
			log.warn(
				`Failed to check issue ${issueKey} for MR`,
				err instanceof Error ? err : undefined,
			);
			return {hasPR: false, hasCommits: false};
		}
	}

	async buildPRUrl(prNumber: number): Promise<string> {
		const host = this.host ?? 'gitlab.com';
		return `https://${host}/-/merge_requests/${prNumber}`;
	}

	private async getProjectPath(): Promise<string> {
		if (this.projectPath) return this.projectPath;
		const data = object(
			JSON.parse(await this.executor(['repo', 'view', '-F', 'json'])),
		);
		const path = data['path_with_namespace'];
		if (
			typeof path !== 'string' ||
			path.split('/').length < 2 ||
			path.split('/').some(part => !part)
		) {
			throw new Error('Missing GitLab project path');
		}
		this.projectPath = path;
		return path;
	}

	private async queryProjects(
		selections: Selection[],
		failure: string,
	): Promise<Record<string, unknown>> {
		const chunks: Array<Map<string, string[]>> = [];
		let chunk = new Map<string, string[]>();
		let cost = 0;
		for (const {project, body, cost: bodyCost} of selections) {
			let fields = chunk.get(project);
			const projectCost = fields ? 0 : PROJECT_COST;
			if (
				chunk.size > 0 &&
				cost + projectCost + bodyCost > MAX_QUERY_COMPLEXITY
			) {
				chunks.push(chunk);
				chunk = new Map();
				cost = 0;
				fields = undefined;
			}
			if (!fields) {
				fields = [];
				chunk.set(project, fields);
				cost += PROJECT_COST;
			}
			fields.push(body);
			cost += bodyCost;
		}
		if (chunk.size > 0) chunks.push(chunk);

		const result: Record<string, unknown> = {};
		for (const chunk of chunks) {
			try {
				Object.assign(result, await this.queryChunk(chunk));
			} catch (err) {
				log.warn(failure, sanitizeSubprocessError(err));
			}
		}
		return result;
	}

	private async queryChunk(
		fields: Map<string, string[]>,
	): Promise<Record<string, unknown>> {
		const projects = [...fields.keys()];
		const aliases = projects.map((_, i) =>
			i === 0 ? 'project' : `project${i}`,
		);
		const query = `query { ${projects
			.map(
				(path, i) =>
					`${aliases[i]}: project(fullPath: ${JSON.stringify(path)}) { ${fields.get(path)!.join('\n')} }`,
			)
			.join('\n')} }`;
		const args = ['api', 'graphql', '-f', `query=${query}`];
		if (this.host) args.push('--hostname', this.host);
		const response = object(JSON.parse(await this.executor(args)));
		const data = object(response['data']);
		const failed = new Set<string>();
		if (Array.isArray(response['errors']) && response['errors'].length > 0) {
			log.warn(
				'Partial GraphQL errors in GitLab rail status',
				new Error(
					response['errors']
						.map(error => String(object(error)['message']))
						.join('; '),
				),
			);
			for (const error of response['errors']) {
				const {path} = object(error);
				if (
					!Array.isArray(path) ||
					typeof path[0] !== 'string' ||
					!aliases.includes(path[0])
				) {
					throw new Error('Unscoped GitLab GraphQL failure');
				}
				failed.add(typeof path[1] === 'string' ? path[1] : path[0]);
			}
		}
		const result: Record<string, unknown> = {};
		for (const alias of aliases) {
			if (failed.has(alias) || !data[alias]) continue;
			for (const [key, value] of Object.entries(object(data[alias]))) {
				if (!failed.has(key)) result[key] = value;
			}
		}
		return result;
	}

	private async finishDiscussions(
		pending: PendingDiscussions,
		complete: (key: string, status: RailStatus) => void,
	): Promise<void> {
		while (pending.size > 0) {
			const project = await this.queryProjects(
				[...pending].map(([alias, entry]) => ({
					project: entry.project,
					body: `${alias}: mergeRequest(iid: ${JSON.stringify(String(entry.status.prNumber))}) {
						discussions(first: 100, after: ${JSON.stringify(entry.cursor)}) { ${DISCUSSION_FIELDS} }
					}`,
					cost: DISCUSSION_SELECTION_COST,
				})),
				'Failed to fetch GitLab discussion pages',
			);
			for (const [alias, entry] of pending) {
				if (!(alias in project)) {
					pending.delete(alias);
					continue;
				}
				try {
					const {count, cursor} = readDiscussions(
						object(project[alias])['discussions'],
					);
					entry.status.unresolvedCommentCount += count;
					if (cursor === null) {
						complete(entry.key, entry.status);
						pending.delete(alias);
						continue;
					}
					if (entry.seen.has(cursor))
						throw new Error('Repeated GitLab discussion cursor');
					entry.seen.add(cursor);
					entry.cursor = cursor;
				} catch (err) {
					pending.delete(alias);
					log.warn(
						'Incomplete GitLab discussions',
						sanitizeSubprocessError(err),
					);
				}
			}
		}
	}

	async getRailStatus(issueKey: string): Promise<RailStatus> {
		const result = await this.getBulkRailStatus([issueKey]);
		return result.get(issueKey) ?? emptyStatus();
	}

	async getBulkRailStatus(
		issueKeys: string[],
		workspacePaths?: ReadonlyMap<string, string>,
	): Promise<Map<string, RailStatus>> {
		const workspaces = new Map<string, string[]>();
		const repositories = new Map<string, WorkspaceRepository>();
		for (const issueKey of new Set(issueKeys)) {
			try {
				const directory = workspacePaths?.get(issueKey);
				const discovered = directory
					? await this.discover(
							directory,
							this.host ?? process.env['GITLAB_HOST'] ?? 'gitlab.com',
						)
					: [{project: await this.getProjectPath(), branch: issueKey}];
				const keys = new Set<string>();
				for (const repository of discovered) {
					const key = JSON.stringify([repository.project, repository.branch]);
					keys.add(key);
					repositories.set(key, repository);
				}
				workspaces.set(issueKey, [...keys]);
			} catch (err) {
				log.warn(
					'Failed to discover GitLab workspace repositories',
					sanitizeSubprocessError(err),
				);
			}
		}
		const statuses = await this.fetchRepositories(repositories);
		const result = new Map<string, RailStatus>();
		for (const [issueKey, keys] of workspaces) {
			// A partial snapshot could hide failures in a repo whose request failed.
			if (keys.some(key => !statuses.has(key))) continue;
			result.set(
				issueKey,
				aggregateRailStatus(keys.map(key => statuses.get(key)!)),
			);
		}
		return result;
	}

	private async fetchRepositories(
		repositories: Map<string, WorkspaceRepository>,
	): Promise<Map<string, RailStatus>> {
		const result = new Map<string, RailStatus>();
		const now = this.now();
		for (const [key, entry] of this.railCache) {
			if (entry.expiresAt <= now) this.railCache.delete(key);
		}
		const missing = new Map<string, WorkspaceRepository>();
		for (const [key, repository] of repositories) {
			const cached = this.railCache.get(key);
			if (cached) result.set(key, {...cached.status});
			else missing.set(key, repository);
		}
		if (missing.size === 0) return result;

		const complete = (key: string, status: RailStatus) => {
			this.railCache.set(key, {
				status: {...status},
				// Expire from poll start so request latency does not skip the next poll.
				expiresAt: now + RAIL_STATUS_POLL_INTERVAL_MS,
			});
			result.set(key, status);
		};
		const requests = [...missing].map(([key, repository], i) => ({
			key,
			...repository,
			alias: `mr${i}`,
		}));
		const project = await this.queryProjects(
			requests.map(request => ({
				project: request.project,
				body: `${request.alias}: mergeRequests(sourceBranches: [${JSON.stringify(request.branch)}], state: opened, sort: UPDATED_DESC, first: 1) {
					nodes { iid detailedMergeStatus headPipeline { status }
						discussions(first: 100) { ${DISCUSSION_FIELDS} }
					}
				}`,
				cost: MR_SELECTION_COST,
			})),
			'Failed to fetch GitLab rail status',
		);
		const pending: PendingDiscussions = new Map();
		for (const {key, alias, project: path} of requests) {
			if (!(alias in project)) continue;
			try {
				const {nodes} = object(project[alias]);
				if (!Array.isArray(nodes)) throw new Error('Missing GitLab MR nodes');
				if (nodes.length === 0) {
					complete(key, emptyStatus());
					continue;
				}
				const {status, cursor} = parseMr(nodes[0]);
				if (cursor === null) complete(key, status);
				else
					pending.set(alias, {
						key,
						project: path,
						status,
						cursor,
						seen: new Set([cursor]),
					});
			} catch (err) {
				log.warn('Invalid GitLab rail status', sanitizeSubprocessError(err));
			}
		}
		await this.finishDiscussions(pending, complete);
		return result;
	}
}
