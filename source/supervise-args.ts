import {parseArgs, type ParseArgsConfig} from 'node:util';
import type {WaitTarget} from './agent-state.ts';
import {
	decodeCursor,
	WATCH_TARGETS,
	type WatchCursor,
	type WatchTarget,
} from './space-watch.ts';

export const SUPERVISE_VERBS = [
	'screen',
	'state',
	'wait',
	'watch',
	'answer',
	'queue',
	'schedule',
	'schedules',
	'unschedule',
	'tui',
] as const;

export type SuperviseVerb = (typeof SUPERVISE_VERBS)[number];

export function isSuperviseVerb(value: string | undefined): boolean {
	return (SUPERVISE_VERBS as readonly string[]).includes(value ?? '');
}

const WAIT_TARGET_NAMES: readonly WaitTarget[] = [
	'working',
	'idle',
	'blocked',
	'ready',
	'changed',
];

export const MAX_WAIT_SECONDS = 600;
const MAX_FOCUS_LOG_SECONDS = 600;

export type ScheduleRequest =
	| {kind: 'at'; at: string; message: string}
	| {kind: 'after_limit'; message: string}
	| {kind: 'keep_going'; every: string; nudge: string; until?: string};

export type SuperviseCommand =
	| {
			verb: 'screen';
			key: string;
			companion: boolean;
			pane: string;
			lines: number;
	  }
	| {verb: 'state'; key: string; json: boolean; tabs: boolean}
	| {
			verb: 'wait';
			key: string;
			until: WaitTarget;
			timeoutSeconds: number;
			json: boolean;
	  }
	| {
			verb: 'watch';
			keys: string[];
			until: WatchTarget[];
			since?: WatchCursor;
			timeoutSeconds: number;
			json: boolean;
	  }
	| {
			verb: 'answer';
			key: string;
			/** More than one only on a multi-select question. */
			options: number[];
			text?: string;
			keys: string[];
			force: boolean;
	  }
	| {verb: 'queue'; key: string; text?: string}
	| {verb: 'schedule'; key: string; request: ScheduleRequest}
	| {verb: 'fire'; id: string}
	| {verb: 'schedules'; key?: string}
	| {verb: 'unschedule'; id: string}
	| {verb: 'panes'}
	| {verb: 'focus-log'; seconds: number}
	| {verb: 'help'; text: string};

export class SuperviseUsageError extends Error {}

export const superviseHelp = `
	Usage
	  $ pappardelle screen KEY [--companion [--pane NAME]] [--lines N]
	  $ pappardelle state KEY [--json] [--tabs]
	  $ pappardelle wait KEY --until working|idle|blocked|ready|changed [--timeout SECONDS] [--json]
	  $ pappardelle watch [KEY...] [--until STATE...] [--since CURSOR] [--timeout SECONDS] [--json]
	  $ pappardelle answer KEY (--option N... | --text TEXT | --keys KEY...) [--force]
	  $ pappardelle queue KEY [text]
	  $ pappardelle schedule KEY --at TIME --message TEXT
	  $ pappardelle schedule KEY --after-limit [--message TEXT]
	  $ pappardelle schedule KEY --keep-going --every DURATION --nudge TEXT [--until TIME]
	  $ pappardelle schedules [KEY]
	  $ pappardelle unschedule ID
	  $ pappardelle tui panes
	  $ pappardelle tui focus-log [--seconds N]

	Watch and answer the agent in another space. KEY is a space key such as
	STA-696, a bare number with the team prefix, or main.

	Commands
	  screen      Print the agent's screen (or its companion's) with scrollback
	  state       working, permission, question, auth, dialog (a Codex dialog,
	              answered by a person), usage_limit, draft
	              (text in the input box), idle or no_session, with the
	              pending command or question. --tabs also reads every tab of a
	              question dialog, which presses Right and Left in it
	  wait        Return once the state matches, or after --timeout (default 50,
	              at most ${MAX_WAIT_SECONDS}) with the state as it is then
	  watch       Wait for any of several spaces (default: every space with an
	              agent but your own) to change state, or with --until to reach
	              one of those states (blocked is any that waits on a person).
	              Without --since, spaces already in an --until state come back
	              at once. The answer carries a cursor: pass it as --since next
	              time, and nothing that changed in between is missed
	  answer      Press an option on a permission prompt or question, tick the
	              --options of a multi-select question and confirm them, or
	              type --text into a question's free-text row. It checks the
	              screen after each step, and fails if the agent didn't take
	              it. Approving a
	              Bash command once needs the hard refusals (push, --force, rm
	              outside QA scratch…) and a Haiku check that it publishes and
	              destroys nothing; anything else exits 3 with the command and
	              the reason, for a person to decide. --force skips both
	  queue       Hold a message for the next scheduled send to that space
	  schedule    Wake the agent with an OS timer: a message at a time, continue
	              once a Codex usage limit resets, or a nudge whenever it sits
	              idle two checks in a row
	  schedules   List scheduled wake-ups
	  unschedule  Cancel one
	  tui panes   What every TUI's rail and viewer panes are running
	  tui focus-log  Log active-pane and client-focus changes for --seconds (30)

	Everything sent or scheduled, and each change watch reports, is logged to
	~/.pappardelle/repos/<repo>/supervise.jsonl.
`;

