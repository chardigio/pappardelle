// What answering a permission prompt or question comes to, before anything
// is pressed: the keys, a model check still to run, a hold for the chef, or
// an error.

import path from 'node:path';
import type {CodexDialog, PermissionPrompt} from './agent-screen.ts';
import type {AgentStateReport} from './agent-state.ts';
import {checkApproval, placeOf, type ApprovalPolicy} from './approve-policy.ts';
import type {ClaudeSessionState} from './claude-status.ts';
import {holdFor, type HeldPrompt, type Hold} from './holds.ts';
import type {SuperviseCommand} from './supervise-args.ts';
import type {ActionEntry} from './supervise-log.ts';

export const POLICY_REFUSED_EXIT = 3;

/** A call the rules can't place, for the model check. */
export type CheckRequest = {
	tool: string;
	description: string;
	command: string;
	cwd: string | null;
};

export type HoldPlan = {reason: string; prompt: HeldPrompt; entry: ActionEntry};

/** What answering a prompt comes to, before anything is pressed. */
export type AnswerDecision =
	| {
			kind: 'press';
			pressed: string[];
			entry: ActionEntry;
			/** Why the policy let this prompt through, when it judged one. */
			allowed?: string;
			/** The approved hold this press uses up. */
			hold?: Hold;
	  }
	| {
			kind: 'check';
			pressed: string[];
			entry: ActionEntry;
			request: CheckRequest;
			prompt: HeldPrompt;
	  }
	| ({kind: 'hold'} & HoldPlan)
	| {kind: 'error'; exit: number; message: string; entry?: ActionEntry};

export type AnswerContext = {
	policy: ApprovalPolicy;
	/** The hook's record of the prompt that is up, when the agent has one. */
	hook: ClaudeSessionState | null;
	holds: Hold[];
};

export function holdPlan(
	prompt: HeldPrompt,
	entry: ActionEntry,
	reason: string,
): HoldPlan {
	return {reason, prompt, entry: {...entry, verdict: `held: ${reason}`}};
}

/** The arrows from the highlighted option to `option`, then Enter. */
function arrowKeys(selected: number, option: number): string[] {
	const steps = option - selected;
	return [
		...Array.from({length: Math.abs(steps)}, () => (steps > 0 ? 'Down' : 'Up')),
		'Enter',
	];
}

/**
 * A digit on a Codex dialog only moves the highlight, except one that picks
 * Quit at once, so the arrows move to the option and Enter takes it.
 */
export function codexDialogKeys(
	dialog: CodexDialog | null,
	option: number,
): string[] | null {
	if (!dialog?.selected || option > dialog.options) return null;
	return arrowKeys(dialog.selected, option);
}

/**
 * The keys that choose `option` on a permission prompt, or null when it
 * can't be chosen exactly: a Codex option with no key of its own.
 */
export function optionKeys(
	permission: PermissionPrompt,
	option: number,
): string[] | null {
	if (permission.choose === 'digit') return [String(option)];
	const shortcut = permission.options.find(
		candidate => candidate.number === option,
	)?.shortcut;
	if (!shortcut) return null;
	return [shortcut === 'esc' ? 'Escape' : shortcut];
}

const FILE_TOOLS = new Set([
	'Edit',
	'MultiEdit',
	'Write',
	'Read',
	'NotebookEdit',
]);
const FILE_HEADER =
	/^(?:Edit|Create|Write|Overwrite|Read) file$|^Edit notebook$/;
// What a file prompt asks when its header is off the screen.
const FILE_QUESTION = /^Do you want to (?:create|make this edit to|overwrite) /;
// Answering prompts is the chef's: a call to these from a space would let
// one agent approve another's, or its own.
const ANSWERS_PROMPTS =
	/\b(?:space_hold_resolve|space_answer|space_press_keys)\b/;

/**
 * The file a file tool's prompt is for: the one pending call whose file name
 * the prompt shows. The hook only knows which calls are pending, not which
 * one asked.
 */
