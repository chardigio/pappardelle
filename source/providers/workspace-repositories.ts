import {execFile} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {remoteProjects, remoteUrlsArgs} from '../git-remotes.ts';
import {workspaceIdentity} from '../link-pr.ts';
import {readSpaceState} from '../space-state.ts';

const execFileAsync = promisify(execFile);
export interface WorkspaceRepository {
	project: string;
	branch: string;
}
export type RepositoryDiscovery = (
	directory: string,
	host: string,
	stateBaseDir?: string,
) => Promise<WorkspaceRepository[]>;

const EXCLUDED = new Set([
	'node_modules',
	'vendor',
	'dist',
	'build',
	'target',
	'coverage',
	'__pycache__',
]);

export const discoverWorkspaceRepositories: RepositoryDiscovery = async (
	directory,
	host,
	stateBaseDir,
) => {
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
				await git(current, remoteUrlsArgs).catch((error: unknown) => {
					if ((error as {code?: number}).code === 1) return '';
					throw error;
				}),
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
	const identity = await workspaceIdentity(directory).catch(() => null);
	const links = identity
		? (readSpaceState(identity.repoName, identity.issueKey, stateBaseDir)
				?.prLinks ?? [])
		: [];
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
};
