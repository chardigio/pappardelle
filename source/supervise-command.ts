// The verbs an agent uses to watch and answer agents in other spaces:
// `screen`, `state`, `wait`, `answer`, `queue`, the schedule verbs and the
// `tui` diagnostics. See supervise-args.ts for their flags.

import {readFileSync} from 'node:fs';
import {stripVTControlCharacters} from 'node:util';
import {
	captureAgentScreen,
	listAgentKeys,
	readAgentState,
	WAIT_TARGETS,
	type AgentState,
	type AgentStateDeps,
	type AgentStateReport,
} from './agent-state.ts';
import {
	changesSince,
	encodeCursor,
	snapshot,
	stateOf,
	targetStates,
	type WatchCursor,
} from './space-watch.ts';
import {
	parseAgentScreen,
	type CodexDialog,
	type PromptOption,
	type QuestionDialog,
} from './agent-screen.ts';
import {
	checkApproval,
	type ApprovalPolicy,
	type ApprovalVerdict,
} from './approve-policy.ts';
import {readCompanionPane} from './companion.ts';
import {
	deleteJob,
	fireJob,
	limitLiftsAt,
	listJobs,
	loadJob,
	newJobId,
	parseDuration,
	parseWhen,
	queueMessage,
	saveJob,
	timerWhen,
	type FireResult,
	type Job,
	type ScheduleStore,
	type SendOutcome,
} from './schedule.ts';
import type {TimerBackend} from './schedule-timers.ts';
import {
	parseSuperviseArgs,
	SuperviseUsageError,
	type ScheduleRequest,
	type SuperviseCommand,
} from './supervise-args.ts';
import {recordSupervision, type SuperviseEntry} from './supervise-log.ts';
import type {OuterTmuxRunner} from './tmux.ts';

export const POLICY_REFUSED_EXIT = 3;

export type SuperviseDeps = {
	repo: () => string;
	resolveKey: (raw: string) => string;
	/** The hook file's key for a space: `{repo}-{branch}` for main. */
	hookKey: (key: string) => Promise<string>;
	runner: OuterTmuxRunner;
	serverRunner: OuterTmuxRunner;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** Resolves early when a status file changes, else after `ms`. */
	waitForStatusChange: (ms: number) => Promise<void>;
	send: (key: string, text: string) => Promise<SendOutcome>;
	sendKeys: (key: string, keys: string[]) => 'sent' | 'no-session' | 'failed';
	/** Types text as it is, where sendKeys would read `Enter` as the key. */
	typeText: (key: string, text: string) => 'sent' | 'no-session' | 'failed';
	/** The model check a command passes after the hard refusals. */
	classify: (key: string, command: string) => Promise<ApprovalVerdict>;
	policy: ApprovalPolicy;
	store: () => ScheduleStore;
	timers: () => TimerBackend;
	caller: string;
	readStdin: () => string | undefined;
	out: (text: string) => void;
	err: (text: string) => void;
	log?: typeof recordSupervision;
};

const SCREEN_POLL_MS = 2000;
const TAB_SETTLE_MS = 300;

async function readState(key: string, deps: SuperviseDeps) {
	const stateDeps: AgentStateDeps = {
		repo: deps.repo(),
		runner: deps.runner,
		now: deps.now,
		hookKey: await deps.hookKey(key),
	};
	return readAgentState(key, stateDeps);
}

function formatOptions(options: PromptOption[]): string {
	return options
		.map(
			option =>
				`  ${option.number}. ${option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] '}${option.label}`,
		)
		.join('\n');
}

export function formatState(report: AgentStateReport): string {
	const lines = [
		`${report.key}: ${report.state}${report.app ? ` (${report.app})` : ''}`,
	];
	if (report.permission) {
		const {tool, subagent, description, command} = report.permission;
		lines.push(
			`${tool}${subagent ? ` from ${subagent}` : ''}${description ? `: ${description}` : ''}`,
			command,
			formatOptions(report.permission.options),
		);
	}

	if (report.question) lines.push(formatQuestion(report.question));

	if (report.usageLimit) {
		lines.push(
			`Usage limit resets ${report.usageLimit.resetText || 'at an unknown time'}${report.usageLimit.passed ? ' (passed)' : ''}`,
		);
	}

	if (report.codexDialog)
		lines.push(`Codex dialog: ${report.codexDialog.title}`);
	// Shown under a limit too, since a draft there stops the wake-up.
	if (report.composer) lines.push(`Composer: ${report.composer}`);
	return lines.join('\n');
}

