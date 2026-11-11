import {AUTO_REMOVE_STATE_TYPES} from './auto-remove.ts';
import {normalizeStateName} from './state-color-override.ts';
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
	| {
			kind: 'header';
			group: RailGroup;
			count: number;
			collapsed: boolean;
			attention: RailAttention | null;
	  }
	| {kind: 'space'; space: SpaceData}
	| {kind: 'pending'; space: SpaceData}
	| {kind: 'divider'};

export const DEFAULT_RAIL_GROUPS: readonly RailGroupConfig[] = [
	{name: 'In Progress', color: '#4b9fea', categories: ['todo', 'in_progress']},
	{name: 'In Review', color: '#a78bfa', statuses: ['In Review']},
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

function attentionOf(spaces: readonly SpaceData[]): RailAttention | null {
	const blocked = spaces.filter(
		space => space.programStatus?.status === 'blocked',
	);
	if (blocked.length === 0) return null;
	return blocked.some(
		space =>
			space.programStatus?.status === 'blocked' &&
			space.programStatus.kind === 'question',
	)
		? 'question'
		: 'approval';
}

function agentRowsWithDivider(
	agents: readonly SpaceData[],
	hasWorkspaces: boolean,
): RailRow[] {
	const rows: RailRow[] = agents.map(space => ({kind: 'space', space}));
	if (agents.length > 0 && hasWorkspaces) rows.push({kind: 'divider'});
	return rows;
}

/** The ungrouped rail: the display list, with the divider under agent spaces. */
export function flatRailRows(displaySpaces: readonly SpaceData[]): RailRow[] {
	const agents = displaySpaces.filter(space => isAgentSpace(space));
	const workspaces = displaySpaces.filter(space => !isAgentSpace(space));
	return [
		...agentRowsWithDivider(agents, workspaces.length > 0),
		...workspaces.map(
			(space): RailRow =>
				space.isPending ? {kind: 'pending', space} : {kind: 'space', space},
		),
	];
}

/**
 * The grouped rail. Spaces keep their incoming order inside each group, so the
 * newest-first order holds whatever their status history. A starting session
 * has no status yet; it shows at the top of the first group, even when that
 * group is collapsed, so the user sees it come up.
 */
export function buildRailRows(options: {
	displaySpaces: readonly SpaceData[];
	groups: readonly RailGroup[];
	collapsed: ReadonlySet<string>;
}): RailRow[] {
	const {displaySpaces, groups, collapsed} = options;
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

		const isCollapsed = collapsed.has(group.id);
		groupRows.push({
			kind: 'header',
			group,
			count: spaces.length,
			collapsed: isCollapsed,
			attention: isCollapsed ? attentionOf(spaces) : null,
		});
		for (const space of starting) groupRows.push({kind: 'pending', space});
		if (!isCollapsed) {
			for (const space of spaces) groupRows.push({kind: 'space', space});
		}
	}

	return [...agentRowsWithDivider(agents, groupRows.length > 0), ...groupRows];
}

/** Rows j/k and clicks can land on. */
export function isSelectableRow(row: RailRow | undefined): boolean {
	return row?.kind === 'space' || row?.kind === 'header';
}

export interface RailCursor {
	/** The selected space, which may sit inside a collapsed group. */
	space: SpaceData | undefined;
	/** Group id when a header is selected; wins over `space`. */
	headerId: string | null;
}

/**
 * The row the cursor sits on. A selected header that no longer has a row (its
 * last space changed status or closed) falls to the next group that still
 * does. A selected space hidden inside a collapsed group resolves to that
 * group's header.
 */
export function resolveCursorRow(
	rows: readonly RailRow[],
	cursor: RailCursor,
	groups: readonly RailGroup[],
): number {
	if (rows.length === 0) return -1;
	const headerRow = (id: string) =>
		rows.findIndex(row => row.kind === 'header' && row.group.id === id);

	if (cursor.headerId !== null) {
		const exact = headerRow(cursor.headerId);
		if (exact !== -1) return exact;
		const order = groups.map(group => group.id);
		const after = order.indexOf(cursor.headerId);
		const next = rows.findIndex(
			row => row.kind === 'header' && order.indexOf(row.group.id) > after,
		);
		return next === -1 ? rows.length - 1 : next;
	}

	const {space} = cursor;
	if (!space) return 0;
	const spaceRow = rows.findIndex(
		row => row.kind === 'space' && row.space.name === space.name,
	);
	if (spaceRow !== -1) return spaceRow;
	const group = railGroupOf(space, groups);
	return group ? Math.max(0, headerRow(group.id)) : 0;
}
