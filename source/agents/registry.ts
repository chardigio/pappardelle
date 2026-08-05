// Per-harness descriptors — the only place in the codebase that knows one
// agent CLI from another.
//
// Adding harness #3 should mean writing one descriptor here (plus a hook config
// example) and touching nothing else. Everything downstream — the TUI, the
// status reader, the notifier — consumes the normalized five-state vocabulary
// in types.ts and the fields below, never the agent's identity.

import type {AgentCli, AgentState} from '../types.ts';
import {COLORS} from '../types.ts';

/**
 * How much fidelity a harness's adapter can honestly deliver.
 *
 *  - Tier 1 (hooks): the harness invokes our normalizer on lifecycle events.
 *    Full five-state fidelity.
 *  - Tier 2 (poller): no hooks; state is derived from session files on the
 *    TUI's refresh tick. Can produce working/idle/done but MUST NOT guess the
 *    blocked states — it emits `idle` rather than lying.
 *  - Tier 3 (liveness): `working` when the tmux session has a live foreground
 *    process, `idle` otherwise. The floor for "I just want to launch this".
 */
export type AdapterTier = 1 | 2 | 3;

export interface AgentDescriptor {
	id: AgentCli;
	/** Human-readable name, used in notification copy and error messages. */
	displayName: string;
	/** Spinner color for the `working` animation. */
	spinnerColor: string;
	/**
	 * Tool name that means "the agent is blocking on a question to the human".
	 * This is the single per-agent divergence in the event→state table.
	 */
	questionTool: string;
	/** Adapter fidelity this harness currently achieves. */
	tier: AdapterTier;
	/**
	 * Whether the harness needs its worktree pre-trusted before launch. Claude
	 * Code writes `hasTrustDialogAccepted` into ~/.claude.json; Codex has no
	 * equivalent prompt, so the step is skipped entirely rather than no-op'd.
	 */
	needsPretrust: boolean;
	/**
	 * Whether the harness emits Claude's extra `Notification` hook event. Kept
	 * as a flag rather than branching logic so a third harness that also has one
	 * just sets it.
	 */
	hasNotificationEvent: boolean;
	/** Base executable name. */
	command: string;
	/** Flag that disables the harness's approval prompts entirely. */
	skipPermissionsFlag: string;
	/**
	 * Argv (as a shell string) that resumes the most recent conversation in the
	 * cwd. Appended to the base command; the caller supplies the fallback.
	 */
	resumeArgs: (issueKey: string) => string;
	/** Argv appended when starting a fresh session (no resume). */
	freshArgs: (issueKey: string) => string;
}

/**
 * Shell-quote a value for safe interpolation into a command string.
 * Mirrors the helper in tmux.ts; duplicated here to keep this module free of
 * imports from the tmux layer.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/** Issue keys are almost always shell-safe; quote only when they aren't. */
function safeKey(issueKey: string): string {
	return /^[A-Za-z0-9._-]+$/.test(issueKey) ? issueKey : shellQuote(issueKey);
}

const CLAUDE: AgentDescriptor = {
	id: 'claude',
	displayName: 'Claude',
	spinnerColor: COLORS.CLAUDE_ORANGE,
	questionTool: 'AskUserQuestion',
	tier: 1,
	needsPretrust: true,
	hasNotificationEvent: true,
	command: 'claude',
	skipPermissionsFlag: '--dangerously-skip-permissions',
	// `--name <issueKey>` makes the session findable in /resume and sets the
	// terminal title; it belongs on both the resume and the fresh branch.
	resumeArgs: issueKey => `--name ${safeKey(issueKey)} --continue`,
	freshArgs: issueKey => `--name ${safeKey(issueKey)}`,
};

