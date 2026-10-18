import {parseArgs} from 'node:util';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';
import {shellQuote} from './shell-quote.ts';
import {MAIN_PANE} from './tmux.ts';

export const COMPANION_VERBS = [
	'run',
	'keys',
	'read',
	'resize',
	'close',
	'list',
	'width',
] as const;

export type CompanionVerb = (typeof COMPANION_VERBS)[number];

export type SplitDirection = 'right' | 'down';

export type CompanionCommand =
	| {
			verb: 'run';
			space?: string;
			pane: string;
			split: SplitDirection;
			size?: string;
			command: string;
	  }
	| {
			verb: 'keys';
			space?: string;
			pane: string;
			enter: boolean;
			keys: string[];
			text?: string;
	  }
	| {verb: 'read'; space?: string; pane: string; lines: number}
	| {
			verb: 'resize';
			space?: string;
			pane: string;
			width?: string;
			height?: string;
	  }
	| {verb: 'close'; space?: string; pane: string}
	| {verb: 'list'; space?: string; json: boolean}
	| {verb: 'width'; space?: string; width: PaneWidth | 'reset'}
	| {verb: 'help'; text: string};

export class CompanionUsageError extends Error {}

const companionHelp = `
	Usage
	  $ pappardelle companion <command...>
	  $ pappardelle companion run    [--pane NAME] [--split right|down] [--size N|N%] -- <command...>
	  $ pappardelle companion keys   [--pane NAME] [--no-enter] [--keys KEY]... [text]
	  $ pappardelle companion read   [--pane NAME] [--lines N]
	  $ pappardelle companion resize NAME [--width N|N%] [--height N|N%]
	  $ pappardelle companion close  NAME
	  $ pappardelle companion list   [--json]
	  $ pappardelle companion width  <N|N%|reset>

	Changes the companion pane of a Pappardelle space. Every verb takes
	--space KEY and defaults to $PAPPARDELLE_SPACE. Only the space's companion
	session is ever touched, never its agent session.

	With no verb, the arguments are a command for the main pane of this
	space's own companion: \`pappardelle companion hunk diff --watch\` is
	\`run --pane main -- hunk diff --watch\` in $PAPPARDELLE_SPACE. A command
	that starts with a verb name needs the explicit \`run --\` form.

	A single command argument runs as a shell command line, so pipes work
	(\`run -- 'make 2>&1 | less'\`). Several arguments are quoted one by one.

	Commands
	  run     Run a command in pane NAME (default main). An existing pane is
	          restarted with the command; a missing one is split off main
	  keys    Type text into a pane and press Enter (--no-enter skips it),
	          or send tmux key names such as Escape, C-c, q with --keys
	  read    Print the last N lines of a pane (default 50)
	  resize  Resize pane NAME
	  close   Close pane NAME. main can't be closed; run something else in it
	  list    List the companion's panes
	  width   Set this space's companion column width in the TUI, or reset it
`;

const spaceOption = {space: {type: 'string'}} as const;
const helpOption = {help: {type: 'boolean', short: 'h'}} as const;

function splitAtDoubleDash(argv: readonly string[]): {
	flags: string[];
	rest: string[] | undefined;
} {
	const index = argv.indexOf('--');
	if (index === -1) return {flags: [...argv], rest: undefined};
	return {flags: argv.slice(0, index), rest: argv.slice(index + 1)};
}

/**
 * One argument is a shell command line as typed; several are an argv, quoted
 * so each survives the shell intact.
 */
export function commandFromArgs(args: readonly string[]): string {
	if (args.length === 1) return args[0]!;
	return args.map(arg => shellQuote(arg)).join(' ');
}

function withUsageError<T>(verb: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		throw new CompanionUsageError(
			`${error instanceof Error ? error.message : String(error)}\nRun pappardelle companion --help for usage (${verb})`,
		);
	}
}

const SIZE_PATTERN = /^\d+%?$/;

function checkSize(
	flag: string,
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (!SIZE_PATTERN.test(value) || /^0+%?$/.test(value)) {
		throw new CompanionUsageError(
			`${flag} takes a positive number of cells or a percentage, such as 20 or 30%`,
		);
	}

	return value;
}

function onePane(verb: string, positionals: string[]): string {
	if (positionals.length !== 1) {
		throw new CompanionUsageError(`Usage: pappardelle companion ${verb} NAME`);
	}

	return positionals[0]!;
}

function parseWidth(value: string | undefined): PaneWidth | 'reset' {
	if (value === 'reset') return 'reset';
	const width: unknown =
		value !== undefined && /^\d+$/.test(value) ? Number(value) : value;
	if (!isPaneWidth(width)) {
		throw new CompanionUsageError(
			'Usage: pappardelle companion width <N|N%|reset>',
		);
	}

	return width;
}