function formatQuestion(question: QuestionTab): string {
	const lines = [
		question.multiSelect
			? `${question.question} (pick several)`
			: question.question,
		formatOptions(question.options),
	];
	const row = question.textOption;
	// Typed answers are only taken on a single-select question.
	if (row && !question.multiSelect)
		lines.push(
			`  ${row.number}. ${row.text || (row.open ? '' : '(type an answer with --text)')}`,
		);
	return lines.join('\n');
}

const paneText = (screen: string) => screen.trim() || '(the pane is blank)';

type QuestionTab = Pick<
	QuestionDialog,
	'question' | 'options' | 'multiSelect' | 'textOption'
>;
const asTab = ({
	question,
	options,
	multiSelect,
	textOption,
}: QuestionDialog) => ({
	question,
	options,
	multiSelect,
	textOption,
});

/**
 * Every tab of a multi-question dialog. Right moves to the next question and
 * Left back; the dialog ends on the tab it started on.
 */
async function readQuestionTabs(
	key: string,
	report: AgentStateReport,
	deps: SuperviseDeps,
): Promise<QuestionTab[]> {
	const first = report.question;
	if (!first) throw new SuperviseUsageError(`${key} is not showing a question`);
	const tabs: QuestionTab[] = [asTab(first)];
	const press = (direction: 'Right' | 'Left') => {
		if (deps.sendKeys(key, [direction]) !== 'sent') {
			throw new Error(`Could not press ${direction} in ${key}`);
		}
	};

	const current = () => {
		const capture = captureAgentScreen(key, 60, {
			repo: deps.repo(),
			runner: deps.runner,
		});
		return capture ? parseAgentScreen(capture, deps.now()).question : null;
	};

	for (let index = 1; index < first.tabs.length; index++) {
		press('Right');
		await deps.sleep(TAB_SETTLE_MS);
		const tab = current();
		if (tab) tabs.push(asTab(tab));
	}

	for (let index = 1; index < first.tabs.length; index++) press('Left');
	await deps.sleep(TAB_SETTLE_MS);
	if (current()?.question !== first.question) {
		throw new Error(`${key}'s question dialog did not return to its first tab`);
	}

	return tabs;
}

async function waitFor(
	command: Extract<SuperviseCommand, {verb: 'wait'}>,
	key: string,
	deps: SuperviseDeps,
): Promise<AgentStateReport & {timedOut: boolean}> {
	const deadline = deps.now().getTime() + command.timeoutSeconds * 1000;
	const first = await readState(key, deps);
	const matches = (report: AgentStateReport) =>
		command.until === 'changed'
			? report.state !== first.state
			: WAIT_TARGETS[command.until].includes(report.state);
	// Nothing will change in a space with no agent, so don't wait it out.
	if (
		(command.until !== 'changed' && matches(first)) ||
		first.state === 'no_session'
	) {
		return {...first, timedOut: false};
	}

	let report = first;
	while (deps.now().getTime() < deadline) {
		// The screen-only states (a usage limit, a draft) change no status file,
		// so the screen is read again at least this often.
		await deps.waitForStatusChange(
			Math.min(SCREEN_POLL_MS, deadline - deps.now().getTime()),
		);
		report = await readState(key, deps);
		if (matches(report)) return {...report, timedOut: false};
	}

	return {...report, timedOut: true};
}

export type SpaceChange = {
	key: string;
	/** null for a space the cursor didn't have. */
	from: AgentState | null;
	to: AgentState;
} & Partial<
	Pick<
		AgentStateReport,
		'permission' | 'question' | 'codexDialog' | 'usageLimit' | 'composer'
	>
>;

export type WatchResult =
	| {result: 'changed'; changes: SpaceChange[]; cursor: string}
	| {result: 'timed_out'; changes: []; cursor: string};

function describeChange(report: AgentStateReport, from: AgentState | null) {
	const change: SpaceChange = {key: report.key, from, to: report.state};
	for (const field of [
		'permission',
		'question',
		'codexDialog',
		'usageLimit',
		'composer',
	] as const) {
		if (report[field]) Object.assign(change, {[field]: report[field]});
	}

	return change;
}

function describeChanges(
	reports: AgentStateReport[],
	baseline: WatchCursor,
): SpaceChange[] {
	return reports.map(report =>
		describeChange(report, stateOf(baseline[report.key] ?? '')),
	);
}

/** The caller's own space, which watching every space leaves out. */
function ownSpace(deps: SuperviseDeps): string | null {
	if (deps.caller === 'user' || deps.caller.startsWith('timer:')) return null;
	try {
		return deps.resolveKey(deps.caller);
	} catch {
		return deps.caller;
	}
}

