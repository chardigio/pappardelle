export function remoteProject(remote: string, host: string): string | null {
	let remoteHost: string;
	let project: string;
	if (remote.includes('://')) {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			return null;
		}

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

export const remoteUrlsArgs = [
	'config',
	'--get-regexp',
	String.raw`^remote\..+\.url$`,
];

export function remoteProjects(remoteUrlsOutput: string, host: string) {
	const projects = new Map<string, string>();
	for (const line of remoteUrlsOutput.split('\n')) {
		const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
		const project = match && remoteProject(match[2]!, host);
		if (project) projects.set(match[1]!, project);
	}
	return projects;
}
