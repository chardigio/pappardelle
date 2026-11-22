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
// Quoted and bare pieces next to each other are one shell word: "$S"/{a,b}.
const WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

function unquote(word: string): string {
	return word.replace(/^(["'])(.*)\1$/, '$2');
}

// A statement made only of assignments, so the shell keeps them. `+=`
// appends to whatever the variable held, so it's never scratch.
const ASSIGNMENT_STATEMENT =
	/(?:^|[;&|\n])\s*((?:[A-Za-z_]\w*\+?=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]+)\s*)+)(?=[;&|\n]|$)/g;
// The value runs to the end of the word, so $(mktemp)/../.. is read whole.
const ANY_ASSIGNMENT =
	/\b([A-Za-z_]\w*)(\+?)=("[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]+)(?=[\s;&|]|$)/g;
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
	// An unquoted $D splits on whitespace, so "/tmp/q-a /home" is two targets.
	return (
		!match[2] &&
		(freshDir || (!/\s/.test(value) && isScratchPath(value, policy)))
	);
}

/**
 * Variables set to a fresh temp dir or a path under scratch in `before`, the
 * text ahead of the rm, and nowhere else in `command`.
 */
function scratchVariables(
	command: string,
	before: string,
	policy: ApprovalPolicy,
): Set<string> {
	const scratch = new Set<string>();
	const elsewhere = new Set<string>();
	for (const statement of before.matchAll(ASSIGNMENT_STATEMENT)) {
		for (const match of statement[1]!.matchAll(ANY_ASSIGNMENT)) {
			(isScratchValue(match, policy) ? scratch : elsewhere).add(match[1]!);
		}
	}

	// Through export, declare, local and the like, an assignment that isn't a
	// statement of its own still changes the variable. The whole command is
	// read, since a loop or function can run a later assignment before the rm.
	for (const match of command.matchAll(ANY_ASSIGNMENT)) {
		if (!isScratchValue(match, policy)) elsewhere.add(match[1]!);
	}

	for (const pattern of SET_BY_BUILTIN) {
		for (const match of command.matchAll(pattern)) {
			for (const name of match[1]!.match(/(?<![-\w])[A-Za-z_]\w*/g) ?? [])
				elsewhere.add(name);
		}
	}

	// One assignment anywhere else, say D=$HOME on one branch, and it isn't scratch.
	for (const name of elsewhere) scratch.delete(name);
	return scratch;
}

// Brace expansion builds `..` out of pieces such as {..,} or {.,.}{.,}, and
// a glob that names the leading dot, such as .? or .*, can match `..`.
function mayClimb(target: string): boolean {
	return (
		/[{}]/.test(target) ||
		target
			.split('/')
			.some(
				part => part === '..' || (part.startsWith('.') && /[*?]/.test(part)),
			)
	);
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
	const kill = args.findIndex(word => KILL.test(word));
	// tmux takes the last -S it is given.
	const socket = args.slice(0, Math.max(kill, 0)).lastIndexOf('-S');
	const socketPath = unquote(args[socket + 1] ?? '');
	return (
		socket !== -1 && socketPath.startsWith('/tmp/q-') && !mayClimb(socketPath)
	);
}

// Characters a bare word may hold and still be read here. Anything else
// (expansions, [ ] classes, ~, zsh glob operators) needs a person.
const PLAIN_BARE = /^[\w./@%+=:,*?{}-]*$/;
const LEADING_VARIABLE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/;
const MAX_EXPANSIONS = 256;

/**
 * An rm or cd target as the shell expands it: an optional leading variable
 * and every path brace expansion makes of the rest. Null when the word holds
 * anything else that expands.
 */
type Target = {variable: string | undefined; paths: string[]};

// Only flat lists such as {a,b,}. A range like {1..3} or a nested list is
// left for a person.
function expandBraces(text: string): string[] | null {
	const open = text.indexOf('{');
	const close = text.indexOf('}');
	if (open === -1) return close === -1 ? [text] : null;
	if (close < open) return null;
	const options = text.slice(open + 1, close).split(',');
	if (options.length < 2 || options.some(option => option.includes('{')))
		return null;
	const rest = expandBraces(text.slice(close + 1));
	if (!rest) return null;
	return options.flatMap(option =>
		rest.map(tail => text.slice(0, open) + option + tail),
	);
}

function readTarget(word: string): Target | null {
	let variable: string | undefined;
	let paths = [''];
	for (const [index, piece] of (
		word.match(/"[^"]*"|'[^']*'|[^"']+/g) ?? []
	).entries()) {
		const quote = /^["']/.test(piece) ? piece[0] : undefined;
		let text = quote ? piece.slice(1, -1) : piece;
		if (index === 0 && quote !== "'") {
			const leading = LEADING_VARIABLE.exec(text);
			if (leading) {
				variable = leading[1] ?? leading[2];
				text = text.slice(leading[0].length);
			}
		}

		let expanded: string[] | null;
		if (quote === "'") expanded = [text];
		else if (quote === '"') expanded = /[$`\\]/.test(text) ? null : [text];
		else expanded = PLAIN_BARE.test(text) ? expandBraces(text) : null;
		if (!expanded) return null;
		paths = paths.flatMap(path => expanded.map(more => path + more));
		if (paths.length > MAX_EXPANSIONS) return null;
	}

	return {variable, paths};
}

type Scope = {
	/** Variables set to scratch, and those set for this command only. */
	scratch: Set<string>;
	prefixed: Set<string>;
	/** Whether the shell is in a scratch directory when this command runs. */
	inScratchDir: boolean;
	/** Whether IFS changes anywhere, so an unquoted $D can split anywhere. */
	ifsChanged: boolean;
};

function isScratchTarget(
	target: Target,
	scope: Scope,
	policy: ApprovalPolicy,
): boolean {
	const {variable, paths} = target;
	if (variable !== undefined) {
		// `D=/tmp/q-x rm -rf $D` sets D for rm only; the shell has already
		// expanded $D from the outer environment.
		return (
			scope.scratch.has(variable) &&
			!scope.prefixed.has(variable) &&
			!scope.ifsChanged &&
			paths.every(
				rest => (rest === '' || rest.startsWith('/')) && !mayClimb(rest),
			)
		);
	}

	return paths.every(path =>
		path.startsWith('/')
			? isScratchPath(path, policy)
			: scope.inScratchDir && path !== '' && !mayClimb(path),
	);
}

function checkRm(
	words: string[],
	scope: Scope,
	policy: ApprovalPolicy,
): ApprovalVerdict {
	let options = true;
	for (const word of words.slice(1)) {
		if (options && word === '--') {
			options = false;
			continue;
		}

		if (options && word.startsWith('-')) continue;
		const target = readTarget(word);
		if (
			target?.variable !== undefined &&
			!isScratchTarget(target, scope, policy)
		)
			return {
				allow: false,
				reason: `rm of ${unquote(word)}, not set to QA scratch here`,
			};
		if (!target || !isScratchTarget(target, scope, policy))
			return {allow: false, reason: `rm outside QA scratch: ${unquote(word)}`};
	}

	return {allow: true};
}

// Words before an rm that can run a cd conditionally, later, in a subshell, or
// not at all (a heredoc line, a function body), or change the directory some
// other way. With any of them, a cd isn't taken to hold when the rm runs.
const HIDES_DIRECTORY =
	/[()`]|<<|(?:^|[\s;&|])(?:if|then|else|elif|fi|case|esac|while|until|for|select|do|done|function|\{|\}|\[\[|!|pushd|popd|source|\.|eval|exec|builtin|command|trap|alias)(?=$|[\s;&|])/;

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
	const ifsChanged = /\bIFS\b/.test(command);
	let before = '';
	let inScratchDir = false;
	// Whether this segment runs whenever the command does: it starts the
	// command or follows `;`, or follows `&&` after assignments that ran so.
	// Not a line break: the command is read off the screen, where a wrapped
	// line also breaks, so `echo xcd /tmp/q-a` can show a cd at a line start.
	let unconditional = true;
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

		const next = parts[index + 1];
		const scope: Scope = {
			scratch: scratchVariables(command, before, policy),
			prefixed,
			inScratchDir: inScratchDir && !HIDES_DIRECTORY.test(before),
			ifsChanged,
		};
		const runsRm = words[0] === 'rm' || words[0]?.endsWith('/rm');
		if (runsRm) {
			const verdict = checkRm(words, scope, policy);
			if (!verdict.allow) return verdict;
		} else if (/\brm\b/.test(segment)) {
			// Through xargs, sudo, sh -c and the like, the targets aren't readable here.
			return {allow: false, reason: 'rm run through another command'};
		}

		if (words[0] === 'cd') {
			// A cd in a pipeline runs in a subshell, and one before || may not run.
			const target =
				words.length === 2 && prefixed.size === 0
					? readTarget(words[1]!)
					: null;
			inScratchDir =
				unconditional &&
				next !== '|' &&
				next !== '||' &&
				target?.paths.length === 1 &&
				isScratchTarget(target, {...scope, inScratchDir: false}, policy);
		}

		const assignsOnly = words.length === 0 && prefixed.size > 0;
		unconditional =
			next === ';' || (next === '&&' && unconditional && assignsOnly);
		before += segment + (next ?? '');
	}

	return {allow: true};
}