async function watchSpaces(
	command: Extract<SuperviseCommand, {verb: 'watch'}>,
	deps: SuperviseDeps,
): Promise<WatchResult> {
	const deadline = deps.now().getTime() + command.timeoutSeconds * 1000;
	const named = command.keys.map(raw => deps.resolveKey(raw));
	const own = ownSpace(deps);
	const keys = () => {
		if (named.length > 0) return named;
		// A space in the cursor that has since closed still reports, as no_session.
		const all = new Set([
			...listAgentKeys(deps.repo(), deps.runner),
			...Object.keys(command.since ?? {}),
		]);
		if (own) all.delete(own);
		return [...all];
	};

	// Once a space reported closed, watching every space forgets it.
	const toCursor = (seen: WatchCursor) =>
		encodeCursor(
			named.length > 0
				? seen
				: Object.fromEntries(
						Object.entries(seen).filter(
							([, value]) => stateOf(value) !== 'no_session',
						),
					),
		);

	const read = async () =>
		Promise.all(keys().map(async key => readState(key, deps)));
	const targets = targetStates(command.until);
	let reports = await read();
	// Without a cursor, every space already in a target state is news; with no
	// targets either, only what changes from here on is.
	let baseline =
		command.since ??
		(targets
			? {}
			: Object.fromEntries(
					Object.entries(snapshot(reports)).filter(
						([, value]) => stateOf(value) !== 'no_session',
					),
				));
	for (;;) {
		const changed = changesSince(baseline, reports, targets);
		const cursor = toCursor({...baseline, ...snapshot(reports)});
		if (changed.length > 0) {
			return {
				result: 'changed',
				changes: describeChanges(changed, baseline),
				cursor,
			};
		}

		const left = deadline - deps.now().getTime();
		if (left <= 0) return {result: 'timed_out', changes: [], cursor};
		// A space that leaves a target state and comes back, say to a second
		// prompt, is news even though it ends where it started.
		baseline = {...baseline, ...snapshot(reports)};
		// The screen-only states (a usage limit, a draft) change no status file.
		await deps.waitForStatusChange(Math.min(SCREEN_POLL_MS, left));
		reports = await read();
	}
}

function formatChange(change: SpaceChange): string {
	const lines = [`${change.key}: ${change.from ?? 'new'} -> ${change.to}`];
	if (change.permission) {
		lines.push(
			`  ${change.permission.tool}: ${change.permission.command}`,
			formatOptions(change.permission.options),
		);
	}

	if (change.question) {
		lines.push(
			`  ${change.question.question}`,
			formatOptions(change.question.options),
		);
	}

	if (change.codexDialog)
		lines.push(`  Codex dialog: ${change.codexDialog.title}`);
	if (change.composer) lines.push(`  Composer: ${change.composer}`);
	return lines.join('\n');
}

// Codex redraws its composer once the dialog closes.
const MODEL_SWITCH_SETTLE_MS = 500;

type AnswerResult =
	| {ok: true; pressed: string[]; entry: SuperviseEntry}
	| {ok: false; exit: number; message: string; entry?: SuperviseEntry};

/**
 * A digit on a Codex dialog only moves the highlight, except one that picks
 * Quit at once, so the arrows move to the option and Enter takes it.
 */
function codexDialogKeys(
	dialog: CodexDialog | null,
	option: number,
): string[] | null {
	if (!dialog?.selected || option > dialog.options) return null;
	const steps = option - dialog.selected;
	return [
		...Array.from({length: Math.abs(steps)}, () => (steps > 0 ? 'Down' : 'Up')),
		'Enter',
	];
}

// How long an agent gets to redraw after an answer before it counts as not taken.
const ANSWER_SETTLE_MS = 3000;
const ANSWER_POLL_MS = 250;

/** What the person sees on a prompt: answering it changes this. */
function promptShown(report: AgentStateReport): string {
	return JSON.stringify([
		report.state,
		report.permission?.command,
		report.question?.question,
		report.question?.options.map(option => [option.selected, option.checked]),
		report.question?.textOption,
		report.codexDialog?.title,
		report.codexDialog?.selected,
	]);
}

async function answerTaken(
	key: string,
	before: AgentStateReport,
	deps: SuperviseDeps,
): Promise<boolean> {
	const shown = promptShown(before);
	return settlesOn(key, report => promptShown(report) !== shown, deps);
}

type AnswerStep = {
	keys?: string[];
	text?: string;
	/** What the screen shows once the agent took the step. */
	expect: string;
	shows: (report: AgentStateReport) => boolean;
};

const sameRows = (a: readonly number[], b: readonly number[]) =>
	a.length === b.length && a.every((number, index) => number === b[index]);

/**
 * The steps that answer a question with typed text or with the ticks of a
 * multi-select, or why it can't be. Each one is checked on screen before the
 * next, since a key the dialog ignores looks the same as one it took.
 */