function positiveInt(value: string | undefined, flag: string): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new SuperviseUsageError(`${flag} takes a positive whole number`);
	}

	return number;
}

function timeoutSeconds(value: string | undefined): number {
	const seconds = value === undefined ? 50 : positiveInt(value, '--timeout');
	if (seconds > MAX_WAIT_SECONDS) {
		throw new SuperviseUsageError(
			`--timeout is at most ${MAX_WAIT_SECONDS} seconds`,
		);
	}

	return seconds;
}

function oneKey(positionals: string[], verb: string, name = 'KEY'): string {
	if (positionals.length !== 1) {
		throw new SuperviseUsageError(`Usage: pappardelle ${verb} ${name} ...`);
	}

	return positionals[0]!;
}

function parse<T extends NonNullable<ParseArgsConfig['options']>>(
	argv: string[],
	options: T,
) {
	try {
		return parseArgs({
			args: argv,
			options,
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		throw new SuperviseUsageError((error as Error).message);
	}
}

function parseSchedule(argv: string[]): SuperviseCommand {
	if (argv[0] === 'fire') {
		return {verb: 'fire', id: oneKey(argv.slice(1), 'schedule fire', 'ID')};
	}

	const {values, positionals} = parse(argv, {
		at: {type: 'string'},
		'after-limit': {type: 'boolean'},
		'keep-going': {type: 'boolean'},
		message: {type: 'string'},
		every: {type: 'string'},
		nudge: {type: 'string'},
		until: {type: 'string'},
	});
	const key = oneKey(positionals, 'schedule');
	const modes = [
		values.at !== undefined,
		values['after-limit'],
		values['keep-going'],
	];
	if (modes.filter(Boolean).length !== 1) {
		throw new SuperviseUsageError(
			'schedule takes exactly one of --at, --after-limit or --keep-going',
		);
	}

	if (values.at !== undefined) {
		if (!values.message) {
			throw new SuperviseUsageError('schedule --at needs --message');
		}

		return {
			verb: 'schedule',
			key,
			request: {
				kind: 'at',
				at: values.at as string,
				message: values.message as string,
			},
		};
	}

	if (values['after-limit']) {
		return {
			verb: 'schedule',
			key,
			request: {
				kind: 'after_limit',
				message: (values.message as string | undefined) ?? 'continue',
			},
		};
	}

	if (!values.every || !values.nudge) {
		throw new SuperviseUsageError(
			'schedule --keep-going needs --every and --nudge',
		);
	}

	return {
		verb: 'schedule',
		key,
		request: {
			kind: 'keep_going',
			every: values.every as string,
			nudge: values.nudge as string,
			...(values.until ? {until: values.until as string} : {}),
		},
	};
}

export function parseSuperviseArgs(argv: string[]): SuperviseCommand {
	const [first, ...rest] = argv;
	const verb = first ?? '';
	if (rest.includes('--help') || rest.includes('-h')) {
		return {verb: 'help', text: superviseHelp};
	}

	switch (verb) {
		case 'screen': {
			const {values, positionals} = parse(rest, {
				companion: {type: 'boolean'},
				pane: {type: 'string'},
				lines: {type: 'string'},
			});
			return {
				verb,
				key: oneKey(positionals, verb),
				companion: Boolean(values.companion),
				pane: (values.pane as string | undefined) ?? 'main',
				lines:
					values.lines === undefined
						? 60
						: positiveInt(values.lines as string, '--lines'),
			};
		}

		case 'state': {
			const {values, positionals} = parse(rest, {
				json: {type: 'boolean'},
				tabs: {type: 'boolean'},
			});
			return {
				verb,
				key: oneKey(positionals, verb),
				json: Boolean(values.json),
				tabs: Boolean(values.tabs),
			};
		}

		case 'wait': {
			const {values, positionals} = parse(rest, {
				until: {type: 'string'},
				timeout: {type: 'string'},
				json: {type: 'boolean'},
			});
			const until = values.until as WaitTarget | undefined;
			if (!until || !WAIT_TARGET_NAMES.includes(until)) {
				throw new SuperviseUsageError(
					`wait needs --until ${WAIT_TARGET_NAMES.join('|')}`,
				);
			}

			return {
				verb,
				key: oneKey(positionals, verb),
				until,
				timeoutSeconds: timeoutSeconds(values.timeout as string | undefined),
				json: Boolean(values.json),
			};
		}

		case 'watch': {
			const {values, positionals} = parse(rest, {
				until: {type: 'string', multiple: true},
				since: {type: 'string'},
				timeout: {type: 'string'},
				json: {type: 'boolean'},
			});
			const until = (values.until as string[] | undefined) ?? [];
			const unknown = until.find(
				state => !(WATCH_TARGETS as readonly string[]).includes(state),
			);
			if (unknown !== undefined) {
				throw new SuperviseUsageError(
					`--until takes ${WATCH_TARGETS.join('|')}, not ${unknown}`,
				);
			}

			let since: WatchCursor | undefined;
			if (values.since !== undefined) {
				since = decodeCursor(values.since as string) ?? undefined;
				if (!since) {
					throw new SuperviseUsageError(
						'--since takes the cursor a previous watch returned',
					);
				}
			}

			return {
				verb,
				keys: positionals,
				until: until as WatchTarget[],
				...(since ? {since} : {}),
				timeoutSeconds: timeoutSeconds(values.timeout as string | undefined),
				json: Boolean(values.json),
			};
		}

		case 'answer': {
			const {values, positionals} = parse(rest, {
				option: {type: 'string', multiple: true},
				text: {type: 'string'},
				keys: {type: 'string', multiple: true},
				force: {type: 'boolean'},
			});
			const keys = (values.keys as string[] | undefined) ?? [];
			const options = ((values.option as string[] | undefined) ?? []).map(
				value => positiveInt(value, '--option'),
			);
			const text = values.text as string | undefined;
			const given = [options.length > 0, keys.length > 0, text !== undefined];
			if (given.filter(Boolean).length !== 1) {
				throw new SuperviseUsageError(
					'answer takes one of --option N (repeat it on a multi-select question), --text or --keys',
				);
			}

			if (text?.trim() === '') {
				throw new SuperviseUsageError('--text needs some text');
			}

			return {
				verb,
				key: oneKey(positionals, verb),
				options,
				...(text === undefined ? {} : {text}),
				keys,
				force: Boolean(values.force),
			};
		}

		case 'queue': {
			const [key, ...text] = rest;
			if (!key)
				throw new SuperviseUsageError('Usage: pappardelle queue KEY [text]');
			return {verb, key, ...(text.length > 0 ? {text: text.join(' ')} : {})};
		}

		case 'schedule': {
			return parseSchedule(rest);
		}

		case 'schedules': {
			const {positionals} = parse(rest, {});
			return positionals[0] ? {verb, key: positionals[0]} : {verb};
		}

		case 'unschedule': {
			return {verb, id: oneKey(parse(rest, {}).positionals, verb, 'ID')};
		}

		case 'tui': {
			const [sub, ...tuiArgs] = rest;
			if (sub === 'panes') return {verb: 'panes'};
			if (sub === 'focus-log') {
				const {values} = parse(tuiArgs, {seconds: {type: 'string'}});
				const seconds =
					values.seconds === undefined
						? 30
						: positiveInt(values.seconds as string, '--seconds');
				if (seconds > MAX_FOCUS_LOG_SECONDS) {
					throw new SuperviseUsageError(
						`--seconds is at most ${MAX_FOCUS_LOG_SECONDS}`,
					);
				}

				return {verb: 'focus-log', seconds};
			}

			throw new SuperviseUsageError('Usage: pappardelle tui panes|focus-log');
		}

		default: {
			return {verb: 'help', text: superviseHelp};
		}
	}
}
