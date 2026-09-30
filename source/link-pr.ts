import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getSpaceStatePath, readSpaceState} from './space-state.ts';

const exec = promisify(execFile);
export type LinkExecutor = (
	command: string,
	args: string[],
	cwd: string,
) => Promise<string>;
const execute: LinkExecutor = async (command, args, cwd) => {
	const {stdout} = await exec(command, args, {
		cwd,
		encoding: 'utf-8',
		timeout: 15_000,
	});
	return stdout.trim();
};

export async function workspaceIdentity(directory: string, run = execute) {
	const common = await run(
		'git',
		['rev-parse', '--path-format=absolute', '--git-common-dir'],
		directory,
	);
	const branch = await run(
		'git',
		['symbolic-ref', '--quiet', '--short', 'HEAD'],
		directory,
	);
	return {repoName: path.basename(path.dirname(common)), issueKey: branch};
}

export async function linkPr(
	urlString: string,
	directory: string,
	workspace = directory,
	options: {run?: LinkExecutor; baseDir?: string; gitlabHost?: string} = {},
) {
	const {run = execute, baseDir} = options;
	const relative = path.relative(
		path.resolve(workspace),
		path.resolve(directory),
	);
	if (
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error('Source repository must be inside the workspace');
	const url = new URL(urlString);
	const match = /^\/(.+)\/(pull|-\/merge_requests)\/([1-9]\d*)\/?$/.exec(
		url.pathname,
	);
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!match
	)
		throw new Error('Expected an HTTPS GitHub PR or GitLab MR URL');
	const [, target, kind, id] = match;
	const host = kind === 'pull' ? url.host : (options.gitlabHost ?? url.host);
	let project: string;
	let remoteBranch: string;
	if (kind === 'pull') {
		const pr = JSON.parse(
			await run(
				'gh',
				['api', '--hostname', url.host, `repos/${target}/pulls/${id}`],
				directory,
			),
		);
		project = pr.head?.repo?.full_name;
		remoteBranch = pr.head?.ref;
		if (pr.state !== 'open' || pr.number !== Number(id))
			throw new Error('PR must be open');
	} else {
		const mr = JSON.parse(
			await run(
				'glab',
				[
					'api',
					'--hostname',
					host,
					`projects/${encodeURIComponent(target!)}/merge_requests/${id}`,
				],
				directory,
			),
		);
		if (
			mr.state !== 'opened' ||
			mr.iid !== Number(id) ||
			!Number.isSafeInteger(mr.source_project_id)
		)
			throw new Error('MR must be open');
		if (host !== url.host && mr.web_url !== urlString.replace(/\/$/, ''))
			throw new Error('MR URL does not match configured GitLab host');
		const source = JSON.parse(
			await run(
				'glab',
				['api', '--hostname', host, `projects/${mr.source_project_id}`],
				directory,
			),
		);
		project = source.path_with_namespace;
		remoteBranch = mr.source_branch;
	}
	if (
		typeof project !== 'string' ||
		!project.includes('/') ||
		typeof remoteBranch !== 'string' ||
		!remoteBranch
	)
		throw new Error('Missing source repository or branch in PR/MR response');
	const origin = await run('git', ['remote', 'get-url', 'origin'], directory);
	const originHost = origin.includes('://')
		? new URL(origin).hostname
		: /^(?:[^@/:]+@)?([^/:]+):/.exec(origin)?.[1];
	const originPath = origin
		.replace(/^.*?:\/\/(?:[^@/]+@)?[^/]+\//, '')
		.replace(/^[^/]+:/, '')
		.replace(/\.git$/, '');
	if (originHost !== host || originPath !== project)
		throw new Error(
			`Run link-pr from the source repository (${url.host}/${project})`,
		);
	const localBranch = await run(
		'git',
		['symbolic-ref', '--quiet', '--short', 'HEAD'],
		directory,
	);
	const {repoName, issueKey} = await workspaceIdentity(workspace, run);
	const state = readSpaceState(repoName, issueKey, baseDir) ?? {};
	const link = {
		host,
		project,
		localBranch,
		remoteBranch,
		url: urlString,
		number: Number(id),
	};
	state.prLinks = [
		...(state.prLinks ?? []).filter(
			item =>
				!(
					item.host === link.host &&
					item.project === project &&
					item.localBranch === localBranch
				),
		),
		link,
	];
	const file = getSpaceStatePath(repoName, issueKey, baseDir);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, {force: true});
	}
	return {file, link};
}
