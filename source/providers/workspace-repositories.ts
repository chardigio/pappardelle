import {execFile} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
export interface WorkspaceRepository {
	project: string;
	branch: string;
}
export type RepositoryDiscovery = (
	directory: string,
	host: string,
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

export function gitlabProject(remote: string, host: string): string | null {
	let remoteHost: string;
	let project: string;
	if (remote.includes('://')) {
		const url = new URL(remote);
		if (!['ssh:', 'http:', 'https:', 'git:'].includes(url.protocol))
			return null;
		remoteHost = url.hostname;
		project = url.pathname.slice(1);
	} else {
		const match = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
		if (!match) return null;
		remoteHost = match[1]!;
		project = match[2]!;
	}
	if (remoteHost.toLowerCase() !== host.toLowerCase()) return null;
	project = project.replace(/\.git$/, '');
	if (
		project.split('/').length < 2 ||
		project.split('/').some(part => !part || part === '..')
	)
		return null;
	return project;
}

export const discoverWorkspaceRepositories: RepositoryDiscovery = async (
	directory,
	host,
) => {
	const repositories: WorkspaceRepository[] = [];
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
			const remote = await git(current, [
				'config',
				'--get',
				'remote.origin.url',
			]).catch((error: unknown) => {
				if ((error as {code?: number}).code === 1) return '';
				throw error;
			});
			const project = gitlabProject(remote, host);
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
				if (branch) repositories.push({project, branch});
			}
			// Nested repos are independent checkouts; their source trees need no scan.
			if (depth > 0) return;
		}
		if (depth >= 3) return;
		for (const entry of entries) {
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
	return repositories;
};
