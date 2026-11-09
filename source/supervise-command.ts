// The verbs an agent uses to watch and answer agents in other spaces:
// `screen`, `state`, `wait`, `answer`, `queue`, the schedule verbs and the
// `tui` diagnostics. See supervise-args.ts for their flags.

import {readFileSync} from 'node:fs';
import {stripVTControlCharacters} from 'node:util';
import {
	captureAgentScreen,
	readAgentState,
	WAIT_TARGETS,
	type AgentStateDeps,
	type AgentStateReport,
} from './agent-state.ts';
import {parseAgentScreen, type PromptOption} from './agent-screen.ts';
import {checkApproval, type ApprovalPolicy} from './approve-policy.ts';
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
		.map(option => `  ${option.number}. ${option.label}`)
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

	if (report.question) {
		lines.push(
			report.question.question,
			formatOptions(report.question.options),
		);
	}

	if (report.usageLimit) {
		lines.push(
			`Usage limit resets ${report.usageLimit.resetText || 'at an unknown time'}${report.usageLimit.passed ? ' (passed)' : ''}`,
		);
	}

	if (report.state === 'draft') lines.push(`Composer: ${report.composer}`);
	return lines.join('\n');
}

type QuestionTab = {question: string; options: PromptOption[]};

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
	const tabs: QuestionTab[] = [
		{question: first.question, options: first.options},
	];
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
		if (tab) tabs.push({question: tab.question, options: tab.options});
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
	if (command.until !== 'changed' && matches(first)) {
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

type AnswerResult =
	| {ok: true; pressed: string[]; entry: SuperviseEntry}
	| {ok: false; exit: number; message: string; entry?: SuperviseEntry};

function decideAnswer(
	command: Extract<SuperviseCommand, {verb: 'answer'}>,
	key: string,
	report: AgentStateReport,
	policy: ApprovalPolicy,
): AnswerResult {
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
	if (command.option === undefined) {
		const onlyEscape = command.keys.every(name => name === 'Escape');
		if (report.state === 'permission' && !onlyEscape && !command.force) {
			return {
				ok: false,
				exit: POLICY_REFUSED_EXIT,
				message: `Keys other than Escape on ${key}'s permission prompt need --force; answer it with --option`,
			};
		}

		return {
			ok: true,
			pressed: command.keys,
			entry: {...base, sent: command.keys.join(' ')},
		};
	}

	const pressed = [String(command.option)];
	if (report.state === 'question') {
		return {ok: true, pressed, entry: {...base, sent: pressed[0]}};
	}

	const option = permission?.options.find(
		candidate => candidate.number === command.option,
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
			message: `Can't read option ${command.option} on ${key}'s prompt; check it with \`pappardelle screen ${key}\``,
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
			return {
				kind: 'at',
				id,
				key,
				at: at.toISOString(),
				message: request.message,
			};
		}

		case 'after_limit': {
			const report = await readState(key, deps);
			const lifts =
				report.state === 'usage_limit' ? limitLiftsAt(report) : null;
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
			};
		}

		case 'keep_going': {
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

	return result.stdout
		.split('\n')
		.filter(line => line.startsWith('pappardelle-'))
		.map(line => line.split('\t').join('  '))
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

			const lines = stripVTControlCharacters(text).split('\n');
			deps.out(lines.slice(-command.lines).join('\n').trimEnd());
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
							...(tabs ?? [])
								.slice(1)
								.map(tab => `${tab.question}\n${formatOptions(tab.options)}`),
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
					: `${report.timedOut ? 'Still ' : ''}${formatState(report)}\n\n${report.screen}`,
			);
			return 0;
		}

		case 'answer': {
			const key = deps.resolveKey(command.key);
			const decision = decideAnswer(
				command,
				key,
				await readState(key, deps),
				deps.policy,
			);
			if (!decision.ok) {
				if (decision.entry) log(decision.entry);
				deps.err(decision.message);
				return decision.exit;
			}

			if (deps.sendKeys(key, decision.pressed) !== 'sent') {
				deps.err(`Could not press ${decision.pressed.join(' ')} in ${key}`);
				return 1;
			}

			log(decision.entry);
			deps.out(
				`Pressed ${decision.entry.sent ?? decision.pressed.join(' ')} in ${key}`,
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
			const result: FireResult = await fireJob(job, {
				store: deps.store(),
				now: deps.now(),
				readState: async key => readState(key, deps),
				async send(key, text) {
					const outcome = await deps.send(key, text);
					log({action: 'send', key, sent: text, detail: outcome}, caller);
					return outcome;
				},
				createTimer(next) {
					deps.timers().create(next, timerWhen(next));
				},
				removeTimer(done) {
					deps.timers().remove(done);
				},
			});
			log({action: 'fire', key: job.key, detail: result}, caller);
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