function promptFile(
	permission: PermissionPrompt,
	hook: ClaudeSessionState | null,
): {kind: 'file'; file: string} | {kind: 'hold'; reason: string} {
	const pending = hook?.pendingFiles ?? [];
	if (pending.length === 0)
		return {kind: 'hold', reason: "the file this prompt is for isn't known"};
	// A long path wraps onto the next line of the prompt.
	const shown = [
		permission.description,
		permission.question,
		permission.command,
	].map(text => text.replaceAll(/\n\s*/g, ''));
	const matches = [...new Set(pending)].filter(file => {
		const name = path.posix.basename(file);
		const named = new RegExp(
			`(?:^|[\\s/])${name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?=$|[\\s:,)'"?]|\\.(?:$|\\s))`,
		);
		return shown.some(text => named.test(text));
	});
	if (matches.length === 0)
		return {
			kind: 'hold',
			reason: "the prompt doesn't show any file its agent is working on",
		};
	if (matches.length > 1)
		return {
			kind: 'hold',
			reason: `the prompt could be for ${matches.join(' or ')}`,
		};
	return {kind: 'file', file: matches[0]!};
}

export function decideAnswer(
	command: Extract<SuperviseCommand, {verb: 'answer'}>,
	key: string,
	report: AgentStateReport,
	{policy, hook, holds}: AnswerContext,
): AnswerDecision {
	const chosen = command.options[0];
	if (report.state === 'dialog') {
		// Codex's and agy's modal dialogs take keyboard focus (Escape on Codex
		// trust quits Codex), so a person answers them unless forced.
		const sent = chosen === undefined ? command.keys.join(' ') : String(chosen);
		const dialogKind = report.codexDialog ? 'Codex dialog' : 'agy dialog';
		const dialogTitle = report.codexDialog?.title
			? ` ("${report.codexDialog.title}")`
			: '';
		const entry = {
			action: 'answer' as const,
			key,
			sent,
			detail: report.codexDialog?.title ?? '',
		};
		if (!command.force) {
			return {
				kind: 'error',
				exit: POLICY_REFUSED_EXIT,
				message: `${key} shows a ${dialogKind}${dialogTitle}; a person answers it`,
				entry: {...entry, verdict: `refused: ${dialogKind}`},
			};
		}

		if (chosen === undefined) {
			return {
				kind: 'press',
				pressed: command.keys,
				entry: {...entry, verdict: 'forced'},
			};
		}

		if (!report.codexDialog) {
			return {
				kind: 'error',
				exit: 1,
				message: `${key}'s dialog needs --keys`,
			};
		}

		const pressed = codexDialogKeys(report.codexDialog, chosen);
		if (!pressed) {
			return {
				kind: 'error',
				exit: 1,
				message: `${key}'s Codex dialog has no option ${chosen}; use --keys`,
			};
		}

		return {
			kind: 'press',
			pressed,
			entry: {...entry, sent: pressed.join(' '), verdict: 'forced'},
		};
	}

	if (report.state !== 'permission' && report.state !== 'question') {
		return {
			kind: 'error',
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
				kind: 'error',
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
			kind: 'press',
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
			kind: 'press',
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
				kind: 'press',
				pressed,
				entry: {...base, sent: pressed[0], verdict: 'forced'},
			};
		return {
			kind: 'error',
			exit: POLICY_REFUSED_EXIT,
			message: `Can't read option ${chosen} on ${key}'s prompt; check it with \`pappardelle screen ${key}\``,
		};
	}

	const entry = {...base, sent: `${option.number}. ${option.label}`};
	const keys = optionKeys(permission, chosen);
	if (!keys) {
		return {
			kind: 'error',
			exit: POLICY_REFUSED_EXIT,
			message: `Option ${chosen} on ${key}'s prompt shows no key that picks it; check it with \`pappardelle screen ${key}\``,
		};
	}

	if (option.kind === 'deny' || command.force) {
		return {
			kind: 'press',
			pressed: keys,
			entry: {...entry, ...(command.force ? {verdict: 'forced'} : {})},
		};
	}

	// An option worded neither Yes nor No may approve anything; its label is
	// all there is to go on.
	if (option.kind === 'other') {
		return {
			kind: 'error',
			exit: POLICY_REFUSED_EXIT,
			message: `"${option.label}" isn't a plain yes or no; answer with the plain yes or the no`,
			entry: {...entry, verdict: 'refused: unrecognised option'},
		};
	}

	if (option.kind === 'approve_always') {
		return {
			kind: 'error',
			exit: POLICY_REFUSED_EXIT,
			message: `"${option.label}" approves more than this call; answer with the plain yes`,
			entry: {...entry, verdict: 'refused: approves more than this call'},
		};
	}

	const tool = permission.tool || hook?.currentTool || '';
	// The hook's tool stands in only for a header cut off the screen: it can
	// be a record of a different call queued behind this one.
	const fileTool = permission.tool
		? FILE_HEADER.test(permission.tool)
		: FILE_TOOLS.has(hook?.currentTool ?? '') ||
			FILE_QUESTION.test(permission.question);
	if (fileTool && !hook)
		return {
			kind: 'error',
			exit: 1,
			message:
				"Claude hasn't reported which file this prompt is for yet; answer again in a few seconds",
		};
	const file = fileTool ? promptFile(permission, hook) : null;
	const prompt: HeldPrompt = {
		key,
		tool,
		command: permission.command,
		filePath: file?.kind === 'file' ? file.file : null,
		cwd: hook?.cwd ?? null,
		approvable: !permission.cutOff && !permission.files,
	};
	const held = (reason: string): AnswerDecision => ({
		kind: 'hold',
		...holdPlan(prompt, entry, reason),
	});
	const allowed = (
		reason: string,
	): Extract<AnswerDecision, {kind: 'press'}> => ({
		kind: 'press',
		pressed: keys,
		allowed: reason,
		entry: {...entry, verdict: `allowed: ${reason}`},
	});

	const approved = prompt.approvable
		? holdFor(holds, prompt, 'approved')
		: null;
	if (approved) {
		return {...allowed(`the chef approved ${approved.id}`), hold: approved};
	}

	if (permission.files) {
		if (permission.files.length === 0)
			return held("the files this edit writes can't be read");
		const outside = permission.files
			.map(file => placeOf(file, policy))
			.find(place => place.kind === 'hold');
		return outside?.kind === 'hold'
			? held(outside.reason)
			: allowed('files inside the space');
	}

	if (file) {
		if (file.kind === 'hold') return held(file.reason);
		const reading = permission.tool
			? permission.tool === 'Read file'
			: hook?.currentTool === 'Read';
		const verdict = placeOf(file.file, policy, {reading});
		return verdict.kind === 'hold'
			? held(verdict.reason)
			: allowed('a file inside the space');
	}

	if (permission.cutOff)
		return held(
			"the top of the prompt is off the screen, so the call can't be read",
		);
	// A Bash command naming these is only text; pappardelle answer and holds
	// are hard stops in the rules.
	if (
		tool !== 'Bash command' &&
		ANSWERS_PROMPTS.test(`${tool}\n${permission.command}`)
	)
		return held('it answers prompts for agents, which only the chef does');
	if (tool === 'Bash command') {
		// Codex wraps a long command onto more lines with no mark, so its
		// lines are also read as one.
		const wrapped =
			// A heredoc's end must stay on a line of its own.
			permission.choose === 'shortcut' &&
			permission.command.includes('\n') &&
			!permission.command.includes('<<')
				? checkApproval(permission.command.replaceAll('\n', ' '), policy, {
						startDir: null,
					})
				: null;
		if (wrapped?.kind === 'hold') return held(wrapped.reason);
		const verdict = checkApproval(permission.command, policy, {
			// Claude's shell stays where the agent last cd'd, which only the hook
			// knows.
			startDir: permission.choose === 'shortcut' ? null : (hook?.cwd ?? null),
		});
		if (verdict.kind === 'hold') return held(verdict.reason);
	}

	return {
		kind: 'check',
		pressed: keys,
		entry,
		prompt,
		request: {
			tool,
			description: permission.description,
			command: permission.command,
			cwd: hook?.cwd ?? null,
		},
	};
}
