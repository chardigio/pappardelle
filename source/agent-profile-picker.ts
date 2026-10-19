import {rankByFuzzyMatch} from './profile-picker.ts';

export type AgentProfileChoice = {name: string; source: string};

/** What the popup shows, resolved by the TUI, which holds the current override. */
export type AgentProfileRequest = {
	options: AgentProfileChoice[];
	/** Preselected row: the current override, else the profile's own agent profile. */
	selected: string;
	/** The profile's own agent profile, marked "(default)" in the list. */
	profileDefault: string;
};

export const AGENT_POPUP_MAX_VISIBLE = 16;

/** The row named '' stands for "no override" where the profile is unknown. */
export const PROFILE_AGENT_LABEL = "profile's agent";

/**
 * Rows of the picker besides the options: border, title and its margin, hint
 * and its margin.
 */
export const AGENT_PICKER_CHROME_ROWS = 6;

/** Border and paddingX={1} on both sides. */
const HORIZONTAL_CHROME = 4;

/** The picker's hint, which sets its minimum width. */
export const AGENT_PICKER_HINT =
	'↑/↓ select · / filter · Enter choose · Esc cancel';

/** Names longer than this are cut so the source column keeps its room. */
export const AGENT_PICKER_NAME_MAX_WIDTH = 32;

/** Room for the "↑/↓ N more" rows once the list scrolls. */
const SCROLL_MARKER_ROWS = 2;

/** Rows the picker needs to show `optionCount` options without scrolling. */
export function agentPickerHeight(optionCount: number): number {
	return (
		AGENT_PICKER_CHROME_ROWS +
		Math.min(optionCount, AGENT_POPUP_MAX_VISIBLE) +
		(optionCount > AGENT_POPUP_MAX_VISIBLE ? SCROLL_MARKER_ROWS : 0)
	);
}

/** Columns the picker wants: 60% of the client, but never narrower than its hint. */
export function agentPickerWidth(clientCols: number): number {
	return Math.max(
		Math.floor(clientCols * 0.6),
		AGENT_PICKER_HINT.length + HORIZONTAL_CHROME,
	);
}

/**
 * How many options fit in a picker `height` rows tall. tmux shrinks a popup
 * that doesn't fit the client, and output taller than the popup scrolls its
 * first rows out of view.
 */
export function agentPopupVisibleRows(
	optionCount: number,
	height: number,
): number {
	const room = Math.min(
		AGENT_POPUP_MAX_VISIBLE,
		height - AGENT_PICKER_CHROME_ROWS,
	);
	if (optionCount <= room) return optionCount;
	return Math.max(1, room - SCROLL_MARKER_ROWS);
}

export function agentProfileLabel(name: string): string {
	return name || PROFILE_AGENT_LABEL;
}

/**
 * Narrow the list to the agent profiles whose name (or the profile's-agent
 * label) matches the query; see rankByFuzzyMatch.
 */
export function filterAgentProfiles(
	options: AgentProfileChoice[],
	query: string,
): AgentProfileChoice[] {
	return rankByFuzzyMatch(options, query, option => [
		agentProfileLabel(option.name),
	]);
}