function planQuestionAnswer(
	command: Extract<SuperviseCommand, {verb: 'answer'}>,
	question: QuestionDialog,
): {steps: AnswerStep[]; sent: string} | string {
	const asked = question.question;
	const left: AnswerStep = {
		keys: ['Enter'],
		expect: 'the next question or the end of the dialog',
		shows: report =>
			report.state !== 'question' || report.question?.question !== asked,
	};
	const row = question.textOption;
	// While the free-text row is open it takes every key as text, digits too.
	if (row?.text)
		return `its free-text row already holds "${row.text}"; clear it first with --keys or by hand`;
	const leaveRow: AnswerStep[] = row?.open
		? [
				{
					keys: ['Up'],
					expect: 'the cursor off the free-text row',
					shows: report =>
						report.question?.question === asked &&
						report.question.textOption?.open === false,
				},
			]
		: [];

	if (command.text !== undefined) {
		const {text} = command;
		if (question.multiSelect)
			return 'typed answers on a multi-select question are not supported; tick options with --option';
		if (!row) return 'this question has no row to type an answer into';
		if (/[\r\n]/.test(text))
			return 'the free-text row takes one line; Enter would submit the rest';
		const flat = (value: string) => value.replaceAll(/\s+/g, ' ').trim();
		return {
			sent: text,
			steps: [
				...(row.open
					? []
					: [
							{
								keys: [String(row.number)],
								expect: 'the free-text row open for typing',
								shows: (report: AgentStateReport) =>
									report.question?.textOption?.open === true,
							},
						]),
				{
					text,
					expect: `"${text}" in the free-text row`,
					// Only the row's first line shows, so a long answer is checked
					// as far as it fits.
					shows(report) {
						const typed = flat(report.question?.textOption?.text ?? '');
						return typed !== '' && flat(text).startsWith(typed);
					},
				},
				left,
			],
		};
	}

	const wanted = [...new Set(command.options)].sort((a, b) => a - b);
	const numbers = question.options.map(option => option.number);
	if (row && wanted.includes(row.number))
		return `option ${row.number} is the free-text row; answer it with --text`;
	const missing = wanted.find(number => !numbers.includes(number));
	if (missing !== undefined) return `the question has no option ${missing}`;
	const labels = question.options
		.filter(option => wanted.includes(option.number))
		.map(option => `${option.number}. ${option.label}`);

	if (!question.multiSelect) {
		if (wanted.length > 1)
			return 'more than one --option answers a multi-select question; this is a single-select one';
		return {
			sent: labels.join(', '),
			steps: [...leaveRow, {...left, keys: [String(wanted[0])]}],
		};
	}

	const ticked = new Set(
		question.options
			.filter(option => option.checked)
			.map(option => option.number),
	);
	const toggles = numbers.filter(
		number => wanted.includes(number) !== ticked.has(number),
	);
	const tickedOn = (report: AgentStateReport) =>
		(report.question?.options ?? [])
			.filter(option => option.checked)
			.map(option => option.number);
	const lastRow = row?.number ?? Math.max(...numbers);
	const cursor = leaveRow.length > 0 ? lastRow - 1 : question.cursor;
	// Submit or Next sits under the last numbered row.
	const downs = cursor === null ? 0 : lastRow - cursor + 1;
	return {
		sent: labels.join(', '),
		steps: [
			...leaveRow,
			...(toggles.length > 0
				? [
						{
							keys: toggles.map(String),
							expect: `options ${wanted.join(', ')} ticked`,
							shows: (report: AgentStateReport) =>
								sameRows(tickedOn(report), wanted),
						},
					]
				: []),
			...(downs > 0
				? [
						{
							keys: Array.from({length: downs}, () => 'Down'),
							expect: 'the cursor on Submit or Next',
							shows: (report: AgentStateReport) =>
								report.question?.question === asked &&
								report.question.cursor === null &&
								sameRows(tickedOn(report), wanted),
						},
					]
				: []),
			left,
		],
	};
}

/** Runs each step and waits for it on screen; the step that never showed, if any. */
async function runSteps(
	key: string,
	steps: AnswerStep[],
	deps: SuperviseDeps,
): Promise<string | null> {
	for (const step of steps) {
		const sent =
			step.text === undefined
				? deps.sendKeys(key, step.keys ?? [])
				: deps.typeText(key, step.text);
		if (sent !== 'sent') return step.expect;
		// eslint-disable-next-line no-await-in-loop
		if (!(await settlesOn(key, step.shows, deps))) return step.expect;
	}

	return null;
}

