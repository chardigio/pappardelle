/**
 * Check if an error message indicates that simctl is not available.
 * When xcrun exists but Xcode/simctl is not installed, `xcrun simctl`
 * fails with 'unable to find utility "simctl"'. This should be treated
 * as a graceful skip, not an error.
 */
export function isSimctlUnavailableError(stderr: string): boolean {
	return stderr.includes('unable to find utility "simctl"');
}
