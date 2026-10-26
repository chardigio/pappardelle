import {
	determineProfileForInput,
	matchProfiles,
	matchProfilesByInputKeyPrefix,
	getDefaultProfile,
	getProfileEmoji,
	DEFERRED_PROFILE_DISPLAY_NAME,
	inputKeyPrefix,
	type PappardelleConfig,
} from './config.ts';

/**
 * The new-session flow used to be one keystroke: type a prompt, hit Enter, and
 * whatever profile the keywords happened to match is what you got, and the only
 * way to override it was to bend the prompt text around a keyword. This module
 * backs a second stage where that inferred profile is merely the *pre-selected*
 * entry in a list of every profile, so overriding costs an arrow key instead of
 * a reworded prompt. Enter-Enter therefore reproduces the old behavior exactly.
 *
 * All of it is pure so the ordering, scrolling, and key handling can be tested
 * without rendering Ink.
 */

/** Rows of the picker visible at once. Longer lists scroll. */
export const PICKER_MAX_VISIBLE = 4;

export type ProfileOption = {
	kind: 'profile' | 'deferred';
	/** The `--profile` value this row spawns under; null for the deferred row. */
	name: string | null;
	displayName: string;
	/** Keywords in the prompt that selected this profile; empty for non-matches. */
	matchedKeywords: string[];
	/** The issue-key prefix this profile claims by name. */
	matchedPrefix?: string;
	/** True for the config's `default_profile`, wherever it lands in the list. */
	isDefault: boolean;
	/** True when a `keyword!` in the prompt forced this profile to the front. */
	enforced: boolean;
	/**
	 * Ticket-rail emoji slot for this profile, with the rail's exact three-state
	 * semantics: `undefined` for "nobody configured an emoji", `''` for "slot
	 * reserved but empty". Resolved here rather than in the component so the
	 * picker and the rail always agree about which profile wears which glyph.
	 */
	emoji: string | undefined;
};

export function deferredOption(config: PappardelleConfig): ProfileOption {
	return {
		kind: 'deferred',
		name: null,
		displayName: DEFERRED_PROFILE_DISPLAY_NAME,
		matchedKeywords: [],
		isDefault: false,
		enforced: false,
		emoji: getProfileEmoji(undefined, config),
	};
}

/**
 * Order every profile for the picker: the profile that would have been chosen
 * automatically first, then any other keyword matches by descending score, then
 * the default profile, then the rest in config declaration order.
 *
 * The last three groups are the same list an unmatched prompt produces, so a
 * keyword match only ever inserts rows at the top and pushes everything else
 * down. Without the default's reserved slot the list would silently reshuffle
 * the moment a keyword hit: a `default_profile` declared eleventh in the config
 * sits first for a blank prompt and eleventh for a matched one, which puts the
 * most-used fallback out of reach exactly when the guess is most likely wrong.
 *
 * For an issue key the ranking comes from the key's prefix rather than
 * keywords, behind the deferred row — a key is a name, not a description, so
 * there are no keywords to score, but the prefix still says which profiles
 * could own it. Beads IDs carry a prefix too — the issue source ahead of the
 * last hyphen — but a database nobody named in `tracker_projects` is claimed by
 * no profile, so its key falls through to the default-led list rather than
 * leading with a deferred row that resolves to nothing.
 *
 * The tail keeps config declaration order rather than sorting alphabetically:
 * that is the order the user wrote their profiles in, which is the closest thing
 * we have to their own sense of priority.
 */
export function buildProfileOptions(
	config: PappardelleConfig,
	input: string,
): ProfileOption[] {
	// Blank input is deliberately NOT an early return: the picker is on screen
	// from the moment the dialog opens, so it needs the same default-first list
	// an unmatched prompt would produce. `matchProfiles` already yields nothing
	// for empty input, which lands us in the no-match branch below.
	const trimmed = input.trim();

	const defaultName = getDefaultProfile(config).name;
	const matches = matchProfiles(config, trimmed);

	const toOption = (
		name: string,
		matchedKeywords: string[],
		enforced: boolean,
		matchedPrefix?: string,
	): ProfileOption | null => {
		const profile = config.profiles[name];
		if (!profile) return null;
		return {
			kind: 'profile',
			name,
			displayName: profile.display_name,
			matchedKeywords,
			...(matchedPrefix ? {matchedPrefix} : {}),
			isDefault: name === defaultName,
			enforced,
			emoji: getProfileEmoji(profile, config),
		};
	};

	const ordered: ProfileOption[] = [];
	const seen = new Set<string>();

	const prefix = inputKeyPrefix(config, trimmed);
	const prefixMatches = matchProfilesByInputKeyPrefix(config, trimmed);
	if (prefixMatches.length > 0) {
		ordered.push(deferredOption(config));
		for (const match of prefixMatches) {
			const option = toOption(
				match.name,
				[],
				false,
				match.explicit && prefix ? prefix : undefined,
			);
			if (option && !seen.has(match.name)) {
				seen.add(match.name);
				ordered.push(option);
			}
		}
	}

	for (const match of matches) {
		const option = toOption(match.name, match.matchedKeywords, match.enforced);
		if (option && !seen.has(match.name)) {
			seen.add(match.name);
			ordered.push(option);
		}
	}

	// The default profile takes the next slot whether or not a keyword matched.
	// With no match it leads the list, which keeps Enter-Enter equivalent to the
	// old single Enter; with a match it is the first fallback under the guess.
	if (!seen.has(defaultName)) {
		const option = toOption(defaultName, [], false);
		if (option) {
			seen.add(defaultName);
			ordered.push(option);
		}
	}

	for (const name of Object.keys(config.profiles)) {
		if (seen.has(name)) continue;
		const option = toOption(name, [], false);
		if (option) ordered.push(option);
	}

	return ordered;
}