async function settlesOn(
	key: string,
	shows: (report: AgentStateReport) => boolean,
	deps: SuperviseDeps,
): Promise<boolean> {
	for (let waited = 0; waited < ANSWER_SETTLE_MS; waited += ANSWER_POLL_MS) {
		// eslint-disable-next-line no-await-in-loop
		await deps.sleep(ANSWER_POLL_MS);
		// eslint-disable-next-line no-await-in-loop
		if (shows(await readState(key, deps))) return true;
	}

	return false;
}

function decideAnswer(
	command: Extract<SuperviseCommand, {verb: 'answer'}>,
	key: string,
	report: AgentStateReport,
	policy: ApprovalPolicy,
): AnswerResult {
	const chosen = command.options[0];
	if (report.state === 'dialog') {
		// Codex's dialogs decide things like trusting a folder, and Escape on
		// one can quit Codex, so a person answers them.
		const sent = chosen === undefined ? command.keys.join(' ') : String(chosen);
		const entry = {
			action: 'answer' as const,
			key,
			sent,
			detail: report.codexDialog?.title ?? '',
		};
		if (!command.force) {
			return {
				ok: false,
				exit: POLICY_REFUSED_EXIT,
				message: `${key} shows a Codex dialog ("${report.codexDialog?.title ?? ''}"); a person answers it`,
				entry: {...entry, verdict: 'refused: Codex dialog'},
			};
		}

		if (chosen === undefined) {
			return {
				ok: true,
				pressed: command.keys,
				entry: {...entry, verdict: 'forced'},
			};
		}

		const pressed = codexDialogKeys(report.codexDialog, chosen);
		if (!pressed) {
			return {
				ok: false,
				exit: 1,
				message: `${key}'s Codex dialog has no option ${chosen}; use --keys`,
			};
		}

		return {
			ok: true,
			pressed,
			entry: {...entry, sent: pressed.join(' '), verdict: 'forced'},
		};
	}

	if (report.state !== 'permission' && report.state !== 'question') {
		return {
			ok: false,
			exit: 1,
			message: `${key} is ${report.state}, not at a prompt`,
		};
	}

	const {permission} = report;
	const base = {
		action: 'answer' as const,
		key,
		...(permission ? {command: permission.command} : {}),
	};
	if (chosen === undefined) {
		const onlyEscape = command.keys.every(name => name === 'Escape');
		if (report.state === 'permission' && !onlyEscape && !command.force) {
			return {
				ok: false,
				exit: POLICY_REFUSED_EXIT,
				message: `Keys other than Escape on ${key}'s permission prompt need --force; answer it with --option`,
				entry: {
					...base,
					sent: command.keys.join(' '),
					verdict: 'refused: keys on a permission prompt',
				},
			};
		}

		return {
			ok: true,
			pressed: command.keys,
			entry: {...base, sent: command.keys.join(' ')},
		};
	}

	const pressed = [String(chosen)];
	if (report.state === 'question') {
		const label = report.question?.options.find(
			option => option.number === chosen,
		)?.label;
		return {
			ok: true,
			pressed,
			entry: {
				...base,
				sent: label ? `${chosen}. ${label}` : pressed[0],
				...(report.question ? {detail: report.question.question} : {}),
			},
		};
	}

	const option = permission?.options.find(
		candidate => candidate.number === chosen,
	);
	if (!permission || !option) {
		// The hook says a prompt is up but the screen shows none to check.
		if (command.force)
			return {
				ok: true,
				pressed,
				entry: {...base, sent: pressed[0], verdict: 'forced'},
			};
		return {
			ok: false,
			exit: POLICY_REFUSED_EXIT,
			message: `Can't read option ${chosen} on ${key}'s prompt; check it with \`pappardelle screen ${key}\``,
		};
	}

	const entry = {...base, sent: `${option.number}. ${option.label}`};
	if (option.kind === 'deny' || option.kind === 'other' || command.force) {
		return {
			ok: true,
			pressed,
			entry: {...entry, ...(command.force ? {verdict: 'forced'} : {})},
		};
	}

	// The policy reads shell commands. An edit or a write is checked by
	// neither its path nor its content here, so a person approves it.
	if (option.kind === 'approve_once' && permission.tool !== 'Bash command') {
		return {
			ok: false,
			exit: POLICY_REFUSED_EXIT,
			message: `Only Bash commands are approved without a person; this is "${permission.tool}"${permission.description ? ` (${permission.description})` : ''}`,
			entry: {...entry, verdict: `refused: ${permission.tool}`},
		};
	}

	if (option.kind === 'approve_always') {
		return {
			ok: false,
			exit: POLICY_REFUSED_EXIT,
			message: `"${option.label}" approves more than this command; a person decides that`,
			entry: {...entry, verdict: 'refused: approves more than this command'},
		};
	}

	const verdict = checkApproval(permission.command, policy);
	if (!verdict.allow) {
		return {
			ok: false,
			exit: POLICY_REFUSED_EXIT,
			message: `Not approved (${verdict.reason}); a person decides this one:\n${permission.command}`,
			entry: {...entry, verdict: `refused: ${verdict.reason}`},
		};
	}

	return {ok: true, pressed, entry: {...entry, verdict: 'allowed'}};
}

