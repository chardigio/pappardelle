import stringWidth from 'string-width';
import {resolveEmojiSlot} from '../../source/emoji-rail-width.ts';
import {maybeStripSkinTones} from '../../source/tmux-skin-tone.ts';
import {truncateToWidth} from '../../source/truncate-to-width.ts';
import type {PipelineStatus} from '../../source/providers/types.ts';
import type {FleetSpace} from '../fixtures.ts';

/** Agent state as a direction draws it: one case per visual treatment. */
export type AgentState =
	| 'working'
	| 'tool'
	| 'compacting'
	| 'idle'
	| 'done'
	| 'question'
	| 'permission'
	| 'error'
	| 'unknown'
	| 'pending';

export type RowModel = {
	space: FleetSpace;
	key: string;
	title: string;
	state: AgentState;
	needsYou: boolean;
	/** Tracker workflow state name and color (hex from Linear/Jira). */
	workflow?: {name: string; color: string};
	pipeline: PipelineStatus | undefined;
	comments: number;
	conflict: boolean;
	emoji: string | undefined;
	emojiCells: number;
	/** What the agent last said about itself: OSC message, else hook tool. */
	detail?: string;
	progress?: number;
	app?: string;
	stateSince?: number;
};

function agentState(space: FleetSpace): AgentState {
	if (space.isPending) return 'pending';
	const status = space.programStatus;
	switch (status?.status) {
		case 'working': {
			if (status.activity === 'compacting') return 'compacting';
			return status.activity === 'tool' ? 'tool' : 'working';
		}

		case 'blocked': {
			return status.kind === 'question' ? 'question' : 'permission';
		}

		case 'idle':
		case 'done':
		case 'error': {
			return status.status;
		}

		case 'unknown':
		case undefined: {
			return 'unknown';
		}
	}
}

/** `1 needs you`, `2 need you`. */
export function needYou(count: number) {
	return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}

/** The row a tmux mockup focuses: `preferred` if it's there, else the first
 * agent waiting on you, else the first agent. */
export function focusRow(rows: RowModel[], preferred: string): RowModel {
	return (
		rows.find(row => row.space.name === preferred) ??
		rows.find(row => row.needsYou) ??
		rows.find(row => !row.space.isMainWorktree) ??
		rows[0]!
	);
}

/** A hook-reported tool, phrased for whether the agent is waiting on you. */
function toolDetail(state: AgentState, tool: string | undefined) {
	if (!tool) return undefined;
	return state === 'permission' ? `Wants to run ${tool}` : `Running ${tool}`;
}

export function describeSpace(space: FleetSpace): RowModel {
	const state = agentState(space);
	const issue = space.linearIssue ?? space.trackerIssue;
	const status = space.programStatus;
	const slot = resolveEmojiSlot(maybeStripSkinTones(space.profileEmoji));
	const pipeline = space.railStatus?.pipeline ?? undefined;
	const tool =
		status?.tool && status.tool !== 'AskUserQuestion' ? status.tool : undefined;
	return {
		space,
		key: space.isMainWorktree ? 'main' : space.name,
		title: space.pendingTitle ?? issue?.title ?? '',
		state,
		needsYou: state === 'question' || state === 'permission',
		workflow: issue
			? {name: issue.state.name, color: issue.state.color}
			: undefined,
		pipeline,
		comments: pipeline ? (space.railStatus?.unresolvedCommentCount ?? 0) : 0,
		conflict: pipeline ? (space.railStatus?.hasConflict ?? false) : false,
		emoji: slot?.text,
		emojiCells: slot ? stringWidth(slot.text) : 0,
		detail: status?.message ?? toolDetail(state, tool),
		progress: status?.progress,
		app: status?.app,
		stateSince: space.extras?.stateSince,
	};
}

/** Pads or clips text to exactly `cells` terminal cells. */
export function fit(text: string, cells: number): string {
	const clipped = truncateToWidth(text, cells);
	return clipped + ' '.repeat(Math.max(0, cells - stringWidth(clipped)));
}

export const cellsOf = (text: string) => stringWidth(text);

/** Compact age: 45s, 6m, 2h. */
export function age(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}
