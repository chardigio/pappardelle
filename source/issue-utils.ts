// Pure utility functions for issue identification
// These have no side effects and can be easily tested
import type {TrackerProviderName} from './providers/types.ts';

/**
 * Check if a string looks like a Linear issue key (e.g., STA-123, ENG-456)
 */
export function isLinearIssueKey(input: string): boolean {
	return /^[A-Z][A-Z0-9]*-\d+$/i.test(input.trim());
}

/**
 * Provider-agnostic alias for isLinearIssueKey.
 * The pattern (PREFIX-NUMBER) is shared by Linear, Jira, and most trackers.
 */
export const isIssueKey = isLinearIssueKey;

/**
 * The issue-source prefix of an issue key: everything ahead of the last hyphen,
 * with any `.N` child suffix dropped first. `STA-123` -> `STA`,
 * `seatgeek-ticket-management-cli-bqm` -> `seatgeek-ticket-management-cli`.
 */
export function issueKeyPrefix(identifier: string): string {
	// split always yields at least one element, so index 0 is never undefined.
	const root = identifier.split('.')[0]!;
	const lastDash = root.lastIndexOf('-');
	return lastDash === -1 ? root : root.slice(0, lastDash);
}

/**
 * Check if a string is a beads issue ID belonging to one of `prefixes`
 * (e.g. bd-a1b2, bd-a3f8e9.1, seatgeek-ticket-management-cli-bqm).
 */
export function isBeadsIssueKey(input: string, prefixes: string[]): boolean {
	const trimmed = input.trim();
	if (!/^[a-z\d_]+(-[a-z\d_]+)+(\.\d+){0,3}$/i.test(trimmed)) return false;
	const prefix = issueKeyPrefix(trimmed).toLowerCase();
	return prefixes.some(p => p.trim().toLowerCase() === prefix);
}

/**
 * Check if a string is a bare issue number (e.g., 400, 123)
 */
export function isIssueNumber(input: string): boolean {
	return /^\d+$/.test(input.trim());
}

const LINEAR_URL_ISSUE_KEY =
	/^https:\/\/linear\.app\/.+\/issue\/([A-Z][A-Z0-9]*)-\d+/i;

/**
 * Extract the team prefix an issue identifier belongs to (e.g. 'STA' for
 * 'STA-123'), uppercased. Accepts a bare key or a Linear issue URL.
 */
export function issueKeyTeamPrefix(input: string): string | null {
	const trimmed = input.trim();

	const url = trimmed.match(LINEAR_URL_ISSUE_KEY);
	if (url) return url[1]!.toUpperCase();

	if (!isLinearIssueKey(trimmed)) return null;
	return trimmed.split('-')[0]!.toUpperCase();
}

/**
 * Normalize an issue identifier to the form its tracker uses.
 * Accepts:
 *   - Bare numbers: '400' -> 'STA-400' (uses teamPrefix)
 *   - Lowercase keys: 'sta-123' -> 'STA-123'
 *   - Mixed case: 'Sta-456' -> 'STA-456'
 * Returns null if input is not a valid issue identifier
 *
 * `provider` selects the key grammar. Beads IDs fold to lowercase rather than
 * uppercase, since that is the only casing `bd` can resolve. `beadsPrefixes` is
 * the allowlist from `getBeadsPrefixes`; anything outside it is prose, not a
 * key, and an empty allowlist therefore makes every beads input a description.
 */
export function normalizeIssueIdentifier(
	input: string,
	teamPrefix: string,
	provider: TrackerProviderName,
	beadsPrefixes: string[],
): string | null {
	const trimmed = input.trim();

	if (provider === 'beads') {
		if (isIssueNumber(trimmed)) {
			return `${teamPrefix.toLowerCase()}-${trimmed}`;
		}

		return isBeadsIssueKey(trimmed, beadsPrefixes)
			? trimmed.toLowerCase()
			: null;
	}

	// Bare number: expand with team prefix
	if (isIssueNumber(trimmed)) {
		return `${teamPrefix.toUpperCase()}-${trimmed}`;
	}

	// Full issue key: normalize to uppercase
	if (isLinearIssueKey(trimmed)) {
		return trimmed.toUpperCase();
	}

	// Not an issue identifier
	return null;
}