const CODEX: AgentDescriptor = {
	id: 'codex',
	displayName: 'Codex',
	spinnerColor: COLORS.CODEX_GREEN,
	// Verified against a live rollout transcript: Codex's collaboration-mode
	// instructions name `request_user_input` as the tool it uses to put a
	// multiple-choice question to the human.
	questionTool: 'request_user_input',
	tier: 1,
	// Codex has no workspace-trust prompt, so there is nothing to pre-trust.
	needsPretrust: false,
	hasNotificationEvent: false,
	command: 'codex',
	skipPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
	// Codex has no `--name`; sessions are identified by cwd + rollout file.
	resumeArgs: () => 'resume --last',
	freshArgs: () => '',
};

const REGISTRY: Record<AgentCli, AgentDescriptor> = {
	claude: CLAUDE,
	codex: CODEX,
};

export function getAgentDescriptor(agent: AgentCli): AgentDescriptor {
	return REGISTRY[agent];
}

/** Every registered descriptor, in declaration order. */
export function listAgentDescriptors(): AgentDescriptor[] {
	return Object.values(REGISTRY);
}

/** Spinner color for a space's agent, falling back to Claude's orange. */
export function getAgentSpinnerColor(agent: AgentCli | undefined): string {
	return getAgentDescriptor(agent ?? 'claude').spinnerColor;
}

export interface HookEventContext {
	/** `tool_name` from the hook payload, when the event carries one. */
	toolName?: string;
	/** Claude's `Notification` discriminator. Ignored by other harnesses. */
	notificationType?: string;
}

/**
 * Translate a native hook event into the normalized vocabulary.
 *
 * Returns `null` for events that must not write a status file at all — an
 * unrecognized event, or Claude's `permission_prompt` notification, which
 * duplicates the `PermissionRequest` event that already carries the tool name.
 *
 * Claude and Codex publish the same event names, so this is deliberately one
 * table rather than one per agent. The only agent-specific inputs are the
 * descriptor's `questionTool` and `hasNotificationEvent`.
 */
export function mapHookEventToState(
	agent: AgentCli,
	hookEvent: string,
	context: HookEventContext = {},
): AgentState | null {
	const descriptor = getAgentDescriptor(agent);
	const isQuestion =
		context.toolName !== undefined &&
		context.toolName === descriptor.questionTool;

	switch (hookEvent) {
		case 'UserPromptSubmit':
		case 'PostToolUse':
		case 'PreCompact':
		case 'PostCompact':
		case 'SubagentStart': {
			return 'working';
		}

		case 'PreToolUse': {
			return isQuestion ? 'needs-answer' : 'working';
		}

		case 'PermissionRequest': {
			// A permission prompt raised *for* the question tool is still a
			// question as far as the human is concerned — the row should read
			// "answer me", not "approve me".
			return isQuestion ? 'needs-answer' : 'needs-approval';
		}

		case 'Stop':
		case 'SubagentStop': {
			return 'done';
		}

		case 'SessionStart':
		case 'SessionEnd': {
			return 'idle';
		}

		case 'Notification': {
			if (!descriptor.hasNotificationEvent) return null;
			// permission_prompt is the same blocking moment PermissionRequest
			// already reported, but without a tool name — writing it would
			// discard the better-decorated status we just wrote.
			if (context.notificationType === 'idle_prompt') return 'done';
			return null;
		}

		default: {
			return null;
		}
	}
}

/**
 * Build the shell command that starts an agent in a fresh tmux session,
 * resuming the most recent conversation in the cwd when one exists.
 *
 * The `printf` escape rewinds and clears the harness's "no conversation found"
 * error line so the fallback launch doesn't leave it stranded on screen.
 */
export function buildAgentResumeCommand(
	agent: AgentCli,
	issueKey: string,
	skipPermissions = false,
): string {
	const descriptor = getAgentDescriptor(agent);
	const base = skipPermissions
		? `${descriptor.command} ${descriptor.skipPermissionsFlag}`
		: descriptor.command;

	const join = (args: string): string => (args ? `${base} ${args}` : base);
	const resumeCmd = join(descriptor.resumeArgs(issueKey));
	const freshCmd = join(descriptor.freshArgs(issueKey));

	return `${resumeCmd} || { printf '\\033[A\\033[2K'; false; } || ${freshCmd}`;
}
