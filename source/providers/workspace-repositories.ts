import {execFile} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {readRemoteUrls, remoteProjects} from '../git-remotes.ts';
import {workspaceIdentity} from '../link-pr.ts';
import type {SpaceStateDao} from '../space-state.ts';

const execFileAsync = promisify(execFile);
export interface WorkspaceRepository {
	project: string;
	branch: string;
}
export type RepositoryDiscovery = (
	directory: string,
	host: string,
) => Promise<WorkspaceRepository[]>;
/** The space-state store of the repo a workspace turns out to belong to. */
export type SpaceStateLookup = (
	repoName: string,
) => Pick<SpaceStateDao, 'read'>;

const EXCLUDED = new Set([
	'node_modules',
	'vendor',
	'dist',
	'build',
	'target',
	'coverage',
	'__pycache__',
]);

/**
 * The repositories checked out in a workspace, each with the branch the rail
 * should follow. With `spaceStateFor`, a checkout that `link-pr` recorded a
 * PR for follows that PR's published branch instead of its local one.
 */
export async function discoverWorkspaceRepositories(
	directory: string,
	host: string,
	spaceStateFor?: SpaceStateLookup,
): Promise<WorkspaceRepository[]> {
	const repositories: Array<WorkspaceRepository & {remotes: Set<string>}> = [];
	let visited = 0;
	const git = async (cwd: string, args: string[]) => {
		const {stdout} = await execFileAsync('git', ['-C', cwd, ...args], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return stdout.trim();
	};
	async function visit(current: string, depth: number): Promise<void> {
		if (++visited > 4096)
			throw new Error(
				'Workspace repository discovery exceeded 4096 directories',
			);
		const entries = await readdir(current, {withFileTypes: true});
		if (
			entries.some(entry => entry.name === '.git' && !entry.isSymbolicLink())
		) {
			const remotes = remoteProjects(
				await readRemoteUrls(async args => git(current, args)),
				host,
			);
			const project = remotes.get('origin');
			if (project) {
				const branch = await git(current, [
					'symbolic-ref',
					'--quiet',
					'--short',
					'HEAD',
				]).catch((error: unknown) => {
					if ((error as {code?: number}).code === 1) return '';
					throw error;
				});
				if (branch)
					repositories.push({
						project,
						branch,
						remotes: new Set(remotes.values()),
					});
			}
			// Nested repos are independent checkouts; their source trees need no scan.
			if (depth > 0) return;
		}
		if (depth >= 3) return;
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (
				entry.isDirectory() &&
				!entry.name.startsWith('.') &&
				!EXCLUDED.has(entry.name)
			) {
				await visit(path.join(current, entry.name), depth + 1);
			}
		}
	}
	await visit(directory, 0);
	const identity = spaceStateFor
		? await workspaceIdentity(directory).catch(() => null)
		: null;
	const links =
		(identity &&
			spaceStateFor?.(identity.repoName).read(identity.issueKey)?.prLinks) ??
		[];
	return repositories.map(({remotes, ...repository}) => {
		const link = links.find(
			item =>
				item.host === host &&
				remotes.has(item.project) &&
				item.localBranch === repository.branch,
		);
		return link
			? {project: link.project, branch: link.remoteBranch}
			: repository;
	});
}
