// Which permission prompts an agent may approve in another space without a
// person. A command that stays inside the space (its worktree, the temp
// directories, isolated tmux sockets, local git) passes these rules and goes
// on to the model check; a short list of hard stops never does, and is held
// for the chef. Anything this can't read plainly is held too, since a hold
// only costs the chef a look.

import path from 'node:path';

export type ApprovalVerdict =
	| {kind: 'approve'; reason?: string}
	| {kind: 'hold'; reason: string};

export type ApprovalPolicy = {
	/** The space's worktree. Null for the main checkout, which every space shares. */
	worktree: string | null;
	/** Temp directories: anything strictly below one is inside the space. */
	roots: readonly string[];
	/**
	 * Path prefixes under a temp root that belong to the user, not a space:
	 * tmux's socket directories. Nothing at or under one is inside the space.
	 */
	reserved: readonly string[];
	/**
	 * Directories under a temp root whose subdirectories are each an agent's
	 * own, such as the parent of every agent's scratchpad.
	 */
	shared: readonly string[];
	/**
	 * The name of this space's own subdirectory of each shared directory:
	 * Claude names a scratchpad after the checkout it started in.
	 */
	scratchpad: string;
	/** origin's default branch, which pushes never reach without the chef. */
	defaultBranch: string | null;
	realpath: (target: string) => string;
};

const approve: ApprovalVerdict = {kind: 'approve'};
const hold = (reason: string): ApprovalVerdict => ({kind: 'hold', reason});

// tmux takes any unique prefix of a command name: send-k, kill-ses.
const KILL =
	/\b(?:kill-(?:se|p|w)[\w-]*|kill[pw]|respawn-?(?:pane|p|window|w)|unlink-?w[\w-]*)\b/;
const TYPES_INTO =
	/^(?:send-?k[\w-]*|send|paste-?b[\w-]*|run(?:-shell)?|if(?:-shell)?)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
// Quoted and bare pieces next to each other are one shell word: "$S"/{a,b}.
const WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

