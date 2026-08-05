import {
	determineProfileForInput,
	matchProfiles,
	getDefaultProfile,
	getProfileEmoji,
	type PappardelleConfig,
} from './config.ts';

/**
 * The new-session flow used to be one keystroke: type a prompt, hit Enter, and
 * whatever profile the keywords happened to match is what you got — the only
 * way to override it was to bend the prompt text around a keyword. This module
 * backs a second stage where that inferred profile is merely the *pre-selected*
 * entry in a list of every profile, so overriding costs an arrow key instead of
 * a reworded prompt. Enter-Enter therefore reproduces the old behavior exactly.
 *
 * All of it is pure so the ordering, scrolling, and key handling can be tested
 * without rendering Ink.
 */

/** Rows of the picker visible at once — a screen-size compromise, not a limit. */
export const PICKER_MAX_VISIBLE = 4;

export type ProfileOption = {
	name: string;
	displayName: string;
	/** Keywords in the prompt that selected this profile; empty for non-matches. */
	matchedKeywords: string[];
	/** True for the config's `default_profile`, wherever it lands in the list. */
	isDefault: boolean;
	/** True when a `keyword!` in the prompt forced this profile to the front. */
	enforced: boolean;
	/**
	 * Ticket-rail emoji slot for this profile, with the rail's exact three-state
	 * semantics — `undefined` for "nobody configured an emoji", `''` for "slot
	 * reserved but empty". Resolved here rather than in the component so the
	 * picker and the rail always agree about which profile wears which glyph.
	 */
	emoji: string | undefined;
};

/**
 * Order every profile for the picker: the profile that would have been chosen
 * automatically first, then any other keyword matches by descending score, then
 * the rest in config declaration order.
 *
 * The tail is deliberately *not* sorted alphabetically — config order is the
 * order the user wrote their profiles in, which is the closest thing we have to
 * their own sense of priority.
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
	): ProfileOption | null => {
		const profile = config.profiles[name];
		if (!profile) return null;
		return {
			name,
			displayName: profile.display_name,
			matchedKeywords,
			isDefault: name === defaultName,
			enforced,
			emoji: getProfileEmoji(profile, config),
		};
	};

	const ordered: ProfileOption[] = [];
	const seen = new Set<string>();

	for (const match of matches) {
		const option = toOption(match.name, match.matchedKeywords, match.enforced);
		if (option && !seen.has(match.name)) {
			seen.add(match.name);
			ordered.push(option);
		}
	}

	// No keyword matched, so the automatic choice is the default profile — it
	// leads the list to keep Enter-Enter equivalent to the old single Enter.
	if (ordered.length === 0) {
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
	/** Blank input — stay where you are. */
	| {kind: 'none'}
	/**
	 * Spawn without showing the picker. Used for issue keys, bare numbers, and
	 * Linear URLs, where the profile is resolved downstream by idow from the
	 * fetched issue's tracker project — there is nothing meaningful to preselect.
	 */
	| {kind: 'spawn'; profileName: string | null}
	/** Advance to the picker with these options, index 0 preselected. */
	| {kind: 'pick'; options: ProfileOption[]};

/**
 * Decide what the first Enter does. Keeping this separate from the component
 * makes the backwards-compatibility guarantee (issue keys still spawn on a
 * single Enter with no `--profile`) something a test can pin down.
 */
export function resolvePromptSubmit(
	config: PappardelleConfig | null,
	input: string,
): PromptSubmit {
	const trimmed = input.trim();
	if (!trimmed) return {kind: 'none'};
	if (!config) return {kind: 'spawn', profileName: null};

	const selection = determineProfileForInput(config, trimmed);
	if (!selection || selection.kind === 'deferred') {
		return {kind: 'spawn', profileName: null};
	}

	const options = buildProfileOptions(config, trimmed);
	if (options.length === 0) {
		return {kind: 'spawn', profileName: selection.name};
	}

	return {kind: 'pick', options};
}

export type PickerWindow = {
	start: number;
	end: number;
	/** Items scrolled off the top — drives the "↑ N more" affordance. */
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
	action: 'move' | 'submit' | 'back' | 'ignore';
	index: number;
};

type PickerKey = {
	upArrow?: boolean;
	downArrow?: boolean;
	return?: boolean;
	escape?: boolean;
};

/**
 * Movement clamps rather than wraps, matching the main space list — arrowing
 * past the end of a four-item list should not silently teleport you back to the
 * profile you were trying to move away from.
 */
export function handleProfilePickerKey(
	input: string,
	key: PickerKey,
	selectedIndex: number,
	total: number,
): PickerKeyResult {
	if (key.escape) {
		return {action: 'back', index: selectedIndex};
	}

	if (key.return) {
		if (total <= 0) return {action: 'ignore', index: selectedIndex};
		return {action: 'submit', index: selectedIndex};
	}

	if (key.upArrow || input === 'k') {
		return {action: 'move', index: Math.max(0, selectedIndex - 1)};
	}

	if (key.downArrow || input === 'j') {
		return {action: 'move', index: Math.min(total - 1, selectedIndex + 1)};
	}

	return {action: 'ignore', index: selectedIndex};
}

/**
 * Which of the two stacked frames owns the double outline.
 *
 * Both boxes are on screen at all times, so the outline is the only thing
 * telling you where your keystrokes are going — the focused box gets the heavy
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
