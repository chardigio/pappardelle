import {AUTO_REMOVE_STATE_TYPES} from './auto-remove.ts';
import {IN_REVIEW_COLOR, normalizeStateName} from './state-color-override.ts';
import type {SpaceData} from './types.ts';

/**
 * Tracker-neutral buckets for a workflow state, so a rail group can claim
 * every "done" status without listing each tracker's spelling of it.
 */
export const STATUS_CATEGORIES = ['todo', 'in_progress', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** One entry of `list_view.groups` in `.pappardelle.yml`. */
export interface RailGroupConfig {
	name: string;
	color: string;
	statuses?: string[];
	categories?: StatusCategory[];
}

export interface RailGroup {
	id: string;
	name: string;
	color: string;
	/** Normalized with `normalizeStateName`. */
	statuses: string[];
	categories: StatusCategory[];
}

export type RailAttention = 'approval' | 'question';

export type RailRow =
	| {kind: 'header'; group: RailGroup; count: number}
	| {kind: 'space'; space: SpaceData}
	| {kind: 'pending'; space: SpaceData}
	| {kind: 'divider'};

export const DEFAULT_RAIL_GROUPS: readonly RailGroupConfig[] = [
	{name: 'In Progress', color: '#4b9fea', categories: ['todo', 'in_progress']},
	{name: 'In Review', color: IN_REVIEW_COLOR, statuses: ['In Review']},
	{name: 'Done', color: '#4caf50', categories: ['done']},
];

const TODO_STATE_TYPES: ReadonlySet<string> = new Set([
	'unstarted',
	'backlog',
	'triage',
	'open',
]);

export function railGroupId(name: string): string {
	return normalizeStateName(name);
}

export function railGroupsFromConfig(
	configs: readonly RailGroupConfig[] = DEFAULT_RAIL_GROUPS,
): RailGroup[] {
	return configs.map(config => ({
		id: railGroupId(config.name),
		name: config.name,
		color: config.color,
		statuses: (config.statuses ?? []).map(status => normalizeStateName(status)),
		categories: config.categories ?? [],
	}));
}

/**
 * A space with no issue behind it. Today that is only the main worktree, where
 * the sous-chef runs. Agent spaces lead the rail above a divider, outside any
 * status group, and never take a title line.
 */
export function isAgentSpace(space: SpaceData): boolean {
	return space.isMainWorktree === true;
}

export function statusCategoryOf(stateType: string): StatusCategory {
	if (AUTO_REMOVE_STATE_TYPES.has(stateType)) return 'done';
	if (TODO_STATE_TYPES.has(stateType)) return 'todo';
	return 'in_progress';
}

/**
 * Which group a workspace belongs in; null for an agent space. An exact status
 * name beats a category, so a repo can pull one in-progress status (such as
 * "In Review" or "QA") out of the group that takes the rest of its category.
 */
export function railGroupOf(
	space: SpaceData,
	groups: readonly RailGroup[],
): RailGroup | null {
	if (isAgentSpace(space)) return null;
	const first = groups[0] ?? null;
	const state = (space.trackerIssue ?? space.linearIssue)?.state;
	if (!state) return first;

	const name = normalizeStateName(state.name);
	const byStatus = groups.find(group => group.statuses.includes(name));
	if (byStatus) return byStatus;

	const category = statusCategoryOf(state.type);
	return groups.find(group => group.categories.includes(category)) ?? first;
}

/** What a blocked agent is waiting on, or null when it isn't blocked. */
export function spaceAttention(space: SpaceData): RailAttention | null {
	if (space.programStatus?.status !== 'blocked') return null;
	return space.programStatus.kind === 'question' ? 'question' : 'approval';
}

function agentRowsWithDivider(
	agents: readonly SpaceData[],
	hasWorkspaces: boolean,
): RailRow[] {
	const rows: RailRow[] = agents.map(space => ({kind: 'space', space}));
	if (agents.length > 0 && hasWorkspaces) rows.push({kind: 'divider'});
	return rows;
}

function spaceRows(spaces: readonly SpaceData[]): RailRow[] {
	return spaces.map(space =>
		space.isPending ? {kind: 'pending', space} : {kind: 'space', space},
	);
}

/** The ungrouped rail: the display list, with the divider under agent spaces. */
export function flatRailRows(displaySpaces: readonly SpaceData[]): RailRow[] {
	const agents = displaySpaces.filter(space => isAgentSpace(space));
	const workspaces = displaySpaces.filter(space => !isAgentSpace(space));
	return [
		...agentRowsWithDivider(agents, workspaces.length > 0),
		...spaceRows(workspaces),
	];
}

/** Search results: the matches as they are, with no headers or divider. */
export function searchRailRows(matches: readonly SpaceData[]): RailRow[] {
	return spaceRows(matches);
}

/**
 * The grouped rail. Spaces keep their incoming order inside each group, so the
 * newest-first order holds whatever their status history. A starting session
 * has no status yet; it shows at the top of the first group. The narrow layout
 * has too few rows to spare for headers, so it keeps the group order without
 * them.
 */
export function buildRailRows(options: {
	displaySpaces: readonly SpaceData[];
	groups: readonly RailGroup[];
	headers?: boolean;
}): RailRow[] {
	const {displaySpaces, groups, headers = true} = options;
	const agents: SpaceData[] = [];
	const pending: SpaceData[] = [];
	const members = new Map<string, SpaceData[]>();
	for (const space of displaySpaces) {
		if (space.isPending) {
			pending.push(space);
			continue;
		}

		const group = railGroupOf(space, groups);
		if (!group) {
			agents.push(space);
			continue;
		}

		const bucket = members.get(group.id) ?? [];
		bucket.push(space);
		members.set(group.id, bucket);
	}

	const groupRows: RailRow[] = [];
	for (const group of groups) {
		const spaces = members.get(group.id) ?? [];
		const starting = group === groups[0] ? pending : [];
		if (spaces.length === 0 && starting.length === 0) continue;

		if (headers) groupRows.push({kind: 'header', group, count: spaces.length});
		for (const space of starting) groupRows.push({kind: 'pending', space});
		for (const space of spaces) groupRows.push({kind: 'space', space});
	}

	return [...agentRowsWithDivider(agents, groupRows.length > 0), ...groupRows];
}

type SpaceRow = Extract<RailRow, {kind: 'space' | 'pending'}>;

export function isSpaceRow(row: RailRow | undefined): row is SpaceRow {
	return row?.kind === 'space' || row?.kind === 'pending';
}

/** Rows j/k and clicks can land on. Headers are labels, not stops. */
export function isSelectableRow(row: RailRow | undefined): boolean {
	return row?.kind === 'space';
}

/** Terminal lines a row takes. Agent spaces have no title line to show. */
export function railRowHeight(row: RailRow, linesPerItem: number): number {
	return isSpaceRow(row) && !isAgentSpace(row.space) ? linesPerItem : 1;
}

/** The next row j (step 1) or k (step -1) lands on, or -1 at either end. */
export function nextSelectableRow(
	rows: readonly RailRow[],
	from: number,
	step: 1 | -1,
): number {
	for (
		let index = from + step;
		index >= 0 && index < rows.length;
		index += step
	) {
		if (isSelectableRow(rows[index])) return index;
	}

	return -1;
}

/**
 * The row the selected space sits on. Before the first refresh places it, the
 * cursor rests on the first row j/k can land on.
 */
export function resolveCursorRow(
	rows: readonly RailRow[],
	space: SpaceData | undefined,
): number {
	const spaceRow = space
		? rows.findIndex(
				row => row.kind === 'space' && row.space.name === space.name,
			)
		: -1;
	if (spaceRow !== -1) return spaceRow;
	return Math.max(0, nextSelectableRow(rows, -1, 1));
}