/**
 * Parse the arguments after `companion`. Runs before meow, which would
 * otherwise read the wrapped command's own flags as Pappardelle's.
 */
export function parseCompanionArgs(argv: readonly string[]): CompanionCommand {
	const [first, ...rest] = argv;
	if (first === undefined || first === '--help' || first === '-h') {
		return {verb: 'help', text: companionHelp};
	}

	if (!(COMPANION_VERBS as readonly string[]).includes(first)) {
		if (first.startsWith('-')) {
			throw new CompanionUsageError(
				`Unknown flag ${first} for pappardelle companion\nRun pappardelle companion --help for usage`,
			);
		}

		// The shortcut only ever reaches the caller's own space, so it takes no
		// --space: `space` stays undefined and resolves from $PAPPARDELLE_SPACE.
		return {
			verb: 'run',
			pane: MAIN_PANE,
			split: 'down',
			command: commandFromArgs(argv),
		};
	}

	const verb = first as CompanionVerb;
	const {flags, rest: afterDash} = splitAtDoubleDash(rest);

	switch (verb) {
		case 'run': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {
						...helpOption,
						...spaceOption,
						pane: {type: 'string'},
						split: {type: 'string'},
						size: {type: 'string'},
					},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			const commandArgs = [...positionals, ...(afterDash ?? [])];
			if (commandArgs.length === 0) {
				throw new CompanionUsageError(
					'Usage: pappardelle companion run [--pane NAME] [--split right|down] [--size N|N%] -- <command...>',
				);
			}

			const split = values.split ?? 'down';
			if (split !== 'right' && split !== 'down') {
				throw new CompanionUsageError('--split takes right or down');
			}

			return {
				verb,
				space: values.space,
				pane: values.pane ?? MAIN_PANE,
				split,
				size: checkSize('--size', values.size),
				command: commandFromArgs(commandArgs),
			};
		}

		case 'keys': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {
						...helpOption,
						...spaceOption,
						pane: {type: 'string'},
						'no-enter': {type: 'boolean'},
						keys: {type: 'string', multiple: true},
					},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			const words = [...positionals, ...(afterDash ?? [])];
			const keys = values.keys ?? [];
			if (keys.length > 0 && words.length > 0) {
				throw new CompanionUsageError('Pass text or --keys, not both');
			}

			return {
				verb,
				space: values.space,
				pane: values.pane ?? MAIN_PANE,
				enter: !values['no-enter'],
				keys,
				text: words.length > 0 ? words.join(' ') : undefined,
			};
		}

		case 'read': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {
						...helpOption,
						...spaceOption,
						pane: {type: 'string'},
						lines: {type: 'string'},
					},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			if (positionals.length > 0 || afterDash) {
				throw new CompanionUsageError(
					'Usage: pappardelle companion read [--pane NAME] [--lines N]',
				);
			}

			const lines = values.lines === undefined ? 50 : Number(values.lines);
			if (!Number.isInteger(lines) || lines <= 0) {
				throw new CompanionUsageError('--lines takes a positive number');
			}

			return {verb, space: values.space, pane: values.pane ?? MAIN_PANE, lines};
		}

		case 'resize': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {
						...helpOption,
						...spaceOption,
						width: {type: 'string'},
						height: {type: 'string'},
					},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			const width = checkSize('--width', values.width);
			const height = checkSize('--height', values.height);
			if (width === undefined && height === undefined) {
				throw new CompanionUsageError(
					'Usage: pappardelle companion resize NAME [--width N|N%] [--height N|N%]',
				);
			}

			return {
				verb,
				space: values.space,
				pane: onePane(verb, [...positionals, ...(afterDash ?? [])]),
				width,
				height,
			};
		}

		case 'close': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {...helpOption, ...spaceOption},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			return {
				verb,
				space: values.space,
				pane: onePane(verb, [...positionals, ...(afterDash ?? [])]),
			};
		}

		case 'list': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {
						...helpOption,
						...spaceOption,
						json: {type: 'boolean'},
					},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			if (positionals.length > 0 || afterDash) {
				throw new CompanionUsageError(
					'Usage: pappardelle companion list [--json]',
				);
			}

			return {verb, space: values.space, json: values.json ?? false};
		}

		case 'width': {
			const {values, positionals} = withUsageError(verb, () =>
				parseArgs({
					args: flags,
					allowPositionals: true,
					strict: true,
					options: {...helpOption, ...spaceOption},
				}),
			);
			if (values.help) return {verb: 'help', text: companionHelp};
			const args = [...positionals, ...(afterDash ?? [])];
			if (args.length !== 1) parseWidth(undefined);
			return {verb, space: values.space, width: parseWidth(args[0])};
		}
	}
}
