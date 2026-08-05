// Types for Pappardelle TUI

// Brand colors
export const COLORS = {
	CLAUDE_ORANGE: '#DE7356',
	CODEX_GREEN: '#10A37F',
} as const;

import type {RailStatus, TrackerIssue} from './providers/types.ts';

/**
 * Provider-agnostic issue type. Identical to TrackerIssue.
 * @deprecated Use TrackerIssue from providers/types for new code.
 */
export type LinearIssue = TrackerIssue;

export type {
	PipelineStatus,
	RailStatus,
	TrackerIssue,
} from './providers/types.ts';

/**
 * Which agent CLI drives a space. Every harness Pappardelle can launch has an
 * entry here plus a descriptor in `agents/registry.ts`; nothing else in the
 * codebase is allowed to branch on the agent identity.
 */
export type AgentCli = 'claude' | 'codex';

export const AGENT_CLIS: readonly AgentCli[] = ['claude', 'codex'];

export function isAgentCli(value: unknown): value is AgentCli {
	return (
		typeof value === 'string' &&
		(AGENT_CLIS as readonly string[]).includes(value)
	);
}

/**
 * The complete state vocabulary the UI knows about. Every harness normalizes
 * into exactly these five — no harness-specific states, ever.
 *
 * `working` deliberately consolidates "thinking" and "executing a tool". The
 * pre-STA-1850 `processing`/`running_tool` split existed only because Claude's
 * hooks happened to expose it; both rendered the same animation, so it gated no
 * decision while being the distinction a new harness is least likely to be able
 * to make honestly.
 *
 * The two blocked states stay separate because they are the states that change
 * what the human does next, and every harness we care about signals them
 * distinctly (a permission prompt vs. a question tool).
 *
 * Compaction folds into `working`; an errored session folds into `idle` with an
 * optional `error` decoration. "Unknown" is not a state — a missing status file
 * is the unknown case, and the reader signals it by returning `null`.
 */
export type AgentState =
	| 'idle'
	| 'working'
	| 'needs-approval'
	| 'needs-answer'
	| 'done';

/**
 * Optional, never load-bearing metadata attached to a status write. A harness
 * that can supply none of it still produces a fully functional row — that is
 * the point. Nothing in the UI may gate behavior on these fields beyond
 * cosmetics.
 */
export interface AgentDecoration {
	tool?: string;
	model?: string;
	event?: string;
	error?: string;
}

/** Current schema version of the on-disk status file. */
export const AGENT_STATUS_SCHEMA = 1;

/**
 * On-disk shape of `~/.pappardelle/agent-status/<statusKey>.json`.
 *
 * `agent` is mandatory: it is the field that prevents a stale status file
 * written by one harness from coloring a row that is now driven by another.
 * `schema` exists so a future field addition doesn't break a TUI that is
 * mid-upgrade.
 */
export interface AgentStatusFile {
	schema: number;
	agent: AgentCli;
	state: AgentState;
	statusKey: string;
	lastUpdate: number;
	sessionId?: string;
	cwd?: string;
	decoration?: AgentDecoration;
}

/**
 * SpaceData represents a DOW workspace (Linear issue with worktree)
 */
export interface SpaceData {
	name: string; // Issue key (e.g., STA-123) or branch name for main worktree
	statusKey?: string; // Repo-qualified key for status file lookups (e.g., "pappa-chex-main"); defaults to name
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	linearIssue?: LinearIssue;
	/** Provider-agnostic alias for linearIssue. Prefer this in new code. */
	trackerIssue?: TrackerIssue;
	/** Normalized agent state. Absent means "no status file" (rendered as unknown). */
	agentState?: AgentState;
	/** Optional cosmetic metadata from the last status write. */
	agentDecoration?: AgentDecoration;
	/** Which harness drives this space. Absent ⇒ the config-resolved default. */
	agentCli?: AgentCli;
	worktreePath: string | null;
	isMainWorktree?: boolean; // True for the main (master/main) worktree — cannot be deleted
	isDirty?: boolean; // True if worktree has uncommitted changes (used for main worktree color)
	isPending?: boolean; // True for placeholder rows shown while a new session is starting
	pendingTitle?: string; // Title text for pending rows (e.g., "Opening..." or "Starting new session...")
	railStatus?: RailStatus; // Snapshot of PR pipeline state + unresolved comment count (from VcsHostProvider.getRailStatus)
	profileEmoji?: string; // Optional emoji for the active profile, rendered to the left of the agent status icon
}

/**
 * Pane layout configuration for the main pappardelle window
 */
export interface PaneLayout {
	listPaneId: string;
	claudeViewerPaneId: string; // Viewer pane that attaches to the agent's claude-STA-XXX session
	companionViewerPaneId: string; // Viewer pane that attaches to companion-STA-XXX session
}

/**
 * States that are stable and must never go stale.
 *
 * All four are states a human is expected to sit in: a question can go
 * unanswered for an hour without the row becoming a lie. Only `working` claims
 * the agent is doing something right now, so only `working` can rot.
 */
export const STABLE_STATES = new Set<AgentState>([
	'idle',
	'done',
	'needs-approval',
	'needs-answer',
]);

// The only state that indicates in-flight work, and so the only one that can
// become stale (hook stopped firing, agent crashed, machine slept).
export const ACTIVE_STATES = new Set<AgentState>(['working']);

// How long before an active status becomes stale (10 minutes)
export const ACTIVE_STATUS_TIMEOUT = 10 * 60 * 1000;

/**
 * How each state renders. `working` carries no icon — the caller substitutes
 * the spinner animation, colored per-agent via the registry.
 *
 * `idle` and `done` intentionally share the green dot. They are semantically
 * distinct (nothing to read vs. output waiting) and consumers like sous-chef
 * use that, but splitting them visually would be a behavior change nobody
 * asked for.
 */
export const AGENT_STATE_DISPLAY: Record<
	AgentState,
	{color: string; icon?: string}
> = {
	working: {color: COLORS.CLAUDE_ORANGE},
	idle: {color: 'green', icon: '●'},
	done: {color: 'green', icon: '●'},
	'needs-approval': {color: 'red', icon: '!'},
	'needs-answer': {color: 'blue', icon: '?'},
};

/** Rendering for a space with no readable status file. */
export const UNKNOWN_STATE_DISPLAY = {color: 'gray', icon: '?'} as const;

/** Whether a state should blink the row to demand the human's attention. */
export function stateNeedsAttention(state: AgentState | undefined): boolean {
	return state === 'needs-approval' || state === 'needs-answer';
}