async function newJob(
	key: string,
	request: ScheduleRequest,
	deps: SuperviseDeps,
): Promise<Job> {
	const id = newJobId();
	const now = deps.now();
	switch (request.kind) {
		case 'at': {
			const at = parseWhen(request.at, now);
			if (!at) throw new SuperviseUsageError(`Can't read --at ${request.at}`);
			if (at <= now) {
				throw new SuperviseUsageError(`--at ${request.at} has already passed`);
			}

			return {
				kind: 'at',
				id,
				key,
				at: at.toISOString(),
				message: request.message,
				arm: 0,
			};
		}

		case 'after_limit': {
			const report = await readState(key, deps);
			const lifts = limitLiftsAt(report);
			if (!lifts) {
				throw new SuperviseUsageError(
					`${key} is ${report.state}, with no usage limit reset to wait for`,
				);
			}

			const soonest = now.getTime() + 60_000;
			return {
				kind: 'after_limit',
				id,
				key,
				at: new Date(Math.max(lifts.getTime(), soonest)).toISOString(),
				message: request.message,
				arm: 0,
			};
		}

		case 'keep_going': {
			const running = listJobs(deps.store()).find(
				job => job.kind === 'keep_going' && job.key === key,
			);
			if (running) {
				throw new SuperviseUsageError(
					`${key} already has keep-going job ${running.id}; unschedule it first`,
				);
			}

			const everySeconds = parseDuration(request.every);
			if (!everySeconds) {
				throw new SuperviseUsageError(
					`--every takes a duration such as 10m, not ${request.every}`,
				);
			}

			const until = request.until ? parseWhen(request.until, now) : null;
			if (request.until && !until) {
				throw new SuperviseUsageError(`Can't read --until ${request.until}`);
			}

			return {
				kind: 'keep_going',
				id,
				key,
				everySeconds,
				nudge: request.nudge,
				until: until?.toISOString() ?? null,
				idleChecks: 0,
			};
		}
	}
}

function describeJob(job: Job): string {
	switch (job.kind) {
		case 'at': {
			return `${job.id}  ${job.key}  at ${job.at}: ${job.message}`;
		}

		case 'after_limit': {
			return `${job.id}  ${job.key}  after the usage limit, at ${job.at}: ${job.message}`;
		}

		case 'keep_going': {
			return `${job.id}  ${job.key}  every ${job.everySeconds}s${job.until ? ` until ${job.until}` : ''}: ${job.nudge}`;
		}
	}
}

const PANE_FIELDS = [
	'#{session_name}',
	'#{pane_id}',
	'#{@pappardelle_title}',
	'#{pane_current_command}',
	'#{pane_start_command}',
].join('\t');

function tuiPanes(deps: SuperviseDeps): string {
	const result = deps.serverRunner(['list-panes', '-a', '-F', PANE_FIELDS]);
	if (result.error || result.status !== 0) {
		throw new Error(
			`tmux list-panes failed: ${result.stderr?.trim() ?? result.error?.message}`,
		);
	}

	const rows = result.stdout
		.split('\n')
		.filter(line => line.startsWith('pappardelle-'))
		.map(line => line.split('\t'));
	return [['SESSION', 'PANE', 'TITLE', 'RUNNING', 'STARTED AS'], ...rows]
		.map(row => row.join('\t'))
		.join('\n');
}

async function focusLog(seconds: number, deps: SuperviseDeps): Promise<void> {
	const end = deps.now().getTime() + seconds * 1000;
	let previous = '';
	const read = (args: string[]) => {
		const result = deps.serverRunner(args);
		return result.status === 0 ? result.stdout : '';
	};

	while (deps.now().getTime() < end) {
		const active = read([
			'list-panes',
			'-a',
			'-F',
			'#{session_name}:#{pane_id}:#{pane_active}',
		])
			.split('\n')
			.filter(line => line.startsWith('pappardelle-') && line.endsWith(':1'))
			.map(line => line.slice(0, -2))
			.join(' ');
		const clients = read([
			'list-clients',
			'-F',
			'#{client_session}:#{client_flags}',
		])
			.split('\n')
			.filter(Boolean)
			.join(' ');
		const line = `${active} | ${clients}`;
		if (line !== previous) {
			deps.out(`${deps.now().toISOString().slice(11, 23)} ${line}`);
			previous = line;
		}

		await deps.sleep(50);
	}
}

