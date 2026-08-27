/**
 * User overrides for the issue-status colors used in the ticket rail.
 *
 * The rail normally paints an issue key with the exact color the tracker gives
 * for that issue's status, which keeps pappardelle in step with Linear. Jira
 * workflows often give one color to several statuses ("In Progress" and
 * "In Review" are the usual pair), and the rail then cannot tell them apart.
 * The top-level `state_colors:` map in `.pappardelle.yml` replaces the tracker
 * color for the status names it lists.
 *
 * Names are matched case-insensitively and with surrounding space removed,
 * because a status name is prose that a human copies out of a tracker UI, not
 * an identifier. The map is installed once at startup as a module singleton so
 * `SpaceListItem` can consult it on every render without touching disk.
 */

/**
 * Color names that Ink accepts. Kept here (rather than imported from Ink) so
 * config validation can reject a typo at load time instead of letting Ink
 * silently fall back to the default color at render time.
 *
 * Case-sensitive on purpose: Ink's palette is camelCase, and accepting
 * "BlueBright" here would only pass an unknown key through to Ink.
 */
export const INK_COLOR_NAMES: ReadonlySet<string> = new Set([
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'gray',
	'grey',
	'blackBright',
	'redBright',
	'greenBright',
	'yellowBright',
	'blueBright',
	'magentaBright',
	'cyanBright',
	'whiteBright',
]);

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

/**
 * Whether a value is something the rail can hand to Ink as a color.
 * Accepts `#rgb` / `#rrggbb` hex and the Ink color names.
 */
export function isValidStateColor(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (HEX_COLOR.test(value)) return true;
	return INK_COLOR_NAMES.has(value);
}

/** Canonical form of a status name for matching purposes. */
export function normalizeStateName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Find the override for a status name in a raw `state_colors` map.
 *
 * Returns null for an unlisted name and — defensively — for a value that is not
 * a valid color. Config validation already rejects bad values, so that second
 * guard only matters for a caller that skipped validation; it keeps junk out of
 * Ink rather than letting a bad string reach the renderer.
 */
export function lookupStateColorOverride(
	overrides: Readonly<Record<string, string>> | undefined,
	stateName: string | undefined,
): string | null {
	if (!overrides || !stateName) return null;
	const wanted = normalizeStateName(stateName);
	if (wanted.length === 0) return null;

	for (const [name, color] of Object.entries(overrides)) {
		if (normalizeStateName(name) !== wanted) continue;
		return isValidStateColor(color) ? color : null;
	}

	return null;
}

let activeOverrides: Readonly<Record<string, string>> | undefined;

/**
 * Install the overrides for the running process. Passing undefined clears them,
 * so a config reload that dropped the section restores the tracker colors.
 */
export function initStateColorOverrides(
	overrides?: Readonly<Record<string, string>>,
): void {
	activeOverrides = overrides;
}

/** Drop the installed overrides (startup default, and test cleanup). */
export function resetStateColorOverrides(): void {
	activeOverrides = undefined;
}

/** The installed override for a status name, or null when there is none. */
export function getStateColorOverride(
	stateName: string | undefined,
): string | null {
	return lookupStateColorOverride(activeOverrides, stateName);
}

/**
 * The color the ticket rail paints an issue key with: the user's override when
 * one is installed for this status, otherwise the tracker's own color. With no
 * `state_colors:` configured this is the identity function on `trackerColor`.
 */
export function resolveStateColor(
	stateName: string | undefined,
	trackerColor: string,
): string {
	return getStateColorOverride(stateName) ?? trackerColor;
}
