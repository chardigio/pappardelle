// Pure text formatters for `pappardelle state`, `watch`, `holds`, and `schedules`.

import type {
	AgyDialogKind,
	PermissionPrompt,
	PromptOption,
	QuestionDialog,
} from './agent-screen.ts';
import type {AgentState, AgentStateReport} from './agent-state.ts';
import type {Hold} from './holds.ts';
import type {Job, SendOutcome} from './schedule.ts';

export type QuestionTab = Pick<
	QuestionDialog,
	'question' | 'options' | 'multiSelect' | 'textOption'
>;

export type SpaceChange = {
	key: string;
	/** null for a space the cursor didn't have. */
	from: AgentState | null;
	to: AgentState;
} & Partial<
	Pick<
		AgentStateReport,
		| 'permission'
		| 'question'
		| 'codexDialog'
		| 'agyDialog'
		| 'usageLimit'
		| 'composer'
	>
>;

function formatOptions(options: PromptOption[]): string {
	return options
		.map(
			option =>
				`  ${option.number}. ${option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] '}${option.label}${option.description ? `\n     ${option.description}` : ''}`,
		)
		.join('\n');
}

function permissionTitle(permission: PermissionPrompt): string {
	const {tool, subagent, description} = permission;
	if (permission.cutOff) {
		return permission.source === 'agy'
			? `${tool || 'Command'}${subagent ? ` from ${subagent}` : ''} (lines hidden)`
			: 'Top of the prompt is off the screen; it ends';
	}

	return `${tool}${subagent ? ` from ${subagent}` : ''}${description ? `: ${description}` : ''}`;
}

const AGY_DIALOG_LABELS: Record<AgyDialogKind, string> = {
	trust: 'Trust this folder?',
	artifact_review: 'Artifact review (/artifact)',
	subagent_manage: 'Subagent approval manage view',
	config: 'Settings (/config)',
	model_picker: 'Model picker (/model)',
};

export function agyDialogLabel(dialog: AgyDialogKind): string {
	return AGY_DIALOG_LABELS[dialog];
}

export function formatQuestion(question: QuestionTab): string {
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
	else if (report.agyDialog)
		lines.push(`Dialog: ${agyDialogLabel(report.agyDialog)}`);
	else if (
		report.status?.status === 'blocked' &&
		report.status.message === 'Approve plan'
	)
		lines.push('Pending artifact review (/artifact)');
	// Shown under a limit too, since a draft there stops the wake-up.
	if (report.composer) lines.push(`Composer: ${report.composer}`);
	return lines.join('\n');
}

export function formatChange(change: SpaceChange): string {
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
	if (change.agyDialog)
		lines.push(`  Dialog: ${agyDialogLabel(change.agyDialog)}`);
	if (change.composer) lines.push(`  Composer: ${change.composer}`);
	return lines.join('\n');
}

export function describeHold(hold: Hold): string {
	// A file prompt's command is its diff; the file says what it was for.
	const call = hold.filePath ?? hold.command.split('\n')[0]!;
	return `${hold.id}  ${hold.key}  ${hold.state}  ${hold.tool || 'prompt'}: ${call}\n    ${hold.reason}`;
}

/** What the agent is told when its prompt is held. */
export function holdMessage(id: string, reason: string): string {
	return `Held for the chef (${id}): ${reason}. Don't retry it or work around it. Carry on with work that doesn't depend on it, and say in your summary that it's waiting on the chef.`;
}

/** What the sous-chef must still do to get the hold message to the space. */
export function holdDelivery(
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

export function describeJob(job: Job): string {
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
