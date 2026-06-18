// Formats the "pappardelle …" line shown at the top of the help overlay.
// When a semver version is resolvable, renders `pappardelle v<version> (<sha>)`;
// otherwise falls back to the sha-only form used before STA-864 wired up semver.
//
// `isDev` marks builds running outside a tagged release checkout (e.g. from a
// monorepo worktree during local QA). Those builds carry no reachable release
// tag of their own, so we surface the latest installed release suffixed `-dev`
// (`pappardelle v0.7.9-dev (<sha>)`) to signal "ahead of v0.7.9" rather than the
// stale, never-bumped package.json version that used to leak through (STA-1494).
export function formatVersionLine(
	installedVersion: string | null | undefined,
	commitSha: string,
	isDev = false,
): string {
	if (!installedVersion) {
		return `pappardelle (${commitSha})`;
	}
	const normalized = installedVersion.startsWith('v')
		? installedVersion
		: `v${installedVersion}`;
	const suffixed = isDev ? `${normalized}-dev` : normalized;
	return `pappardelle ${suffixed} (${commitSha})`;
}