function unquote(word: string): string {
	return word.replace(/^(["'])(.*)\1$/, '$2');
}

/** A word as the shell reads it for a name: r''m and \\rm are rm. */
function bare(word: string): string {
	return word.replaceAll(/["'\\]/g, '');
}

// Deploys, cloud and production access, and publishing: what an agent may
// never do without the chef, whatever the model check would say. Each entry
// is the program and, when only some of its subcommands reach out, those.
const HARD_STOPS: Array<{
	programs: readonly string[];
	subcommands?: RegExp;
	why: string;
}> = [
	{
		programs: [
			'dokku',
			'doctl',
			'aws',
			'aws-vault',
			'gcloud',
			'gsutil',
			'az',
			'kubectl',
			'helm',
			'heroku',
			'vercel',
		],
		why: 'deploys or reaches a cloud account',
	},
	{
		programs: ['terraform', 'tofu'],
		subcommands: /^(?:apply|destroy|import)$/,
		why: 'changes real infrastructure',
	},
	{
		programs: ['pulumi'],
		subcommands: /^(?:up|destroy)$/,
		why: 'changes real infrastructure',
	},
	{
		programs: ['wrangler'],
		subcommands: /^(?:deploy|publish|secret)$/,
		why: 'deploys',
	},
	{
		programs: ['fly', 'flyctl'],
		subcommands: /^(?:deploy|secrets)$/,
		why: 'deploys',
	},
	{programs: ['netlify'], subcommands: /^(?:deploy|env:set)$/, why: 'deploys'},
	{
		programs: ['npm', 'pnpm', 'yarn', 'bun', 'cargo'],
		subcommands: /^publish$/,
		why: 'publishes a package',
	},
	{programs: ['gem'], subcommands: /^push$/, why: 'publishes a package'},
	{programs: ['twine'], subcommands: /^upload$/, why: 'publishes a package'},
	{
		programs: ['docker', 'podman', 'buildah'],
		subcommands: /^(?:push|--push)$/,
		why: 'publishes an image',
	},
	{programs: ['skopeo'], subcommands: /^copy$/, why: 'publishes an image'},
	{
		programs: ['sudo', 'sudoedit', 'doas', 'pkexec', 'su', 'run0'],
		why: 'runs as root',
	},
];

// Words that run the command after them, as far as a hard stop goes, and
// the options of each that take a value.
const RUNS_NEXT = new Map<string, readonly string[]>([
	['!', []],
	['{', []],
	['if', []],
	['then', []],
	['else', []],
	['elif', []],
	['do', []],
	['while', []],
	['until', []],
	['time', []],
	['nohup', []],
	['command', []],
	['builtin', []],
	['eval', []],
	['setsid', []],
	['busybox', []],
	['npx', ['-p', '--package']],
	['bunx', ['-p', '--package']],
	// env -S's value is the command itself, so it isn't skipped.
	['env', ['-u', '--unset', '-C', '--chdir']],
	['nice', ['-n', '--adjustment']],
	['exec', ['-a']],
	['ionice', ['-c', '-n', '-p', '--class', '--classdata']],
	['stdbuf', ['-i', '-o', '-e']],
	['timeout', ['-s', '-k', '--signal', '--kill-after']],
	['xargs', ['-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a']],
	['watch', ['-n', '-d', '--interval']],
	['systemd-run', ['-p', '--property', '-u', '--unit', '-E', '--setenv']],
	['unshare', []],
	['parallel', ['-j', '--jobs']],
	['script', ['-O', '--output']],
]);
// Wrappers whose first word after the options is theirs, not the command:
// a priority, a CPU mask, a lock file, a coprocess name.
const TAKES_ONE = new Map<string, readonly string[]>([
	['chrt', ['-p']],
	['taskset', ['-p', '-c']],
	['flock', ['-w', '-E', '--timeout', '--conflict-exit-code']],
	['coproc', []],
]);
const RUNS_PACKAGE = /^(?:dlx|exec|x)$/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The index past the options at `index`, and the values of `values`. */
function pastOptions(
	words: string[],
	index: number,
	values: readonly string[],
): number {
	let at = index;
	while (bare(words[at] ?? '').startsWith('-'))
		at += values.includes(bare(words[at]!)) ? 2 : 1;
	return at;
}

/** Where the program a segment runs starts, past wrappers and env prefixes. */
function invocationStart(words: string[]): number {
	let index = 0;
	let wrapper: string | undefined;
	for (;;) {
		const word = bare(words[index] ?? '');
		if (ASSIGNMENT.test(word)) {
			index++;
		} else if (wrapper !== undefined && word.startsWith('-')) {
			index += RUNS_NEXT.get(wrapper)!.includes(word) ? 2 : 1;
		} else if (RUNS_NEXT.has(programName(word))) {
			wrapper = programName(word);
			index++;
			// timeout's first word is how long, not the command.
			if (wrapper === 'timeout') {
				index = pastOptions(words, index, RUNS_NEXT.get(wrapper)!) + 1;
			}
		} else if (TAKES_ONE.has(programName(word))) {
			const values = TAKES_ONE.get(programName(word))!;
			// coproc NAME { …; } takes a name only before a compound command.
			const next = pastOptions(words, index + 1, values);
			index = word === 'coproc' && words[next + 1] !== '{' ? next : next + 1;
			wrapper = undefined;
		} else if (
			PACKAGE_MANAGERS.has(word) &&
			RUNS_PACKAGE.test(bare(words[index + 1] ?? ''))
		) {
			wrapper = 'npx';
			index += 2;
		} else {
			break;
		}
	}

	return index;
}

function programName(word: string): string {
	// npx wrangler@3 deploy, /usr/bin/doctl, eval "doctl apps list"
	const first = bare(word).trim().split(/\s+/)[0] ?? '';
	return path.posix.basename(first).replace(/(?<=.)@.*$/, '');
}

function hardStop(args: string[]): string | null {
	const [first, ...rest] = args;
	if (!first) return null;
	const program = programName(first);
	// x=doctl; $x, or doctl${IFS}account: the program isn't known until it runs.
	if (/[$`]/.test(program)) return "the program it runs can't be read";
	// eval "doctl apps list" runs the words inside the quotes.
	const inner = bare(first).trim().split(/\s+/);
	// npm pub""lish is npm publish.
	const words = [...inner.slice(1), ...rest.map(word => bare(word))];
	for (const {programs, subcommands, why} of HARD_STOPS) {
		if (!programs.includes(program)) continue;
		if (!subcommands) return `${program} ${why}`;
		const subcommand = words.find(word => subcommands.test(word));
		if (subcommand) return `${program} ${subcommand} ${why}`;
	}

	if (program === 'wrangler' && words.includes('--remote'))
		return 'wrangler --remote reaches a production database';
	if (
		['ssh', 'scp', 'rsync'].includes(program) &&
		words.some(word => word.includes('dokku'))
	)
		return `${program} to a dokku host deploys`;
	if (
		program === 'gh' &&
		words[0] === 'release' &&
		['create', 'upload', 'edit', 'delete'].includes(words[1] ?? '')
	)
		return `gh release ${words[1]} changes a release`;
	const subcommand = words.find(word => !word.startsWith('-')) ?? '';
	if (
		program === 'pappardelle' &&
		(['holds', 'answer'].includes(subcommand) ||
			(subcommand === 'send' &&
				words.some(word => word === '--keys' || word.startsWith('--keys='))))
	)
		return `pappardelle ${subcommand} answers for agents, which only the chef does`;
	// yarn wrangler deploy, pnpm npm publish: a package manager runs the
	// program named after it.
	if (PACKAGE_MANAGERS.has(program)) {
		const runs = words.findIndex(word =>
			HARD_STOPS.some(stop => stop.programs.includes(programName(word))),
		);
		if (runs !== -1) return hardStop(words.slice(runs));
	}

	return null;
}

const GIT_OPTION_WITH_VALUE = new Set(['-C', '-c']);

const RUNS_INPUT =
	/^(?:(?:ba|da|k|z|fi)?sh|python[\d.]*|node|bun|deno|perl|ruby|php|osascript)$/;

/** The words from git's subcommand on, past git's own options. */
function gitSubcommand(args: string[]): string[] {
	let index = 1;
	while (args[index]?.startsWith('-'))
		index += GIT_OPTION_WITH_VALUE.has(args[index]!) ? 2 : 1;
	return args.slice(index);
}

// Every space shares the repository's stash and worktree list.
const SHARED_GIT: Record<string, ReadonlySet<string>> = {
	stash: new Set(['clear', 'drop', 'pop']),
	worktree: new Set(['remove', 'prune']),
};

/** Why a git push needs the chef, or null when it reaches only the space's own branches. */
function pushToMain(
	args: string[],
	policy: ApprovalPolicy,
	cwd: string | null,
): string | null {
	if (programName(args[0] ?? '') !== 'git') return null;
	let index = 1;
	let elsewhere = false;
	let at = cwd;
	while (args[index]?.startsWith('-')) {
		if (/^(?:--git-dir|--work-tree)/.test(args[index]!)) elsewhere = true;
		// git -C <dir> runs there; the worktree or a directory in it is fine.
		if (args[index] === '-C') {
			const dir = bare(args[index + 1] ?? '');
			at =
				/[$`*?{]/.test(dir) || (at === null && !dir.startsWith('/'))
					? null
					: path.posix.resolve(at ?? '/', dir);
		}
		// -c push.default=upstream or remote.origin.push=HEAD:main decide
		// where a bare push goes.
		if (
			args[index] === '-c' &&
			/^(?:push\.|remote\..*\.push)/.test(args[index + 1] ?? '')
		)
			return 'a push whose destination is set on the command line';
		index += GIT_OPTION_WITH_VALUE.has(args[index]!) ? 2 : 1;
	}

	if (
		args[index] === 'config' &&
		args
			.slice(index)
			.some(word => /^(?:push\.|remote\..*\.push|branch\..*\.merge)/.test(word))
	)
		return 'a change to where pushes go';
	if (args[index] !== 'push') return null;
	if (policy.worktree === null)
		return "a push from the main checkout, whose branch isn't a space's";
	// A push from another checkout, whose branch may be main.
	if (
		elsewhere ||
		at === null ||
		(at !== policy.worktree && below(at, policy.worktree) === null)
	)
		return "a push from outside the space's worktree";
	const pushArgs = args.slice(index + 1);
	if (pushArgs.some(word => word === '--all' || word === '--mirror'))
		return 'a push of every branch';
	const positionals = pushArgs.filter(word => !word.startsWith('-'));
	const protectedBranches = new Set(
		['main', 'master', policy.defaultBranch].filter(Boolean),
	);
	// The repository is the first positional unless --repo=<name> gave it.
	const repoGiven = pushArgs.some(word => word.startsWith('--repo='));
	for (const word of positionals.slice(repoGiven ? 0 : 1)) {
		const refspec = bare(word);
		// B=main; git push origin $B, or {HEAD:x,HEAD:main}
		if (/[$`{}*]/.test(refspec))
			return `a push to ${refspec}, which can't be read`;
		// : and +: push every branch that has the same name on the remote.
		if (/^\+?:$/.test(refspec)) return 'a push of every matching branch';
		const destination = refspec.replace(/^\+/, '').split(':').at(-1)!;
		const branch = destination.replace(/^(?:refs\/)?heads\//, '');
		if (protectedBranches.has(branch)) return `a push to ${branch}`;
	}

	return null;
}

/**
 * The command with heredoc bodies left out: they are text fed to a program,
 * such as a commit message, and the words in them never run.
 */
/**
 * The command without its heredoc bodies, and the same with each body's end
 * line kept, so a heredoc inside $(…) still reads as ended. Unended: lines
 * follow a heredoc that never ends, which would hide them.
 */
function withoutHeredocs(command: string): {
	text: string;
	ended: string;
	unended: boolean;
} {
	const kept: string[] = [];
	const ended: string[] = [];
	const pending: string[] = [];
	let swallowed = false;
	for (const line of command.split('\n')) {
		if (pending.length > 0) {
			if (line.trim() === pending[0]) {
				pending.shift();
				ended.push(line);
			} else {
				swallowed = true;
			}

			continue;
		}

		kept.push(line);
		ended.push(line);
		// Not a here-string (<<<), and not a shift inside $(( )).
		for (const match of line.matchAll(
			/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g,
		)) {
			if (!/\$\(\([^)]*$/.test(line.slice(0, match.index)))
				pending.push(match[2]!);
		}
	}

	return {
		text: kept.join('\n'),
		ended: ended.join('\n'),
		unended: pending.length > 0 && swallowed,
	};
}

/** The index just past the quote that closes the one at `start`. */
function pastQuote(command: string, start: number): number {
	const quote = command[start]!;
	let index = start + 1;
	for (; index < command.length && command[index] !== quote; index++) {
		if (quote === '"' && command[index] === '\\') index++;
	}

	return index + 1;
}

/**
 * The commands that $(…) and backticks run from inside double quotes, where
 * segments() keeps them as the text of one word.
 */
function quotedSubstitutions(command: string): string[] {
	const found: string[] = [];
	let quote: string | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}

		if (char === '\\') {
			index++;
			continue;
		}

		if (quote !== '"') {
			if (char === '"' || char === "'") quote = char;
			continue;
		}

		if (char === '"') {
			quote = undefined;
		} else if (
			command.startsWith('$(', index) &&
			!command.startsWith('$((', index)
		) {
			let depth = 1;
			let end = index + 2;
			while (end < command.length && depth > 0) {
				const inner = command[end]!;
				if (inner === "'" || inner === '"') {
					end = pastQuote(command, end);
					continue;
				}

				switch (inner) {
					case '\\': {
						end++;
						break;
					}

					case '(': {
						depth++;
						break;
					}

					case ')': {
						depth--;
						break;
					}

					default:
				}

				end++;
			}

			found.push(command.slice(index + 2, depth === 0 ? end - 1 : end));
			index = end - 1;
		} else if (char === '`') {
			const end = command.indexOf('`', index + 1);
			found.push(command.slice(index + 1, end === -1 ? undefined : end));
			index = end === -1 ? command.length : end;
		}
	}

	return found;
}

const SEPARATORS = ['&&', '||', '$(', ';', '|', '&', '\n', '(', ')', '`'];

type Segment = {text: string; next: string | undefined};

/**
 * The simple commands in a command line and the operator after each. Quoted
 * text stays in its word, so a commit message never reads as a command.
 */
function segments(command: string): Segment[] {
	const found: Segment[] = [];
	let start = 0;
	let quote: string | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === '\\' && quote === '"') index++;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (char === '\\') {
			index++;
			continue;
		}

		// 2>&1 and &>file redirect; the & starts no command.
		if (
			char === '&' &&
			(command[index - 1] === '>' || command[index + 1] === '>')
		)
			continue;
		const separator = SEPARATORS.find(candidate =>
			command.startsWith(candidate, index),
		);
		if (!separator) continue;
		found.push({text: command.slice(start, index), next: separator});
		index += separator.length - 1;
		start = index + 1;
	}

	found.push({text: command.slice(start), next: undefined});
	return found;
}

/** A segment's words up to a comment. */
function wordsOf(segment: string): string[] {
	const words = segment.match(WORD) ?? [];
	const comment = words.findIndex(word => word.startsWith('#'));
	return comment === -1 ? words : words.slice(0, comment);
}

// A statement made only of assignments, so the shell keeps them. `+=`
// appends to whatever the variable held, so it's never inside the space.
const ASSIGNMENT_STATEMENT =
	/(?:^|[;&|\n])\s*((?:[A-Za-z_]\w*\+?=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]*)\s*)+)(?=[;&|\n]|$)/g;
// The value runs to the end of the word, so $(mktemp)/../.. is read whole.
const ANY_ASSIGNMENT =
	/\b([A-Za-z_]\w*)(?:\[[^\]]*\])?(\+?)=("[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]*)(?=[\s;&|]|$)/g;
// Builtins that set a variable without NAME=, so the value can't be read here.
const SET_BY_BUILTIN = [
	/\b(?:read|mapfile|readarray|unset|local)\b([^;&|\n]*)/g,
	/\bgetopts\s+\S+\s+([A-Za-z_]\w*)/g,
	/\bprintf\b[^;&|\n]*?\s-v\s*([A-Za-z_]\w*)/g,
	/\bfor\s+([A-Za-z_]\w*)/g,
];

function isSpaceValue(
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
		(freshDir ||
			(!/\s/.test(value) &&
				value.startsWith('/') &&
				placeOf(value, policy).kind === 'approve'))
	);
}

/**
 * Variables set to a fresh temp dir or a path inside the space in `before`,
 * the text ahead of the rm, and nowhere else in `command`.
 */
function spaceVariables(
	command: string,
	before: string,
	policy: ApprovalPolicy,
): Set<string> {
	const inside = new Set<string>();
	// eval 'D'=/home or a sourced file can set anything.
	if (/(?:^|[\s;&|(])(?:eval|source|\.)(?=\s)/.test(command)) return inside;
	const elsewhere = new Set<string>();
	for (const statement of before.matchAll(ASSIGNMENT_STATEMENT)) {
		for (const match of statement[1]!.matchAll(ANY_ASSIGNMENT)) {
			(isSpaceValue(match, policy) ? inside : elsewhere).add(match[1]!);
		}
	}

	// Through export, declare, local and the like, an assignment that isn't a
	// statement of its own still changes the variable. The whole command is
	// read, since a loop or function can run a later assignment before the rm.
	for (const match of command.matchAll(ANY_ASSIGNMENT)) {
		if (!isSpaceValue(match, policy)) elsewhere.add(match[1]!);
	}

	for (const pattern of SET_BY_BUILTIN) {
		for (const match of command.matchAll(pattern)) {
			for (const name of match[1]!.match(/(?<![-\w])[A-Za-z_]\w*/g) ?? [])
				elsewhere.add(name);
		}
	}

	// One assignment anywhere else, say D=$HOME on one branch, and it isn't inside.
	for (const name of elsewhere) inside.delete(name);
	return inside;
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

/**
 * `target` with every symlink in it resolved, as far as it exists. The last
 * component is left as written unless `followLast`: rm of a symlink removes
 * the link, not what it points at.
 */
function resolveReal(
	target: string,
	policy: ApprovalPolicy,
	followLast = true,
): string {
	const tail: string[] = [];
	let current = path.posix.normalize(target).replace(/(?<=.)\/+$/, '');
	if (!followLast && current !== '/') {
		tail.unshift(path.posix.basename(current));
		current = path.posix.dirname(current);
	}

	for (;;) {
		try {
			return path.posix.join(policy.realpath(current), ...tail);
		} catch {
			if (current === '/') return path.posix.join('/', ...tail);
			tail.unshift(path.posix.basename(current));
			current = path.posix.dirname(current);
		}
	}
}

function below(target: string, directory: string): string | null {
	const base = directory.replace(/\/+$/, '');
	return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/**
 * Files that decide what the space's agent may do, or that hold its git
 * metadata. idow copies settings.local.json into every worktree, so an edit
 * there would let the agent rewrite its own permissions.
 */
export function isAgentConfig(relative: string): boolean {
	// macOS file systems ignore case: .Claude is .claude.
	const [first, second] = path.posix
		.normalize(relative)
		.toLowerCase()
		.split('/');
	// A stale lock left by a crashed git is the agent's to clear.
	if (/^\.git\/(?:[\w.-]+\/)*[\w.-]+\.lock$/.test(relative)) return false;
	if (first === '.git' || first === '.codex' || first === '.mcp.json')
		return true;
	return (
		first === '.claude' &&
		(second === undefined || /^settings.*\.json$|[*?[]/.test(second))
	);
}

/**
 * Whether an absolute path is inside the space, or why not. A glob in its
 * last component is matched as a name, which holds for a glob that could
 * reach anything under a temp directory. Reading agent configuration is
 * fine; only writing it changes what agents may do.
 */
export function placeOf(
	target: string,
	policy: ApprovalPolicy,
	{
		followLast = true,
		reading = false,
	}: {followLast?: boolean; reading?: boolean} = {},
): ApprovalVerdict {
	if (!target.startsWith('/')) return hold(`${target} is not an absolute path`);
	if (mayClimb(target)) return hold(`${target} may climb out of its directory`);
	const real = resolveReal(target, policy, followLast);
	if (policy.worktree) {
		const relative = below(real, resolveReal(policy.worktree, policy));
		if (relative !== null) {
			return isAgentConfig(relative) && !reading
				? hold(`${target} is agent configuration`)
				: approve;
		}
	}

	for (const root of policy.roots) {
		const relative = below(real, resolveReal(root, policy));
		if (relative === null) continue;
		if (
			policy.reserved.some(prefix =>
				real.startsWith(resolveReal(prefix, policy)),
			)
		)
			return hold(`${target} holds the user's sockets`);
		for (const shared of policy.shared) {
			const realShared = resolveReal(shared, policy);
			if (real === realShared)
				return hold(`${target} holds every space's scratch`);
			const within = below(real, realShared);
			if (within === null) continue;
			const owner = within.split('/')[0]!;
			// /tmp/claude-1000/* reaches every space's scratchpad at once.
			if (/[*?[]/.test(owner))
				return hold(`${target} globs every space's scratch`);
			if (owner !== policy.scratchpad)
				return hold(`${target} is another agent's scratch`);
		}
		if (/[*?[]/.test(relative.split('/')[0]!))
			return hold(`${target} globs a whole temp directory`);
		return approve;
	}

	return hold(`${target} is outside the space`);
}

// QA isolates tmux on a socket under /tmp/q-*, or through the qtmux and qenv
// wrappers; anything else reaches the user's sessions. The socket is placed
// on its real path, since a link under /tmp/q-* can lead to the user's own
// server. qkill isn't trusted by name: it globs for sockets, which this can't
// follow.
function isolatedTmux(
	words: string[],
	acts: (word: string) => boolean,
	policy: ApprovalPolicy,
): boolean {
	const [program = '', ...args] = words;
	// tmux takes the last -S or -L, so one after qtmux's own leaves the q- dir.
	// A name such as x/.. would put the socket directory at /tmp itself.
	if (/^q(?:tmux|env)$/.test(program) && !/^[\w-]+$/.test(bare(args[0] ?? '')))
		return false;
	if (program === 'qtmux') return !args.some(word => /^-[SL]/.test(word));
	// qenv runs whatever follows; only TMUX_TMPDIR or -S can move tmux out.
	if (program === 'qenv') {
		// qenv NAME tmux …; anything else it runs can start its own tmux.
		if (args[1] !== 'tmux') return false;
		if (!args.some(word => /^TMUX_TMPDIR=|^-S/.test(word))) return true;
		return isolatedTmux(args.slice(1), acts, policy);
	}

	if (program !== 'tmux') return false;
	const action = args.findIndex(word => acts(word));
	// tmux takes the last -S it is given.
	const socket = args.slice(0, Math.max(action, 0)).lastIndexOf('-S');
	const socketPath = unquote(args[socket + 1] ?? '');
	if (socket === -1 || !socketPath.startsWith('/') || mayClimb(socketPath))
		return false;
	const real = resolveReal(socketPath, policy);
	return policy.roots.some(root => {
		const relative = below(real, resolveReal(root, policy));
		return (
			relative !== null && relative.startsWith('q-') && relative.includes('/')
		);
	});
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
	/** Variables set inside the space, and those set for this command only. */
	inside: Set<string>;
	prefixed: Set<string>;
	/** Where the shell is when this command runs; null when that can't be read. */
	cwd: string | null;
	/** Whether IFS changes anywhere, so an unquoted $D can split anywhere. */
	ifsChanged: boolean;
};

/** Where a target resolves when it is a single path the policy can place. */
function targetPaths(target: Target, scope: Scope): string[] | null {
	const {variable, paths} = target;
	if (variable !== undefined) {
		// `D=/tmp/q-x rm -rf $D` sets D for rm only; the shell has already
		// expanded $D from the outer environment.
		const usable =
			scope.inside.has(variable) &&
			!scope.prefixed.has(variable) &&
			!scope.ifsChanged &&
			paths.every(
				rest => (rest === '' || rest.startsWith('/')) && !mayClimb(rest),
			);
		// The variable's value was checked where it was set.
		return usable ? [] : null;
	}

	if (paths.some(target => target === '' || mayClimb(target))) return null;
	if (paths.some(target => !target.startsWith('/')) && scope.cwd === null)
		return null;
	return paths.map(target =>
		target.startsWith('/') ? target : path.posix.join(scope.cwd!, target),
	);
}

function checkTargets(
	words: string[],
	scope: Scope,
	policy: ApprovalPolicy,
	what: string,
): ApprovalVerdict {
	for (const word of words) {
		const target = readTarget(word);
		const paths = target && targetPaths(target, scope);
		if (!paths)
			return hold(
				`${what} of ${unquote(word)}, which can't be placed inside the space`,
			);
		// rm -rf link/ and find link/. -delete reach what the link points at.
		const followLast = /\/\.?$/.test(unquote(word));
		// */x and */ can pass through a link the glob matches.
		const parts = unquote(word).replace(/\/+$/, '').split('/');
		if (
			parts.slice(0, -1).some(part => /[*?[]/.test(part)) ||
			(followLast && /[*?[]/.test(parts.at(-1) ?? ''))
		)
			return hold(
				`${what} of ${unquote(word)}, a glob that can pass through a link`,
			);
		for (const target of paths) {
			const place = placeOf(target, policy, {followLast});
			if (place.kind === 'hold') return hold(`${what}: ${place.reason}`);
		}
	}

	return approve;
}

const DELETES = new Set([
	'rm',
	'rmdir',
	'unlink',
	'shred',
	'rimraf',
	'trash',
	'trash-put',
	'srm',
	'wipe',
]);

function deleteTargets(args: string[]): string[] {
	const targets: string[] = [];
	let options = true;
	let redirected = false;
	for (const word of args.slice(1)) {
		// 2>/dev/null, or the file after a bare > or 2>.
		const redirect = /^(?:\d*|&)[<>]{1,2}&?(.*)$/.exec(word);
		if (redirected) redirected = false;
		else if (redirect) redirected = redirect[1] === '';
		else if (options && word === '--') options = false;
		else if (!options || !word.startsWith('-')) targets.push(word);
	}

	return targets;
}

/** The start paths of a `find` that deletes, or null for one that doesn't. */
function findDeleteStarts(args: string[]): string[] | null {
	if (!args.includes('-delete')) return null;
	const starts = [];
	let index = 1;
	// find's own options come before the start paths: -P, -L, -H, -D x, -O2.
	while (/^-(?:[PLH]|O\d|D)$/.test(args[index] ?? ''))
		index += args[index] === '-D' ? 2 : 1;
	if (args[index] === '--') index++;
	for (const word of args.slice(index)) {
		if (/^[-(!]/.test(word)) break;
		starts.push(word);
	}

	return starts.length > 0 ? starts : ['.'];
}

// A redirect or tee into the files isAgentConfig names.
const AGENT_CONFIG_WRITE =
	/(?:>[>|]?|\btee\b(?:\s+-a)?)\s*["']?(?:\S*\/)?(?:\.claude\/+settings[^\s"']*\.json|\.mcp\.json(?![\w.])|\.codex\/|\.git\/)/i;

// Programs that write the files named in their arguments.
const WRITES_ARGS = new Set(['cp', 'mv', 'ln', 'install', 'dd', 'truncate']);
const EDITS_IN_PLACE = new Set(['sed', 'perl']);

/**
 * Why a segment writes agent configuration in the worktree, through a
 * redirect resolved against the tracked directory or a program that writes
 * its arguments, or null.
 */
function writesAgentConfig(
	words: string[],
	program: string,
	cwd: string | null,
	policy: ApprovalPolicy,
): string | null {
	if (!policy.worktree) return null;
	const targets: string[] = [];
	for (const [index, word] of words.entries()) {
		const redirect = /^(?:\d*>[>|]?|&>>?)(.*)$/.exec(word);
		if (redirect) targets.push(redirect[1] || (words[index + 1] ?? ''));
	}

	const operands = words.slice(1).filter(word => !word.startsWith('-'));
	if (program === 'dd') {
		targets.push(
			...operands
				.filter(word => word.startsWith('of='))
				.map(word => word.slice(3)),
		);
	} else if (program === 'ln' && words.some(word => /^-\w*s/.test(word))) {
		// A link to agent configuration lets a later write reach it.
		targets.push(...operands);
	} else if (
		program === 'git' &&
		/^(?:checkout|restore)$/.test(operands[0] ?? '')
	) {
		const files = words.indexOf('--');
		targets.push(
			...(files === -1 ? operands.slice(1) : words.slice(files + 1)),
		);
	} else if (['cp', 'ln', 'install', 'rsync'].includes(program)) {
		// Only the last operand is written; -t names the directory instead.
		const into = words.indexOf('-t');
		targets.push(
			into === -1 ? (operands.at(-1) ?? '') : (words[into + 1] ?? ''),
		);
	} else if (
		WRITES_ARGS.has(program) ||
		program === 'sponge' ||
		(EDITS_IN_PLACE.has(program) &&
			words.some(word => /^-\w*i|^--in-place/.test(word)))
	) {
		targets.push(...operands);
	}
	for (const word of targets) {
		// "$PWD"/.claude/x is .claude/x wherever the shell is.
		const spelled = bare(word);
		const target = spelled.replace(/^(?:\$\{?\w+\}?\/+)+/, '');
		if (!target) continue;
		if (target !== spelled || /[$`]/.test(target)) {
			// "$(pwd)"/.claude/x and "${PWD%/}"/.claude/x: what follows the last
			// expansion is the path inside the directory it names.
			if (isAgentConfig(target.replace(/^.*[)}`]\/+/, '')))
				return `it writes ${spelled}, agent configuration`;
			continue;
		}

		if (!target.startsWith('/') && cwd === null) {
			if (isAgentConfig(target))
				return `${program || 'a redirect'} into ${target}, agent configuration`;
			continue;
		}

		const absolute = path.posix.resolve(cwd ?? '/', target);
		// Through a link such as c -> .claude, the real path is what's written.
		for (const where of [absolute, resolveReal(absolute, policy)]) {
			const relative =
				below(where, resolveReal(policy.worktree, policy)) ??
				below(where, policy.worktree);
			if (relative !== null && isAgentConfig(relative))
				return `it writes ${target}, agent configuration`;
		}
	}

	return null;
}

// Words before a command that can run a cd conditionally, later, in a
// subshell, or not at all (a heredoc line, a function body), or change the
// directory some other way. With any of them and a change of directory, the
// directory isn't taken to be known when the command runs.
const HIDES_DIRECTORY =
	/[()`]|<<|(?:^|[\s;&|])(?:if|then|else|elif|fi|case|esac|while|until|for|select|do|done|function|\{|\}|\[\[|!|pushd|popd|source|\.|eval|exec|builtin|command|trap|alias)(?=$|[\s;&|])/;
const CHANGES_DIRECTORY =
	/(?:^|[\s;&|(`])(?:cd|pushd|popd|source|\.|eval|exec|builtin|command|trap|alias)(?=$|[\s;&|)])/;

/**
 * `startDir` is where the command runs, the worktree unless given: Codex's
 * shell tool takes a directory per call that its prompt doesn't show.
 */
export function checkApproval(
	command: string,
	policy: ApprovalPolicy,
	{startDir = policy.worktree}: {startDir?: string | null} = {},
): ApprovalVerdict {
	// An empty box or a layout the screen parser doesn't know reads as no
	// command, and the model check has nothing to judge either.
	if (command.trim() === '') return hold('no command to read');
	const {text, ended, unended} = withoutHeredocs(command);
	if (unended)
		return hold('a heredoc that never ends hides the lines after it');
	for (const inner of quotedSubstitutions(ended)) {
		if (inner.trim() === '') continue;
		const verdict = checkApproval(inner, policy, {
			// Where a cd has taken the shell by then isn't followed here.
			startDir: CHANGES_DIRECTORY.test(text) ? null : startDir,
		});
		if (verdict.kind === 'hold') return verdict;
	}

	// Any spelling of ~/.pappardelle: "$HOME"/.pappardelle, ~/./.pappardelle,
	// .papp"ardelle", .pappar{delle,}, and a glob such as ~/.pap* or .[p]a*.
	const spelled = bare(text);
	if (
		/\.pappardelle(?:\/|$|[\s;&|)])/.test(spelled) ||
		[...spelled.matchAll(/(?:^|[\s/='"])(\.[\w.-]*)[*?[{]/g)].some(match =>
			'.pappardelle'.startsWith(match[1]!),
		)
	)
		return hold("it reaches Pappardelle's own state, where holds are approved");
	if (AGENT_CONFIG_WRITE.test(bare(text)))
		return hold(
			'it writes agent configuration, which decides what agents may do',
		);

	const parts = segments(text);
	const ifsChanged = /\bIFS\b/.test(text);
	let before = '';
	let cwd = startDir;
	// Whether this segment runs whenever the command does: it starts the
	// command or follows `;`, or follows `&&` after assignments that ran so.
	// Not a line break: the command is read off the screen, where a wrapped
	// line also breaks, so `echo xcd /tmp/q-a` can show a cd at a line start.
	let unconditional = true;
	let chainedCd = false;
	for (const [index, {text: segment, next}] of parts.entries()) {
		const words = wordsOf(segment);
		const prefixed = new Set<string>();
		while (words[0] && ASSIGNMENT.test(words[0]))
			prefixed.add(words.shift()!.split('=')[0]!);
		if (words[0] === 'qkill')
			return hold(
				"qkill kills every tmux server its glob finds, which can be the user's through a link",
			);
		const kill = KILL.exec(segment);
		if (kill && !isolatedTmux(words, word => KILL.test(word), policy))
			return hold(`${kill[0]} outside an isolated socket`);
		const tmux = ['tmux', 'qtmux', 'qenv'].includes(words[0] ?? '');
		// These run a shell command, or a config file of commands, which can
		// reach the user's server whatever socket they start on.
		if (
			tmux &&
			words.some(word =>
				/^(?:run(?:-shell)?|if(?:-shell)?|display-?p\w*|popup|source(?:-file)?|pipe-?p\w*|confirm(?:-before)?)$/.test(
					word,
				),
			)
		)
			return hold('a tmux command that runs a shell command');
		if (
			tmux &&
			words.some(word => TYPES_INTO.test(word)) &&
			!isolatedTmux(words, word => TYPES_INTO.test(word), policy)
		)
			return hold('typing into a tmux pane outside an isolated socket');

		// command -v rm and type rm only look the name up.
		const looksUp =
			(words[0] === 'command' && /^-[vV]$/.test(words[1] ?? '')) ||
			['type', 'which', 'whereis'].includes(words[0] ?? '');
		const start = looksUp ? words.length : invocationStart(words);
		const raw = words.slice(start);
		// env -C dir runs the command somewhere else.
		const movesDir = words
			.slice(0, start)
			.some(word => /^(?:-\w*C|--chdir)/.test(bare(word)));
		const args = raw.map(word => unquote(word));
		const program = programName(args[0] ?? '');
		const early = hardStop(args);
		if (early) return hold(early);
		// bash <<EOF and curl … | sh run commands this never sees.
		let previous = index - 1;
		while (previous >= 0 && parts[previous]!.text.trim() === '') previous--;
		if (
			RUNS_INPUT.test(program) &&
			args
				.slice(1)
				.every(word => word.startsWith('-') || /^\d*[<>]/.test(word)) &&
			(segment.includes('<<') ||
				parts[previous]?.next === '|' ||
				// bash <(curl …)
				(next === '(' && /<\s*$/.test(segment)))
		)
			return hold(`${program} runs a script from its input`);
		// bash -c 'cmd' runs a command written as one word.
		const script = /^(?:ba|da|k|z)?sh$/.test(program)
			? args.findIndex((word, index) => index > 0 && /^-\w*c\w*$/.test(word))
			: -1;
		if (script !== -1) {
			let body: string | undefined;
			for (let at = script + 1; at < args.length && body === undefined; at++) {
				const word = args[at]!;
				// -o pipefail and +O extglob take a value.
				if (/^[-+][oO]$/.test(word)) at++;
				else if (!/^[-+]/.test(word)) body = word;
			}

			// bash -c "$(curl …)" runs whatever the download says.
			if (body === undefined || /\$\(|`|<\(/.test(body))
				return hold(`${program} -c runs a script made by another command`);
			const inner = checkApproval(body, policy, {startDir: cwd});
			if (inner.kind === 'hold') return inner;
		}

		if (
			['eval', 'source', '.'].includes(program) &&
			(/\$\(|`/.test(segment) ||
				next === '$(' ||
				next === '`' ||
				(next === '(' && /<\s*$/.test(segment)))
		)
			return hold(`${program} runs a script made by another command`);
		// env -S'cmd' and --split-string=cmd run a command written as one word.
		const split = words
			.map(word => /^(?:-S|--split-string=)(.+)$/.exec(bare(word))?.[1])
			.find(Boolean);
		if (bare(words[0] ?? '') === 'env' && split) {
			const inner = checkApproval(split, policy, {startDir: cwd});
			if (inner.kind === 'hold') return inner;
		}

		if (
			program === 'git' &&
			args.includes('push') &&
			/\bGIT_(?:DIR|WORK_TREE)=/.test(text)
		)
			return hold("a push from another repository's git directory");
		if (
			program === 'gh' &&
			(args.some(word => word.includes('/git/refs/heads/')) ||
				(args[1] === 'repo' && args[2] === 'sync'))
		)
			return hold('it moves a branch on GitHub directly');

		const scope: Scope = {
			inside: spaceVariables(text, before, policy),
			prefixed,
			cwd:
				movesDir ||
				(HIDES_DIRECTORY.test(before) && CHANGES_DIRECTORY.test(before))
					? null
					: cwd,
			ifsChanged,
		};
		const pushed = pushToMain(args, policy, scope.cwd);
		if (pushed) return hold(pushed);
		const [sub = '', action = ''] =
			program === 'git' ? gitSubcommand(args.map(word => bare(word))) : [];
		if (SHARED_GIT[sub]?.has(action))
			return hold(`git ${sub} ${action} reaches state every space shares`);
		const written = writesAgentConfig(raw, program, scope.cwd, policy);
		if (written) return hold(written);
		const deletes =
			DELETES.has(program) || (program === 'gio' && raw[1] === 'trash');
		// rm -rf $(cat list): the targets come from a command run first.
		const substituted = next === '$(' || next === '`';
		if (
			substituted &&
			(deletes ||
				(program === 'find' && /\s-delete\b/.test(text)) ||
				(program === 'git' && args.includes('push')))
		)
			return hold(`${program} with words from a command substitution`);
		if (
			program === 'find' &&
			raw.includes('-delete') &&
			raw.some(word => ['-L', '-H', '-follow', '-files0-from'].includes(word))
		)
			return hold(
				'find -delete that follows links or reads its paths from a file',
			);
		if (deletes) {
			const targets = deleteTargets(program === 'gio' ? raw.slice(1) : raw);
			// rm -rf with its target on the next screen line reads as no target.
			if (targets.length === 0)
				return hold(`${program} with no target on its line`);
			const verdict = checkTargets(targets, scope, policy, program);
			if (verdict.kind === 'hold') return verdict;
		}

		const starts = program === 'find' ? findDeleteStarts(raw) : null;
		if (starts) {
			const verdict = checkTargets(starts, scope, policy, 'find -delete');
			if (verdict.kind === 'hold') return verdict;
		}

		if (words[0] === 'cd') {
			// A cd in a pipeline runs in a subshell, and one before || may not run.
			const target =
				words.length === 2 && prefixed.size === 0 && words[1] !== '-'
					? readTarget(words[1]!)
					: null;
			const paths = target && targetPaths(target, scope);
			// mkdir x && cd x && rm *: what follows by && runs only if the cd did.
			chainedCd = !unconditional && next === '&&';
			cwd =
				// CDPATH sends a relative cd somewhere else.
				!/\bCDPATH\b/.test(text) &&
				(unconditional || chainedCd) &&
				!['|', '||', '&'].includes(next ?? '') &&
				paths?.length === 1 &&
				// Into agent config too, so a write from there is still placed.
				(placeOf(paths[0]!, policy).kind === 'approve' ||
					(policy.worktree !== null &&
						below(path.posix.normalize(paths[0]!), policy.worktree) !== null))
					? path.posix.normalize(paths[0]!)
					: null;
		}

		// Past the && chain, a conditional cd may not have run.
		if (chainedCd && words[0] !== 'cd' && next !== '&&') {
			cwd = null;
			chainedCd = false;
		}

		const assignsOnly = words.length === 0 && prefixed.size > 0;
		unconditional =
			next === ';' || (next === '&&' && unconditional && assignsOnly);
		before += segment + (next ?? '');
	}

	return approve;
}
