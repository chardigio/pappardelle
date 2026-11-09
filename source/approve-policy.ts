// Which permission prompts an agent may approve for another space without a
// person: commands that only clean up QA scratch, never publish anything, and
// never touch the user's real tmux server.

export type ApprovalVerdict = {allow: true} | {allow: false; reason: string};

export type ApprovalPolicy = {
	/** Directory prefixes an `rm -r`/`rm -f` may target, such as `/tmp/q-`. */
	scratchRoots: readonly string[];
};

const PUBLISHING: Array<[RegExp, string]> = [
	[/\bgit\s+push\b/, 'git push'],
	[/\bgh\s+pr\s+(?:merge|create|close|edit)\b/, 'changes a pull request'],
	[/\bgh\s+api\b.*\s-X\b/, 'gh api with a method'],
	[/--force\b/, '--force'],
	[/\breset\s+--hard\b/, 'git reset --hard'],
];

// QA isolates tmux on a socket under /tmp/q-*, or through the qtmux/qkill
// wrappers; anything else reaches the user's sessions.
const ISOLATED_TMUX = /-S\s+["']?\/tmp\/q-|\bq(?:kill|tmux|env)\b/;

const RM = /\brm((?:\s+-[a-zA-Z]+)+)\s+([^;&|\n]+)/g;
const HOME_ASSIGNMENT =
	/\b([A-Za-z_]\w*)=["']?(?:\/home\b|\/Users\b|~|\$HOME\b|\/(?:[\s;&|"']|$))/g;

function rmTargets(command: string): string[] {
	const targets: string[] = [];
	for (const match of command.matchAll(RM)) {
		if (!/[rf]/.test(match[1]!)) continue;
		targets.push(
			...match[2]!
				.trim()
				.split(/\s+/)
				.filter(target => !target.startsWith('-')),
		);
	}

	return targets;
}

function unquote(target: string): string {
	return target.replace(/^(["'])(.*)\1$/, '$2');
}

export function checkApproval(
	command: string,
	policy: ApprovalPolicy,
): ApprovalVerdict {
	for (const [pattern, what] of PUBLISHING) {
		if (pattern.test(command)) return {allow: false, reason: what};
	}

	if (/\bkill-server\b/.test(command) && !ISOLATED_TMUX.test(command)) {
		return {allow: false, reason: 'kill-server outside an isolated socket'};
	}

	const homeVariables = new Set(
		[...command.matchAll(HOME_ASSIGNMENT)].map(match => match[1]!),
	);
	for (const raw of rmTargets(command)) {
		const target = unquote(raw);
		const variable = /^\$\{?([A-Za-z_]\w*)/.exec(target)?.[1];
		if (variable) {
			if (homeVariables.has(variable)) {
				return {allow: false, reason: `rm of $${variable}, set to a home path`};
			}

			continue;
		}

		if (!policy.scratchRoots.some(root => target.startsWith(root))) {
			return {allow: false, reason: `rm outside QA scratch: ${target}`};
		}
	}

	return {allow: true};
}
