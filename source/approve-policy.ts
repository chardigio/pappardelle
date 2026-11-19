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

const KILL = /\bkill-(?:server|session|pane)\b/;

const SEGMENT_SEPARATOR = /(;|&&|\|\||\||\n)/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const WORD = /"[^"]*"|'[^']*'|\S+/g;

function unquote(word: string): string {
	return word.replace(/^(["'])(.*)\1$/, '$2');
}

// A statement made only of assignments, so the shell keeps them. `+=`
// appends to whatever the variable held, so it's never scratch.
const ASSIGNMENT_STATEMENT =
	/(?:^|[;&|\n])\s*((?:[A-Za-z_]\w*\+?=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]+)\s*)+)(?=[;&|\n]|$)/g;
const ANY_ASSIGNMENT =
	/\b([A-Za-z_]\w*)(\+?)=("[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]+)/g;
// Builtins that set a variable without NAME=, so the value can't be read here.
const SET_BY_BUILTIN = [
	/\b(?:read|mapfile|readarray)\b([^;&|\n]*)/g,
	/\bprintf\b[^;&|\n]*?\s-v\s*([A-Za-z_]\w*)/g,
	/\bfor\s+([A-Za-z_]\w*)/g,
];

function isScratchValue(
	match: RegExpMatchArray,
	policy: ApprovalPolicy,
): boolean {
	const value = unquote(match[3]!);
	// Only the bare directory mktemp just made: nothing run beside it in
	// the subshell.
	const freshDir = /^\$\(\s*mktemp(?:\s+[^\s;&|$`()]+)*\s*\)$/.test(value);
	return !match[2] && (freshDir || isScratchPath(value, policy));
}

/** Variables set to a fresh temp dir or a path under scratch in `before`. */
function scratchVariables(before: string, policy: ApprovalPolicy): Set<string> {
	const scratch = new Set<string>();
	const elsewhere = new Set<string>();
	for (const statement of before.matchAll(ASSIGNMENT_STATEMENT)) {
		for (const match of statement[1]!.matchAll(ANY_ASSIGNMENT)) {
			(isScratchValue(match, policy) ? scratch : elsewhere).add(match[1]!);
		}
	}

	// Through export, declare, local and the like, an assignment that isn't a
	// statement of its own still changes the variable.
	for (const match of before.matchAll(ANY_ASSIGNMENT)) {
		if (!isScratchValue(match, policy)) elsewhere.add(match[1]!);
	}

	for (const pattern of SET_BY_BUILTIN) {
		for (const match of before.matchAll(pattern)) {
			for (const name of match[1]!.match(/(?<![-\w])[A-Za-z_]\w*/g) ?? [])
				elsewhere.add(name);
		}
	}

	// One assignment anywhere else, say D=$HOME on one branch, and it isn't scratch.
	for (const name of elsewhere) scratch.delete(name);
	return scratch;
}

// Brace expansion builds `..` out of pieces such as {..,} or {.,.}{.,}.
function mayClimb(target: string): boolean {
	return target.includes('{') || target.split('/').includes('..');
}

function isScratchPath(target: string, policy: ApprovalPolicy): boolean {
	if (!target.startsWith('/') || mayClimb(target)) return false;
	const normalized = path.posix.normalize(target);
	return policy.scratchRoots.some(root => normalized.startsWith(root));
}

// QA isolates tmux on a socket under /tmp/q-*, or through the qtmux/qkill/qenv
// wrappers; anything else reaches the user's sessions.
function isolatedTmux(words: string[]): boolean {
	const [program = '', ...args] = words;
	if (/^q(?:kill|tmux|env)$/.test(program)) return true;
	if (program !== 'tmux') return false;
	const socket = args.indexOf('-S');
	const kill = args.findIndex(word => KILL.test(word));
	const socketPath = unquote(args[socket + 1] ?? '');
	return (
		socket !== -1 &&
		socket < kill &&
		socketPath.startsWith('/tmp/q-') &&
		!mayClimb(socketPath)
	);
}

function checkRm(
	words: string[],
	prefixed: Set<string>,
	before: string,
	policy: ApprovalPolicy,
): ApprovalVerdict {
	const scratch = scratchVariables(before, policy);
	// `D=/tmp/q-x rm -rf $D` sets D for rm only; the shell has already
	// expanded $D from the outer environment.
	for (const name of prefixed) scratch.delete(name);
	for (const word of words.slice(1)) {
		if (word.startsWith('-')) continue;
		const target = unquote(word);
		const variable = /^\$\{?([A-Za-z_]\w*)\}?(\/.*)?$/.exec(target);
		if (variable) {
			if (scratch.has(variable[1]!) && !mayClimb(variable[2] ?? '')) continue;
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
	// An empty box or a layout the screen parser doesn't know reads as no
	// command, and the model check has nothing to judge either.
	if (command.trim() === '')
		return {allow: false, reason: 'no command to read'};

	for (const [pattern, what] of PUBLISHING) {
		if (pattern.test(command)) return {allow: false, reason: what};
	}

	const parts = command.split(SEGMENT_SEPARATOR);
	let before = '';
	for (let index = 0; index < parts.length; index += 2) {
		const segment = parts[index]!;
		const words = segment.match(WORD) ?? [];
		const prefixed = new Set<string>();
		while (words[0] && ASSIGNMENT.test(words[0]))
			prefixed.add(words.shift()!.split('=')[0]!);
		const kill = KILL.exec(segment);
		if (kill && !isolatedTmux(words)) {
			return {allow: false, reason: `${kill[0]} outside an isolated socket`};
		}

		const runsRm = words[0] === 'rm' || words[0]?.endsWith('/rm');
		if (runsRm) {
			const verdict = checkRm(words, prefixed, before, policy);
			if (!verdict.allow) return verdict;
		} else if (/\brm\b/.test(segment)) {
			// Through xargs, sudo, sh -c and the like, the targets aren't readable here.
			return {allow: false, reason: 'rm run through another command'};
		}

		before += segment + (parts[index + 1] ?? '');
	}

	return {allow: true};
}
