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
import type {SpaceIdentityDao} from './space-identity.ts';
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
	type PermissionPrompt,
	type PromptOption,
	type QuestionDialog,
	type UsageLimit,
} from './agent-screen.ts';
import {
	decideAnswer,
	holdPlan,
	optionKeys,
	POLICY_REFUSED_EXIT,
	type CheckRequest,
	type HoldPlan,
} from './answer-decision.ts';
import type {ApprovalPolicy} from './approve-policy.ts';

import type {ClassifierVerdict} from './approve-classifier.ts';
import type {ClaudeSessionState, StoredClaudeStatus} from './claude-status.ts';
import {holdFor, resolveHold, type Hold, type HoldDao} from './holds.ts';
import {readCompanionPane} from './companion.ts';
import {
	fireJob,
	limitLiftsAt,
	newJobId,
	parseDuration,
	parseWhen,
	timerWhen,
	type FireResult,
	type Job,
	type ScheduleDao,
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
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {OuterTmuxRunner} from './tmux.ts';

export type AgyQuotaResult =
	| {kind: 'limited'; limit: UsageLimit}
	| {kind: 'available'}
	| {kind: 'unparsed'}
	| {kind: 'error'}
	| {kind: 'not_agy'};

export type SuperviseDeps = {
	repo: () => string;
	identities: Pick<SpaceIdentityDao, 'list' | 'get'>;
	resolveKey: (raw: string) => string;
	/** The hook file's key for a space: `{repo}-{branch}` for main. */
	hookKey: (key: string) => Promise<string>;
	readHook: AgentStateDeps['readHook'];
	/** The whole record the hook last wrote, with the prompt's file and cwd. */
	readHookState: (hookKey: string) => Promise<StoredClaudeStatus>;
	readSnapshot: AgentStateDeps['readSnapshot'];
	/** On-demand `agy -p /quota` lookup, called only for `state` on a limit notice without reset time, `--after-limit`, or `fire` of an `after_limit` job. */
	readAgyQuota?: (
		key: string,
		report: AgentStateReport,
	) => Promise<AgyQuotaResult>;
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
	/** The model check a call passes after the hard stops. */
	classify: (key: string, request: CheckRequest) => Promise<ClassifierVerdict>;
	/** What is inside a space, read for each answer. */
	policy: (key: string) => ApprovalPolicy;
	store: () => ScheduleDao;
	holds: () => HoldDao;
	newHoldId: () => string;
	timers: () => TimerBackend;
	caller: string;
	readStdin: () => string | undefined;
	out: (text: string) => void;
	err: (text: string) => void;
	log?: typeof recordSupervision;
};

const SCREEN_POLL_MS = 2000;
// A timer set for a moment already gone wouldn't fire.
const SOONEST_WAKE_MS = 60_000;
const TAB_SETTLE_MS = 300;

function withoutUsageLimit(
	report: AgentStateReport,
	now: Date,
): AgentStateReport {
	const working =
		report.status?.status === 'working' ||
		parseAgentScreen(report.screen, now).spinner;
	const state =
		report.state !== 'usage_limit'
			? report.state
			: working
				? 'working'
				: report.composer
					? 'draft'
					: 'idle';
	return {...report, usageLimit: null, state};
}

async function readState(
	key: string,
	deps: SuperviseDeps,
	{quota = 'on_notice'}: {quota?: 'on_notice' | 'always' | 'never'} = {},
): Promise<AgentStateReport> {
	const stateDeps: AgentStateDeps = {
		identities: deps.identities,
		runner: deps.runner,
		now: deps.now,
		sleep: deps.sleep,
		hookKey: await deps.hookKey(key),
		readHook: deps.readHook,
		readSnapshot: deps.readSnapshot,
	};
	const report = await readAgentState(key, stateDeps);
	if (
		quota === 'never' ||
		!deps.readAgyQuota ||
		report.state === 'no_session'
	) {
		return report;
	}

	const shouldLookup =
		quota === 'always'
			? !limitLiftsAt(report)
			: Boolean(report.usageLimit && !report.usageLimit.resetAt);
	if (!shouldLookup) return report;

	const result = await deps.readAgyQuota(key, report);
	if (result.kind === 'limited') return {...report, usageLimit: result.limit};
	if (result.kind === 'available' && report.usageLimit) {
		return withoutUsageLimit(report, deps.now());
	}

	return report;
}

function formatOptions(options: PromptOption[]): string {
	return options
		.map(
			option =>
				`  ${option.number}. ${option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] '}${option.label}${option.description ? `\n     ${option.description}` : ''}`,
		)
		.join('\n');
}

function permissionTitle(permission: PermissionPrompt): string {
	if (permission.cutOff) return 'Top of the prompt is off the screen; it ends';
	const {tool, subagent, description} = permission;
	return `${tool}${subagent ? ` from ${subagent}` : ''}${description ? `: ${description}` : ''}`;
}

export function formatState(report: AgentStateReport): string {
	const lines = [
		`${report.key}: ${report.state}${report.app ? ` (${report.app})` : ''}`,
	];
	if (report.permission) {
		lines.push(
			permissionTitle(report.permission),
			report.permission.command,
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
	// Typed answers are only taken on a single-select question, but text left
	// in the row blocks any answer, so it shows either way.
	if (row && (!question.multiSelect || row.text))
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

	const current = async () => {
		const capture = await captureAgentScreen(key, 60, {
			identities: deps.identities,
			runner: deps.runner,
			sleep: deps.sleep,
		});
		return capture ? parseAgentScreen(capture, deps.now()).question : null;
	};

	for (let index = 1; index < first.tabs.length; index++) {
		press('Right');
		await deps.sleep(TAB_SETTLE_MS);
		const tab = await current();
		if (tab) tabs.push(asTab(tab));
	}

	for (let index = 1; index < first.tabs.length; index++) press('Left');
	await deps.sleep(TAB_SETTLE_MS);
	const back = await current();
	if (back?.question !== first.question) {
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
	const first = await readState(key, deps, {quota: 'never'});
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
		report = await readState(key, deps, {quota: 'never'});
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

/**
 * Why the caller may not answer prompts or resolve holds: only the chef and
 * the sous-chef in the main checkout do, or one space could approve its way
 * past another's hold.
 */
function refusedCaller(deps: SuperviseDeps): string | null {
	const own = ownSpace(deps);
	return own && own !== MAIN_WORKTREE_KEY
		? `${own} is a space; only the chef or the sous-chef answers prompts and resolves holds`
		: null;
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
			...listAgentKeys(deps.identities, deps.runner),
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
		Promise.all(
			keys().map(async key => readState(key, deps, {quota: 'never'})),
		);
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
			`  ${permissionTitle(change.permission)}: ${change.permission.command}`,
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

// How long an agent gets to redraw after an answer before it counts as not taken.
const ANSWER_SETTLE_MS = 3000;
const ANSWER_POLL_MS = 250;

/** What the person sees on a prompt: answering it changes this. */
function promptShown(report: AgentStateReport): string {
	return JSON.stringify([
		report.state,
		report.permission?.tool,
		report.permission?.description,
		report.permission?.question,
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

/**
 * Whether the agent took a press. Claude can take a digit typed right after
 * its prompt appears as a move of its selection only, most often with a
 * draft in the input box; then the option is selected and Enter takes it.
 */
async function answerSettled(
	key: string,
	before: AgentStateReport,
	option: number | undefined,
	deps: SuperviseDeps,
): Promise<boolean> {
	if (await answerTaken(key, before, deps)) return true;
	const {permission} = before;
	if (option === undefined || permission?.choose !== 'digit') return false;
	const now = await readState(key, deps);
	const selected = now.permission?.options.find(
		candidate => candidate.selected,
	);
	// The same diff to another file reads the same command; only the very
	// prompt that was judged may be approved.
	const call = (prompt: typeof permission | null | undefined) =>
		JSON.stringify([
			prompt?.tool,
			prompt?.description,
			prompt?.question,
			prompt?.command,
		]);
	if (call(now.permission) !== call(permission) || selected?.number !== option)
		return false;
	if (deps.sendKeys(key, ['Enter']) !== 'sent') return false;
	return answerTaken(key, before, deps);
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
		return `its free-text row already holds "${row.text}"; a person clears it, or with the row open (cursor on it) --keys C-e --keys C-u deletes it`;
	const leaveRow: AnswerStep[] = row?.open
		? [
				{
					keys: [row.closeKey ?? 'Up'],
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
		if (shows(await readState(key, deps, {quota: 'never'}))) return true;
	}

	return false;
}

// Claude reports a permission prompt several seconds after drawing it.
const HOOK_REPORT_MS = 10_000;

/**
 * The hook's record of the prompt that is up, or null when Claude hasn't
 * reported it. Only a Claude prompt being approved is waited for: Codex has
 * no hook, and a No or a forced press doesn't read it.
 */
async function promptHook(
	key: string,
	report: AgentStateReport,
	command: Extract<SuperviseCommand, {verb: 'answer'}>,
	deps: SuperviseDeps,
): Promise<ClaudeSessionState | null> {
	const approving =
		report.permission?.choose === 'digit' &&
		!command.force &&
		command.keys.length === 0 &&
		report.permission.options.find(
			option => option.number === command.options[0],
		)?.kind === 'approve_once';
	for (let waited = 0; ; waited += ANSWER_POLL_MS) {
		// eslint-disable-next-line no-await-in-loop
		const stored = await deps.readHookState(await deps.hookKey(key));
		if (
			stored.kind === 'state' &&
			stored.state.status === 'waiting_for_approval' &&
			stored.state.event === 'Notification'
		)
			return stored.state;
		if (!approving || waited >= HOOK_REPORT_MS) return null;
		// eslint-disable-next-line no-await-in-loop
		await deps.sleep(ANSWER_POLL_MS);
	}
}

function describeHold(hold: Hold): string {
	// A file prompt's command is its diff; the file says what it was for.
	const call = hold.filePath ?? hold.command.split('\n')[0]!;
	return `${hold.id}  ${hold.key}  ${hold.state}  ${hold.tool || 'prompt'}: ${call}\n    ${hold.reason}`;
}

/** What the agent is told when its prompt is held. */
export function holdMessage(id: string, reason: string): string {
	return `Held for the chef (${id}): ${reason}. Don't retry it or work around it. Carry on with work that doesn't depend on it, and say in your summary that it's waiting on the chef.`;
}

/**
 * Declines a prompt for the chef: presses its No (or Escape), tells the
 * agent to carry on, and records the hold. A retry of a prompt already held
 * reuses its open hold.
 */
async function holdPrompt(
	key: string,
	before: AgentStateReport,
	plan: HoldPlan,
	deps: SuperviseDeps,
	log: (entry: SuperviseEntry) => void,
): Promise<number> {
	const {reason, prompt, entry} = plan;
	if (promptShown(await readState(key, deps)) !== promptShown(before)) {
		log({...entry, detail: 'the prompt changed before it could be held'});
		deps.err(
			`${key}'s prompt changed before it could be held; nothing was pressed`,
		);
		return 1;
	}

	const {permission} = before;
	const deny = permission?.options.find(option => option.kind === 'deny');
	const keys = (permission && deny && optionKeys(permission, deny.number)) ?? [
		'Escape',
	];
	if (deps.sendKeys(key, keys) !== 'sent') {
		deps.err(`Could not press ${keys.join(' ')} in ${key}`);
		return 1;
	}

	if (!(await answerSettled(key, before, deny?.number, deps))) {
		log({...entry, sent: keys.join(' '), detail: 'the prompt did not change'});
		deps.err(
			`Pressed ${keys.join(' ')} in ${key} to hold its prompt, but it still shows. Check it with \`pappardelle screen ${key}\``,
		);
		return 1;
	}

	const store = deps.holds();
	const hold: Hold = holdFor(store.list(), prompt, 'open') ?? {
		...prompt,
		id: deps.newHoldId(),
		reason,
		state: 'open',
		createdAt: deps.now().toISOString(),
		resolvedAt: null,
	};
	const message = holdMessage(hold.id, reason);
	// A draft in the input box can be the user's typing, so it is left for
	// the sous-chef to send the message over once the space is free.
	const sent = await deps.send(key, message);
	await store.save(hold);
	log({
		action: 'hold',
		key,
		hold: hold.id,
		command: prompt.command,
		reason,
		sent: message,
		detail: sent,
	});
	deps.out(
		[
			`Held ${hold.id}: ${reason}`,
			prompt.command,
			...holdDelivery(key, sent, message),
		].join('\n'),
	);
	return 0;
}

/** What the sous-chef must still do to get the hold message to the space. */
function holdDelivery(
	key: string,
	sent: SendOutcome,
	message: string,
): string[] {
	if (sent === 'sent') return [];
	// Resent, the text in the box would read as a draft and block the send.
	if (sent === 'unsubmitted')
		return [
			`The message is in ${key}'s input box but didn't send. Check it with space_screen; space_press_keys with Enter submits it:`,
			message,
		];
	return [
		`The message didn't reach ${key} (${sent}). Send it with space_send once the space is free:`,
		message,
	];
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
			const report = await readState(key, deps, {quota: 'always'});
			const lifts = limitLiftsAt(report);
			if (!lifts) {
				throw new SuperviseUsageError(
					`${key} is ${report.state}, with no usage limit reset to wait for`,
				);
			}

			const soonest = now.getTime() + SOONEST_WAKE_MS;
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
			const running = deps
				.store()
				.list()
				.find(job => job.kind === 'keep_going' && job.key === key);
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
						{runner: deps.runner},
					)
				: await captureAgentScreen(key, command.lines, {
						identities: deps.identities,
						runner: deps.runner,
						sleep: deps.sleep,
					});
			if (text === null) {
				deps.err(`No agent session for ${key}`);
				return 1;
			}

			const lines = (
				command.companion
					? stripVTControlCharacters(text).split('\n')
					: parseAgentScreen(text, deps.now()).lines
			).map(line => line.trimEnd());
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
			const refused = refusedCaller(deps);
			if (refused) {
				deps.err(refused);
				return POLICY_REFUSED_EXIT;
			}

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

			const holds = deps.holds();
			const decision = decideAnswer(command, key, before, {
				policy: deps.policy(key),
				hook: await promptHook(key, before, command, deps),
				holds: holds.list(),
			});
			if (decision.kind === 'error') {
				if (decision.entry) log(decision.entry);
				deps.err(decision.message);
				return decision.exit;
			}

			if (decision.kind === 'hold')
				return holdPrompt(key, before, decision, deps, log);

			const {entry, pressed} = decision;
			let allowed = decision.kind === 'press' ? decision.allowed : undefined;
			if (decision.kind === 'check') {
				const verdict = await deps.classify(key, decision.request);
				if (verdict.kind === 'unavailable') {
					log({...entry, verdict: `unavailable: ${verdict.reason}`});
					deps.err(
						`${verdict.reason}; nothing was pressed in ${key}. Try again shortly`,
					);
					return 1;
				}

				if (verdict.kind === 'hold') {
					return holdPrompt(
						key,
						before,
						holdPlan(decision.prompt, entry, verdict.reason),
						deps,
						log,
					);
				}

				// The check takes seconds, and the key must answer the prompt it
				// judged, not one that replaced it meanwhile.
				if (promptShown(await readState(key, deps)) !== promptShown(before)) {
					log({...entry, detail: 'the prompt changed during the check'});
					deps.err(
						`${key}'s prompt changed while its command was being checked; nothing was pressed`,
					);
					return 1;
				}

				allowed = verdict.reason ?? '';
				entry.verdict = allowed ? `allowed: ${allowed}` : 'allowed';
			} else if (
				// The wait for Claude's prompt record can outlast the prompt it was for.
				promptShown(await readState(key, deps)) !== promptShown(before)
			) {
				deps.err(
					`${key}'s prompt changed before it was answered; nothing was pressed`,
				);
				return 1;
			}

			if (deps.sendKeys(key, pressed) !== 'sent') {
				deps.err(`Could not press ${pressed.join(' ')} in ${key}`);
				return 1;
			}

			const shown = entry.sent ?? pressed.join(' ');
			if (
				!(await answerSettled(
					key,
					before,
					before.state === 'permission' ? command.options[0] : undefined,
					deps,
				))
			) {
				log({...entry, detail: 'the prompt did not change'});
				deps.err(
					`Pressed ${shown} in ${key}, but it still shows the same prompt. Check it with \`pappardelle screen ${key}\``,
				);
				return 1;
			}

			log(entry);
			const used = decision.kind === 'press' ? decision.hold : undefined;
			if (used) {
				// Only once the press is taken, so a failed one keeps the approval.
				await holds.save(resolveHold(used, 'used', deps.now()));
				log({action: 'hold_use', key, hold: used.id, command: used.command});
			}

			deps.out(
				allowed === undefined
					? `Pressed ${shown} in ${key}`
					: `Pressed ${shown} in ${key} (${entry.verdict})`,
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
			await deps.store().queue(key, text);
			log({action: 'queue', key, sent: text});
			deps.out(`Queued for ${key}'s next scheduled send`);
			return 0;
		}

		case 'schedule': {
			const key = deps.resolveKey(command.key);
			const job = await newJob(key, command.request, deps);
			await deps.store().save(job);
			try {
				deps.timers().create(job, timerWhen(job));
			} catch (error) {
				await deps.store().delete(job.id);
				throw error;
			}

			log({action: 'schedule', key, detail: describeJob(job)});
			deps.out(`Scheduled ${describeJob(job)}`);
			return 0;
		}

		case 'fire': {
			const job = deps.store().load(command.id);
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
				readState: async key =>
					readState(key, deps, {
						quota: job.kind === 'after_limit' ? 'always' : 'on_notice',
					}),
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
			const next = deps.store().load(job.id);
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
			const jobs = deps
				.store()
				.list()
				.filter(job => !key || job.key === key);
			deps.out(
				jobs.length > 0
					? jobs.map(job => describeJob(job)).join('\n')
					: 'No scheduled wake-ups',
			);
			return 0;
		}

		case 'unschedule': {
			const job = deps.store().load(command.id);
			if (!job) {
				deps.err(`No scheduled job ${command.id}`);
				return 1;
			}

			deps.timers().remove(job);
			await deps.store().delete(job.id);
			log({action: 'unschedule', key: job.key, detail: describeJob(job)});
			deps.out(`Cancelled ${describeJob(job)}`);
			return 0;
		}

		case 'holds': {
			const key = command.key ? deps.resolveKey(command.key) : undefined;
			const holds = deps
				.holds()
				.list()
				.filter(
					hold =>
						(!key || hold.key === key) &&
						(command.all || hold.state === 'open'),
				);
			deps.out(
				command.json
					? JSON.stringify(holds, null, 2)
					: holds.length > 0
						? holds.map(hold => describeHold(hold)).join('\n')
						: command.all
							? 'No holds'
							: 'No open holds',
			);
			return 0;
		}

		case 'hold-resolve': {
			const refused = refusedCaller(deps);
			if (refused) {
				deps.err(refused);
				return POLICY_REFUSED_EXIT;
			}

			const store = deps.holds();
			const hold = store.load(command.id);
			if (!hold) {
				deps.err(`No hold ${command.id}`);
				return 1;
			}

			if (hold.state !== 'open') {
				deps.err(`Hold ${hold.id} is already ${hold.state}`);
				return 1;
			}

			if (command.resolution === 'approve' && ownSpace(deps) === hold.key) {
				deps.err(
					`${hold.key} can't approve its own hold; the chef decides ${hold.id}`,
				);
				return POLICY_REFUSED_EXIT;
			}

			if (command.resolution === 'approve' && !hold.approvable) {
				deps.err(
					`${hold.id} is a Codex edit or a prompt cut off the screen, which an approval can't match; answer it in ${hold.key} or dismiss it`,
				);
				return POLICY_REFUSED_EXIT;
			}

			const state = command.resolution === 'approve' ? 'approved' : 'dismissed';
			await store.save(resolveHold(hold, state, deps.now()));
			log({
				action:
					command.resolution === 'approve' ? 'hold_approve' : 'hold_dismiss',
				key: hold.key,
				hold: hold.id,
				command: hold.command,
			});
			deps.out(
				command.resolution === 'approve'
					? `Approved ${hold.id}: ${hold.key}'s retry of that prompt goes through once. Tell the agent to retry it`
					: `Dismissed ${hold.id}`,
			);
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