async function execute(
	command: Exclude<SuperviseCommand, {verb: 'help'}>,
	deps: SuperviseDeps,
): Promise<number> {
	const log = (entry: SuperviseEntry, caller = deps.caller) =>
		(deps.log ?? recordSupervision)(deps.repo(), caller, entry, deps.now());
	switch (command.verb) {
		case 'screen': {
			const key = deps.resolveKey(command.key);
			const text = command.companion
				? readCompanionPane(
						key,
						{pane: command.pane, lines: command.lines},
						{runner: deps.runner, repoName: deps.repo()},
					)
				: captureAgentScreen(key, command.lines, {
						repo: deps.repo(),
						runner: deps.runner,
					});
			if (text === null) {
				deps.err(`No agent session for ${key}`);
				return 1;
			}

			const lines = stripVTControlCharacters(text)
				.split('\n')
				.map(line => line.trimEnd());
			const shown = lines.slice(-command.lines).join('\n').trim();
			deps.out(paneText(shown));
			return 0;
		}

		case 'state': {
			const key = deps.resolveKey(command.key);
			const report = await readState(key, deps);
			const tabs = command.tabs
				? await readQuestionTabs(key, report, deps)
				: undefined;
			deps.out(
				command.json
					? JSON.stringify({...report, ...(tabs ? {tabs} : {})}, null, 2)
					: [
							formatState(report),
							...(tabs ?? []).slice(1).map(tab => formatQuestion(tab)),
						].join('\n'),
			);
			return 0;
		}

		case 'wait': {
			const key = deps.resolveKey(command.key);
			const report = await waitFor(command, key, deps);
			deps.out(
				command.json
					? JSON.stringify(report, null, 2)
					: `${report.timedOut ? 'Still ' : ''}${formatState(report)}\n\n${paneText(report.screen)}`,
			);
			return 0;
		}

		case 'watch': {
			const result = await watchSpaces(command, deps);
			for (const change of result.changes) {
				log({
					action: 'watch',
					key: change.key,
					detail: `${change.from ?? 'new'} -> ${change.to}`,
				});
			}

			deps.out(
				command.json
					? JSON.stringify(result)
					: result.result === 'timed_out'
						? `Timed out after ${command.timeoutSeconds}s: no watched space changed\nCursor: ${result.cursor}`
						: [
								...result.changes.map(change => formatChange(change)),
								`Cursor: ${result.cursor}`,
							].join('\n'),
			);
			return 0;
		}

		case 'answer': {
			const key = deps.resolveKey(command.key);
			const before = await readState(key, deps);
			const {question} = before;
			if (
				before.state === 'question' &&
				question &&
				(command.text !== undefined || command.options.length > 0)
			) {
				const plan = planQuestionAnswer(command, question);
				if (typeof plan === 'string') {
					deps.err(`${key}: ${plan}`);
					return 1;
				}

				const entry: SuperviseEntry = {
					action: 'answer',
					key,
					sent: plan.sent,
					detail: question.question,
				};
				const stuck = await runSteps(key, plan.steps, deps);
				if (stuck) {
					log({...entry, detail: `${question.question}; stuck: ${stuck}`});
					deps.err(
						`Answering ${key} stopped: ${stuck} didn't show on screen. Check it with \`pappardelle screen ${key}\``,
					);
					return 1;
				}

				log(entry);
				deps.out(`Answered ${key}: ${plan.sent}`);
				return 0;
			}

			if (command.text !== undefined) {
				deps.err(`--text answers a question; ${key} is ${before.state}`);
				return 1;
			}

			if (command.options.length > 1) {
				deps.err(
					`More than one --option answers a multi-select question; ${key} is ${before.state === 'question' ? 'showing a single-select question' : before.state}`,
				);
				return 1;
			}

			const decision = decideAnswer(command, key, before, deps.policy);
			if (!decision.ok) {
				if (decision.entry) log(decision.entry);
				deps.err(decision.message);
				return decision.exit;
			}

			if (decision.entry.verdict === 'allowed' && decision.entry.command) {
				const verdict = await deps.classify(key, decision.entry.command);
				if (!verdict.allow) {
					log({...decision.entry, verdict: `refused: ${verdict.reason}`});
					deps.err(
						`Not approved (${verdict.reason}); a person decides this one:\n${decision.entry.command}`,
					);
					return POLICY_REFUSED_EXIT;
				}

				decision.entry.verdict = verdict.reason
					? `allowed: ${verdict.reason}`
					: 'allowed';
			}

			if (deps.sendKeys(key, decision.pressed) !== 'sent') {
				deps.err(`Could not press ${decision.pressed.join(' ')} in ${key}`);
				return 1;
			}

			const pressed = decision.entry.sent ?? decision.pressed.join(' ');
			if (!(await answerTaken(key, before, deps))) {
				log({...decision.entry, detail: 'the prompt did not change'});
				deps.err(
					`Pressed ${pressed} in ${key}, but it still shows the same prompt. Check it with \`pappardelle screen ${key}\``,
				);
				return 1;
			}

			log(decision.entry);
			deps.out(
				decision.entry.verdict?.startsWith('allowed: ')
					? `Pressed ${pressed} in ${key} (${decision.entry.verdict})`
					: `Pressed ${pressed} in ${key}`,
			);
			return 0;
		}

		case 'queue': {
			const key = deps.resolveKey(command.key);
			const text = command.text ?? deps.readStdin();
			if (!text)
				throw new SuperviseUsageError(
					'queue needs text, as an argument or on stdin',
				);
			queueMessage(deps.store(), key, text);
			log({action: 'queue', key, sent: text});
			deps.out(`Queued for ${key}'s next scheduled send`);
			return 0;
		}

		case 'schedule': {
			const key = deps.resolveKey(command.key);
			const job = await newJob(key, command.request, deps);
			saveJob(deps.store(), job);
			try {
				deps.timers().create(job, timerWhen(job));
			} catch (error) {
				deleteJob(deps.store(), job.id);
				throw error;
			}

			log({action: 'schedule', key, detail: describeJob(job)});
			deps.out(`Scheduled ${describeJob(job)}`);
			return 0;
		}

		case 'fire': {
			const job = loadJob(deps.store(), command.id);
			if (!job) {
				deps.err(`No scheduled job ${command.id}`);
				return 1;
			}

			const caller = `timer:${job.id}`;
			// Removed only after the log line is written: on macOS, booting out
			// the job that fired ends this process.
			const retired: Job[] = [];
			const result: FireResult = await fireJob(job, {
				store: deps.store(),
				now: deps.now(),
				readState: async key => readState(key, deps),
				async send(key, text) {
					const outcome = await deps.send(key, text);
					log({action: 'send', key, sent: text, detail: outcome}, caller);
					return outcome;
				},
				async dismissModelSwitch(key) {
					const outcome = deps.sendKeys(key, ['Escape']);
					log(
						{
							action: 'answer',
							key,
							sent: 'Escape',
							detail: `kept the current model: ${outcome}`,
						},
						caller,
					);
					await deps.sleep(MODEL_SWITCH_SETTLE_MS);
				},
				createTimer(next) {
					deps.timers().create(next, timerWhen(next));
				},
				removeTimer(done) {
					retired.push(done);
				},
			});
			const next = loadJob(deps.store(), job.id);
			log(
				{
					action: 'fire',
					key: job.key,
					detail:
						next && next.kind !== 'keep_going'
							? `${result}, next at ${next.at}`
							: result,
				},
				caller,
			);
			for (const done of retired) deps.timers().remove(done);
			deps.out(`${job.id}: ${result}`);
			return 0;
		}

		case 'schedules': {
			const key = command.key ? deps.resolveKey(command.key) : undefined;
			const jobs = listJobs(deps.store()).filter(
				job => !key || job.key === key,
			);
			deps.out(
				jobs.length > 0
					? jobs.map(job => describeJob(job)).join('\n')
					: 'No scheduled wake-ups',
			);
			return 0;
		}

		case 'unschedule': {
			const job = loadJob(deps.store(), command.id);
			if (!job) {
				deps.err(`No scheduled job ${command.id}`);
				return 1;
			}

			deps.timers().remove(job);
			deleteJob(deps.store(), job.id);
			log({action: 'unschedule', key: job.key, detail: describeJob(job)});
			deps.out(`Cancelled ${describeJob(job)}`);
			return 0;
		}

		case 'panes': {
			deps.out(tuiPanes(deps));
			return 0;
		}

		case 'focus-log': {
			await focusLog(command.seconds, deps);
			return 0;
		}
	}
}

export async function runSuperviseCommand(
	argv: string[],
	deps: SuperviseDeps,
): Promise<number> {
	try {
		const command = parseSuperviseArgs(argv);
		if (command.verb === 'help') {
			deps.out(command.text);
			return 0;
		}

		return await execute(command, deps);
	} catch (error) {
		deps.err((error as Error).message);
		return error instanceof SuperviseUsageError ? 2 : 1;
	}
}

export function defaultReadStdin(): string | undefined {
	if (process.stdin.isTTY) return undefined;
	return readFileSync(0, 'utf8').replace(/\n$/, '');
}
