// Which permission prompts an agent may approve for another space without a
// person: commands that only clean up QA scratch, never publish anything, and
// never touch the user's real tmux server. Anything this can't read plainly is
// refused, since a refusal only costs a person a look.

import path from 'node:path';

export type ApprovalVerdict =
	| {allow: true; reason?: string}
	| {allow: false; reason: string};

export type ApprovalPolicy = {
	/** Directory prefixes an `rm` may target, such as `/tmp/q-`. */
	scratchRoots: readonly string[];
};

const PUBLISHING: Array<[RegExp, string]> = [
	[/\bgit\b[^;&|\n]*\spush\b/, 'git push'],
	[
		/\bgh\s+[\w-]+(?:\s+[\w-]+)?\s+(?:create|merge|close|edit|delete|upload|comment|review|run|set|sync|fork|transfer|archive|reopen|ready)\b/,
		'changes something on GitHub',
	],
	[
		/\bgh\s+api\b[^;&|\n]*\s(?:-[XfF]|--method|--field|--raw-field|--input)/,
		'gh api that writes',
	],
	[/--force\b/, '--force'],
	[/\breset\s+--hard\b/, 'git reset --hard'],
	[
		/\bfind\b[^;&|\n]*\s-(?:delete|exec|execdir|ok)\b/,
		'find that deletes or runs commands',
	],
];

// QA isolates tmux on a socket under /tmp/q-*, or through the qtmux/qkill
// wrappers; anything else reaches the user's sessions.
const ISOLATED_TMUX = /-S\s+["']?\/tmp\/q-|\bq(?:kill|tmux|env)\b/;

const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const WORD = /"[^"]*"|'[^']*'|\S+/g;

function unquote(word: string): string {
	return word.replace(/^(["'])(.*)\1$/, '$2');
}

/** Variables the command sets to a fresh temp dir or a path under scratch. */
function scratchVariables(
	command: string,
	policy: ApprovalPolicy,
): Set<string> {
	const scratch = new Set<string>();
	const elsewhere = new Set<string>();
	for (const match of command.matchAll(
		/\b([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\$\([^)]*\)|\S+)/g,
	)) {
		const value = unquote(match[2]!);
		// Only the bare directory mktemp just made: nothing run beside it in
		// the subshell, and no path after it.
		const after = command[match.index + match[0].length];
		const freshDir =
			/^\$\(\s*mktemp(?:\s+[^\s;&|$`()]+)*\s*\)$/.test(value) &&
			(after === undefined || /[\s;&|]/.test(after));
		const safe = freshDir || isScratchPath(value, policy);
		(safe ? scratch : elsewhere).add(match[1]!);
	}

	// One assignment anywhere else, say a later D=$HOME, and it isn't scratch.
	for (const name of elsewhere) scratch.delete(name);
	return scratch;
}

function isScratchPath(target: string, policy: ApprovalPolicy): boolean {
	if (!target.startsWith('/') || target.split('/').includes('..')) return false;
	const normalized = path.posix.normalize(target);
	return policy.scratchRoots.some(root => normalized.startsWith(root));
}

function checkRm(
	words: string[],
	prefixed: Set<string>,
	command: string,
	policy: ApprovalPolicy,
): ApprovalVerdict {
	const scratch = scratchVariables(command, policy);
	// `D=/tmp/q-x rm -rf $D` sets D for rm only; the shell has already
	// expanded $D from the outer environment.
	for (const name of prefixed) scratch.delete(name);
	for (const word of words.slice(1)) {
		if (word.startsWith('-')) continue;
		const target = unquote(word);
		const variable = /^\$\{?([A-Za-z_]\w*)\}?(\/.*)?$/.exec(target);
		if (variable) {
			if (scratch.has(variable[1]!) && !variable[2]?.split('/').includes('..'))
				continue;
			return {
				allow: false,
				reason: `rm of ${target}, not set to QA scratch here`,
			};
		}

		if (!isScratchPath(target, policy)) {
			return {allow: false, reason: `rm outside QA scratch: ${target}`};
		}
	}

	return {allow: true};
}

export function checkApproval(
	command: string,
	policy: ApprovalPolicy,
): ApprovalVerdict {
	for (const [pattern, what] of PUBLISHING) {
		if (pattern.test(command)) return {allow: false, reason: what};
	}

	for (const segment of command.split(SEGMENT_SEPARATOR)) {
		const kill = /\bkill-(?:server|session|pane)\b/.exec(segment);
		if (kill && !ISOLATED_TMUX.test(segment)) {
			return {allow: false, reason: `${kill[0]} outside an isolated socket`};
		}

		const words = segment.match(WORD) ?? [];
		const prefixed = new Set<string>();
		while (words[0] && ASSIGNMENT.test(words[0]))
			prefixed.add(words.shift()!.split('=')[0]!);
		const runsRm = words[0] === 'rm' || words[0]?.endsWith('/rm');
		if (runsRm) {
			const verdict = checkRm(words, prefixed, command, policy);
			if (!verdict.allow) return verdict;
		} else if (/\brm\b/.test(segment)) {
			// Through xargs, sudo, sh -c and the like, the targets aren't readable here.
			return {allow: false, reason: 'rm run through another command'};
		}
	}

	return {allow: true};
}