export type PromptSubmit =
	/** Blank input: stay where you are. */
	| {kind: 'none'}
	/**
	 * Spawn without showing the picker. Used for bare numbers and for issue keys
	 * whose prefix no profile claims, where the profile is resolved downstream by
	 * idow from the fetched issue's tracker project — there is nothing meaningful
	 * to preselect.
	 */
	| {kind: 'spawn'; profileName: string | null}
	/** Advance to the picker with these options, index 0 preselected. */
	| {kind: 'pick'; options: ProfileOption[]};

/**
 * Decide what the first Enter does. Keeping this separate from the component
 * makes the backwards-compatibility guarantee (an unclaimed issue key still
 * spawns on a single Enter with no `--profile`, and a claimed one still spawns
 * that way on Enter-Enter) something a test can pin down.
 */
export function resolvePromptSubmit(
	config: PappardelleConfig | null,
	input: string,
): PromptSubmit {
	const trimmed = input.trim();
	if (!trimmed) return {kind: 'none'};
	if (!config) return {kind: 'spawn', profileName: null};

	const selection = determineProfileForInput(config, trimmed);
	if (!selection) return {kind: 'spawn', profileName: null};

	if (selection.kind === 'deferred' && !selection.canPick) {
		return {kind: 'spawn', profileName: null};
	}

	const options = buildProfileOptions(config, trimmed);
	if (options.length === 0) {
		return {
			kind: 'spawn',
			profileName: selection.kind === 'resolved' ? selection.name : null,
		};
	}

	return {kind: 'pick', options};
}

export type PickerWindow = {
	start: number;
	end: number;
	/** Items scrolled off the top; drives the "↑ N more" affordance. */
	above: number;
	/** Items scrolled off the bottom. */
	below: number;
};

/**
 * Slide a fixed-height window over the option list so the selection stays
 * visible, anchoring to whichever edge the selection ran past.
 */
export function computePickerWindow(
	total: number,
	selectedIndex: number,
	maxVisible: number,
): PickerWindow {
	if (total <= 0) return {start: 0, end: 0, above: 0, below: 0};

	const height = Math.max(1, Math.min(maxVisible, total));
	const clamped = Math.max(0, Math.min(selectedIndex, total - 1));

	// Stay pinned to the top until the selection would fall off the bottom, then
	// track it one row at a time. Stateless by design: the window is a pure
	// function of the selection, so re-entering the picker can't strand it.
	const start =
		clamped < height ? 0 : Math.min(clamped - height + 1, total - height);

	const end = Math.min(total, start + height);
	return {start, end, above: start, below: total - end};
}

export type PickerKeyResult = {
	action: 'move' | 'submit' | 'back' | 'search' | 'clear-search' | 'ignore';
	index: number;
};

/** Where the selection sits in the rows on screen. */
export type PickerList = {
	index: number;
	total: number;
	/** A search filter is locked on the list. */
	hasFilter?: boolean;
};

type PickerKey = {
	upArrow?: boolean;
	downArrow?: boolean;
	return?: boolean;
	escape?: boolean;
};

/**
 * Movement clamps rather than wraps, matching the main space list: arrowing
 * past the end of a four-item list should not silently teleport you back to the
 * profile you were trying to move away from.
 *
 * With a locked search filter, Esc clears the filter before it goes back. The
 * filter hides rows, so leaving with it still on would bring you back later to
 * a list with profiles missing and no reason on screen why.
 */
