// Pure utility functions for issue identification
// These have no side effects and can be easily tested

/**
 * Check if a string looks like a Linear issue key (e.g., STA-123, ENG-456)
 */
export function isLinearIssueKey(input: string): boolean {
	return /^[A-Z]+-\d+$/i.test(input.trim());
}

/**
 * Check if a string is a bare issue number (e.g., 400, 123)
 */
export function isIssueNumber(input: string): boolean {
	return /^\d+$/.test(input.trim());
}

/**
 * Normalize an issue identifier to uppercase format (e.g., STA-400)
 * Accepts:
 *   - Bare numbers: '400' -> 'STA-400' (uses teamPrefix)
 *   - Lowercase keys: 'sta-123' -> 'STA-123'
 *   - Mixed case: 'Sta-456' -> 'STA-456'
 * Returns null if input is not a valid issue identifier
 */
export function normalizeIssueIdentifier(
	input: string,
	teamPrefix: string,
): string | null {
	const trimmed = input.trim();

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
