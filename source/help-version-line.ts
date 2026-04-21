// Formats the "pappardelle …" line shown at the top of the help overlay.
// When a semver version is resolvable, renders `pappardelle v<version> (<sha>)`;
// otherwise falls back to the sha-only form used before STA-864 wired up semver.
export function formatVersionLine(
	installedVersion: string | null | undefined,
	commitSha: string,
): string {
	if (!installedVersion) {
		return `pappardelle (${commitSha})`;
	}
	const normalized = installedVersion.startsWith('v')
		? installedVersion
		: `v${installedVersion}`;
	return `pappardelle ${normalized} (${commitSha})`;
}