export function handleProfilePickerKey(
	input: string,
	key: PickerKey,
	{index: selectedIndex, total, hasFilter = false}: PickerList,
): PickerKeyResult {
	if (key.escape) {
		return {
			action: hasFilter ? 'clear-search' : 'back',
			index: selectedIndex,
		};
	}

	if (key.return) {
		if (total <= 0) return {action: 'ignore', index: selectedIndex};
		return {action: 'submit', index: selectedIndex};
	}

	if (input === '/') {
		return {action: 'search', index: selectedIndex};
	}

	if (key.upArrow || input === 'k') {
		return {action: 'move', index: Math.max(0, selectedIndex - 1)};
	}

	if (key.downArrow || input === 'j') {
		// A locked filter can leave zero rows, and the index must not go to -1.
		return {
			action: 'move',
			index: Math.max(0, Math.min(total - 1, selectedIndex + 1)),
		};
	}

	return {action: 'ignore', index: selectedIndex};
}

/**
 * Narrow the picker to the profiles whose name or display name contains the
 * query. Keywords are left out on purpose: they already ranked the list from
 * the prompt, and a search for "web" that surfaced a profile only because one
 * of its keywords is "webhook" would read as a wrong match.
 *
 * The filter keeps the ranked order rather than re-ranking by match quality, so
 * the inferred profile stays on top whenever it still matches.
 */
export function filterProfileOptions(
	options: ProfileOption[],
	query: string,
): ProfileOption[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return options;
	return options.filter(
		option =>
			option.displayName.toLowerCase().includes(needle) ||
			(option.name?.toLowerCase().includes(needle) ?? false),
	);
}

export type SearchKeyResult =
	| {action: 'edit'; query: string}
	| {action: 'move'; index: number}
	/** Keep the filter, hand the keys back to the list (`less`-style). */
	| {action: 'lock'}
	/** Drop the filter and the search row. */
	| {action: 'cancel'}
	| {action: 'ignore'};

type SearchKey = PickerKey & {
	backspace?: boolean;
	delete?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	tab?: boolean;
};

/**
 * Keys while the `/` search row has the focus. Every printable key is text
 * here, `j` and `k` included, so only the arrows move the selection. Enter
 * locks the filter instead of starting the session: the search is a way to
 * reach a row, and the start stays one deliberate Enter away in list mode.
 */
export function handleProfileSearchKey(
	input: string,
	key: SearchKey,
	query: string,
	{index: selectedIndex, total}: PickerList,
): SearchKeyResult {
	if (key.escape) return {action: 'cancel'};
	// A blank filter hides nothing, so there is nothing to lock.
	if (key.return) return query.trim() ? {action: 'lock'} : {action: 'cancel'};

	if (key.upArrow) {
		return {action: 'move', index: Math.max(0, selectedIndex - 1)};
	}

	if (key.downArrow) {
		return {
			action: 'move',
			index: Math.max(0, Math.min(total - 1, selectedIndex + 1)),
		};
	}

	if (key.backspace || key.delete) {
		// Like vim's `/`: backspace past the start closes the search.
		if (!query) return {action: 'cancel'};
		return {action: 'edit', query: query.slice(0, -1)};
	}

	if (key.ctrl || key.meta || key.tab) return {action: 'ignore'};

	// eslint-disable-next-line no-control-regex
	const text = input.replaceAll(/[\u0000-\u001F\u007F]/g, '');
	if (!text) return {action: 'ignore'};
	return {action: 'edit', query: query + text};
}

export type HintSegment = {
	key: string;
	label: string;
	color: 'green' | 'yellow';
};

/**
 * The key hint under the focused picker. It must fit on one row of the list
 * pane (`MAX_LIST_WIDTH` less the hint's padding): the dialog layout counts it
 * as one row, so a wrapped hint pushes the dialog past its pane. That budget is
 * why list mode leaves out the arrows: the caret already shows that the list
 * moves, and `/` is the key nobody would guess.
 */
export function profilePickerHint(
	search: {isEditing: boolean} | null,
): HintSegment[] {
	if (search?.isEditing) {
		return [
			{key: '↑/↓', label: 'select', color: 'green'},
			{key: 'Enter', label: 'lock', color: 'green'},
			{key: 'Esc', label: 'clear', color: 'yellow'},
		];
	}

	return [
		{key: 'Enter', label: 'start', color: 'green'},
		{key: '/', label: search ? 'edit' : 'search', color: 'green'},
		{key: 'Esc', label: search ? 'clear' : 'back', color: 'yellow'},
	];
}

/**
 * Which of the two stacked frames owns the double outline.
 *
 * Both boxes are on screen at all times, so the outline is the only thing
 * telling you where your keystrokes are going. The focused box gets the heavy
 * double rule at full brightness, the idle one a dim round rule.
 */
export function focusFrame(isFocused: boolean): {
	borderStyle: 'double' | 'round';
	isDim: boolean;
} {
	return isFocused
		? {borderStyle: 'double', isDim: false}
		: {borderStyle: 'round', isDim: true};
}
