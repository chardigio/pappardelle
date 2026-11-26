import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {storeTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	parseSemver,
	compareSemver,
	readInstalledVersion,
	readInstalledVersionFromGit,
	resolveInstalledVersion,
	resolveDisplayVersion,
	readCommitSha,
	isLocalMode,
	checkForUpdate,
	safeCheckForUpdate,
	type CacheEntry,
	type UpdateCheckDao,
} from './update-check.ts';

function initRepoWithTag(dir: string, tag: string | null): void {
	execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
	execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
	execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
	execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
	writeFileSync(path.join(dir, 'f'), 'x');
	execFileSync('git', ['-C', dir, 'add', '.']);
	execFileSync('git', [
		'-C',
		dir,
		'commit',
		'-q',
		'--no-gpg-sign',
		'-m',
		'init',
	]);
	if (tag) {
		execFileSync('git', ['-C', dir, 'tag', tag]);
	}
}

// ============================================================================
// parseSemver
// ============================================================================

test('parseSemver: plain semver', () => {
	expect(parseSemver('0.1.0')).toStrictEqual({major: 0, minor: 1, patch: 0});
	expect(parseSemver('1.2.3')).toStrictEqual({major: 1, minor: 2, patch: 3});
	expect(parseSemver('10.20.30')).toStrictEqual({
		major: 10,
		minor: 20,
		patch: 30,
	});
});

test('parseSemver: strips leading v', () => {
	expect(parseSemver('v1.2.3')).toStrictEqual({major: 1, minor: 2, patch: 3});
	expect(parseSemver('V0.1.0')).toStrictEqual({major: 0, minor: 1, patch: 0});
});

test('parseSemver: rejects garbage', () => {
	expect(parseSemver('')).toBe(null);
	expect(parseSemver('1.2')).toBe(null);
	expect(parseSemver('1.2.3.4')).toBe(null);
	expect(parseSemver('not-a-version')).toBe(null);
	expect(parseSemver('1.a.3')).toBe(null);
});

// ============================================================================
// compareSemver
// ============================================================================

test('compareSemver: equal versions', () => {
	expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
	expect(compareSemver('v0.1.0', '0.1.0')).toBe(0);
});

test('compareSemver: major wins over minor/patch', () => {
	expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
	expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
});

test('compareSemver: minor wins over patch', () => {
	expect(compareSemver('1.1.0', '1.2.0')).toBe(-1);
	expect(compareSemver('1.2.0', '1.1.99')).toBe(1);
});

test('compareSemver: patch', () => {
	expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
	expect(compareSemver('1.2.5', '1.2.4')).toBe(1);
});

test('compareSemver: unparsable falls back to 0', () => {
	expect(compareSemver('garbage', '1.2.3')).toBe(0);
	expect(compareSemver('1.2.3', 'garbage')).toBe(0);
});

// ============================================================================
// readInstalledVersion
// ============================================================================

test('readInstalledVersion: reads from package.json', () => {
	const dir = tempDir('pap-uc-');
	const pkg = path.join(dir, 'package.json');
	writeFileSync(pkg, JSON.stringify({name: 'pappardelle', version: '1.2.3'}));
	expect(readInstalledVersion(pkg)).toBe('1.2.3');
});

test('readInstalledVersion: returns null when file missing', () => {
	expect(readInstalledVersion('/definitely/does/not/exist/package.json')).toBe(
		null,
	);
});

test('readInstalledVersion: returns null when version missing', () => {
	const dir = tempDir('pap-uc-');
	const pkg = path.join(dir, 'package.json');
	writeFileSync(pkg, JSON.stringify({name: 'pappardelle'}));
	expect(readInstalledVersion(pkg)).toBe(null);
});

// ============================================================================
// readInstalledVersionFromGit
// ============================================================================

test('readInstalledVersionFromGit: returns the latest semver tag reachable from HEAD', () => {
	const dir = tempDir('pap-uc-git-');
	initRepoWithTag(dir, 'v1.2.3');
	expect(readInstalledVersionFromGit(dir)).toBe('v1.2.3');
});

test('readInstalledVersionFromGit: ignores non-semver tags', () => {
	const dir = tempDir('pap-uc-git-');
	initRepoWithTag(dir, 'not-a-version');
	expect(readInstalledVersionFromGit(dir)).toBe(null);
});

test('readInstalledVersionFromGit: returns null when no tags exist', () => {
	const dir = tempDir('pap-uc-git-');
	initRepoWithTag(dir, null);
	expect(readInstalledVersionFromGit(dir)).toBe(null);
});

test('readInstalledVersionFromGit: returns null when not a git repo', () => {
	const dir = tempDir('pap-uc-git-');
	expect(readInstalledVersionFromGit(dir)).toBe(null);
});

// ============================================================================
// resolveInstalledVersion (git tag preferred, package.json fallback)
// ============================================================================

test('resolveInstalledVersion: uses the git tag when present', () => {
	const dir = tempDir('pap-uc-resolve-');
	initRepoWithTag(dir, 'v2.0.0');
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	expect(resolveInstalledVersion(dir)).toBe('v2.0.0');
});

test('resolveInstalledVersion: falls back to package.json when no tags', () => {
	const dir = tempDir('pap-uc-resolve-');
	initRepoWithTag(dir, null);
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	expect(resolveInstalledVersion(dir)).toBe('0.1.0');
});

test('resolveInstalledVersion: returns null when neither source works', () => {
	const dir = tempDir('pap-uc-resolve-');
	expect(resolveInstalledVersion(dir)).toBe(null);
});

// ============================================================================
// readCommitSha (help-overlay sha: stamped snapshot vs git checkout)
// ============================================================================

test('readCommitSha: a snapshot reports the sha install.sh stamped, not the git history around it', () => {
	const dir = tempDir('pap-sha-');
	initRepoWithTag(dir, null);
	writeFileSync(path.join(dir, 'commit-sha'), 'abc1234-dirty\n');
	expect(readCommitSha(dir)).toBe('abc1234-dirty');
});

test('readCommitSha: a checkout without a stamp reports its last commit', () => {
	const dir = tempDir('pap-sha-');
	initRepoWithTag(dir, null);
	const head = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h'], {
		encoding: 'utf8',
	}).trim();
	expect(readCommitSha(dir)).toBe(head);
});

test('readCommitSha: neither a stamp nor git reports no sha', () => {
	const dir = tempDir('pap-sha-');
	expect(readCommitSha(dir)).toBe(undefined);
});

// ============================================================================
// resolveDisplayVersion (help-overlay version: real tag vs -dev build)
// ============================================================================

test('resolveDisplayVersion: real release checkout reports the tag, not dev', () => {
	const proj = tempDir('pap-disp-proj-');
	const install = tempDir('pap-disp-inst-');
	initRepoWithTag(proj, 'v0.7.9');
	initRepoWithTag(install, 'v0.7.9');
	expect(resolveDisplayVersion(proj, install)).toStrictEqual({
		version: 'v0.7.9',
		isDev: false,
	});
});

test('resolveDisplayVersion: monorepo/worktree build reports the installed clone tag, flagged -dev', () => {
	// projectDir has no vX.Y.Z tag (mirrors the monorepo); installed clone does.
	const proj = tempDir('pap-disp-proj-');
	const install = tempDir('pap-disp-inst-');
	initRepoWithTag(proj, null);
	initRepoWithTag(install, 'v0.7.9');
	expect(resolveDisplayVersion(proj, install)).toStrictEqual({
		version: 'v0.7.9',
		isDev: true,
	});
});

test('resolveDisplayVersion: NEVER reports the stale package.json 0.1.0 for a dev build', () => {
	// Regression guard for STA-1494: a worktree build whose package.json says
	// 0.1.0 must surface the installed clone's real tag (as -dev), not 0.1.0.
	const proj = tempDir('pap-disp-proj-');
	const install = tempDir('pap-disp-inst-');
	initRepoWithTag(proj, null);
	writeFileSync(
		path.join(proj, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	initRepoWithTag(install, 'v0.7.9');
	const result = resolveDisplayVersion(proj, install);
	expect(result.version).not.toBe('0.1.0');
	expect(result).toStrictEqual({version: 'v0.7.9', isDev: true});
});

test('resolveDisplayVersion: returns null version (sha-only) when nothing is resolvable', () => {
	const proj = tempDir('pap-disp-proj-');
	const install = tempDir('pap-disp-inst-');
	initRepoWithTag(proj, null);
	initRepoWithTag(install, null);
	expect(resolveDisplayVersion(proj, install)).toStrictEqual({
		version: null,
		isDev: false,
	});
});

test('resolveDisplayVersion: defaults installedRoot to ~/.pappardelle/repo', () => {
	// When projectDir itself carries the tag, the default installedRoot is never
	// consulted, so this is safe to run without touching the real home dir.
	const proj = tempDir('pap-disp-proj-');
	initRepoWithTag(proj, 'v1.2.3');
	expect(resolveDisplayVersion(proj)).toStrictEqual({
		version: 'v1.2.3',
		isDev: false,
	});
});

// ============================================================================
// Cache IO
// ============================================================================

storeTest(
	'a cached check reads back, and a later one replaces it',
	async state => {
		const {updateCheck} = state.daos;
		expect(updateCheck.read()).toBe(null);

		const entry: CacheEntry = {
			checkedAt: 1_700_000_000_000,
			latestVersion: '0.2.0',
		};
		await updateCheck.write(entry);
		expect(updateCheck.read()).toStrictEqual(entry);

		const later = {checkedAt: 1_700_000_100_000, latestVersion: '0.3.0'};
		await updateCheck.write(later);
		expect(updateCheck.read()).toStrictEqual(later);
	},
);

// ============================================================================
// isLocalMode
// ============================================================================

test('isLocalMode: true when project dir is outside ~/.pappardelle/repo', () => {
	const projectDir =
		'/Users/charlie/.worktrees/x/STA-864/_dev/scripts/pappardelle';
	expect(isLocalMode(projectDir)).toBe(true);
});

test('isLocalMode: false when project dir matches the installed location', () => {
	const projectDir = path.join(homedir(), '.pappardelle', 'repo');
	expect(isLocalMode(projectDir)).toBe(false);
});

test('isLocalMode: false for a subdir of the installed location', () => {
	// Defensive — if for some reason we pass dist/ instead of the project root.
	const projectDir = path.join(homedir(), '.pappardelle', 'repo', 'dist');
	expect(isLocalMode(projectDir)).toBe(false);
});

// ============================================================================
// checkForUpdate orchestration (no network — uses a fresh cache to avoid it)
// ============================================================================

function setupFakeInstall(installed: string): {
	projectDir: string;
	cache: UpdateCheckDao;
} {
	// Build a fake installed tree under ~/.pappardelle/repo/ (in the run's
	// throwaway HOME) so LOCAL_MODE detection passes. git-init the fake dir so it
	// is its own git boundary: `git describe` finds this empty (untagged) repo
	// rather than any repository around it, returns null, and
	// resolveInstalledVersion falls back to the package.json below.
	const installedRoot = path.join(homedir(), '.pappardelle', 'repo');
	mkdirSync(installedRoot, {recursive: true});
	const dir = mkdtempSync(path.join(installedRoot, '_test-'));
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	initRepoWithTag(dir, null);
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({name: 'pappardelle', version: installed}),
	);
	return {
		projectDir: dir,
		cache: testState().daos.updateCheck,
	};
}

test('checkForUpdate: returns null when LOCAL_MODE', async () => {
	const dir = tempDir('pap-uc-');
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	const result = await checkForUpdate({
		projectDir: dir,
		cache: testState().daos.updateCheck,
	});
	expect(result).toBe(null);
});

test('checkForUpdate: returns null when cache says we are up to date', async () => {
	const fake = setupFakeInstall('0.1.0');
	await fake.cache.write({
		checkedAt: Date.now(),
		latestVersion: '0.1.0',
	});
	const result = await checkForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
	});
	expect(result).toBe(null);
});

test('checkForUpdate: surfaces update when cache shows a newer version', async () => {
	const fake = setupFakeInstall('0.1.0');
	await fake.cache.write({
		checkedAt: Date.now(),
		latestVersion: 'v0.2.0',
	});
	const result = await checkForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
	});
	expect(result).toStrictEqual({
		installedVersion: '0.1.0',
		latestVersion: 'v0.2.0',
	});
});

test('checkForUpdate: returns null when installed version is newer than cached', async () => {
	// Can happen if you manually bump package.json locally.
	const fake = setupFakeInstall('0.3.0');
	await fake.cache.write({
		checkedAt: Date.now(),
		latestVersion: '0.2.0',
	});
	const result = await checkForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
	});
	expect(result).toBe(null);
});

test('checkForUpdate: bypasses stale cache, calls fetchLatest, and rewrites the cache', async () => {
	const fake = setupFakeInstall('0.1.0');
	const now = 1_800_000_000_000;
	const STALE_TTL_MS = 25 * 60 * 60 * 1000;
	await fake.cache.write({
		checkedAt: now - STALE_TTL_MS,
		latestVersion: 'v0.1.0',
	});

	let fetchCalls = 0;
	const result = await checkForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
		now,
		async fetchLatest() {
			fetchCalls += 1;
			return 'v0.5.0';
		},
	});

	expect(fetchCalls, 'stub should be called exactly once').toBe(1);
	expect(result).toStrictEqual({
		installedVersion: '0.1.0',
		latestVersion: 'v0.5.0',
	});

	const refreshed = fake.cache.read();
	expect(
		refreshed,
		'cache should be rewritten with the new value and fresh timestamp',
	).toStrictEqual({checkedAt: now, latestVersion: 'v0.5.0'});
});

test('checkForUpdate: stale cache + fetchLatest returning null does not corrupt the cache', async () => {
	const fake = setupFakeInstall('0.1.0');
	const now = 1_800_000_000_000;
	const STALE_TTL_MS = 25 * 60 * 60 * 1000;
	const staleEntry: CacheEntry = {
		checkedAt: now - STALE_TTL_MS,
		latestVersion: 'v0.1.0',
	};
	await fake.cache.write(staleEntry);

	const result = await checkForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
		now,
		async fetchLatest() {
			return null;
		},
	});

	expect(result).toBe(null);
	expect(
		fake.cache.read(),
		'cache must not be overwritten when fetchLatest yields null',
	).toStrictEqual(staleEntry);
});

// ============================================================================
// safeCheckForUpdate contract — must never reject, regardless of input
// ============================================================================

test('safeCheckForUpdate: resolves to null for LOCAL_MODE', async () => {
	const dir = tempDir('pap-safe-');
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	const result = await safeCheckForUpdate({
		projectDir: dir,
		cache: testState().daos.updateCheck,
	});
	expect(result).toBe(null);
});

test('safeCheckForUpdate: swallows a throwing fetchLatest and resolves to null', async () => {
	const fake = setupFakeInstall('0.1.0');
	const now = 1_800_000_000_000;
	// No cache written — orchestrator will go straight to fetchLatest.
	const result = await safeCheckForUpdate({
		projectDir: fake.projectDir,
		cache: fake.cache,
		now,
		async fetchLatest() {
			throw new Error('boom');
		},
	});
	expect(result, 'the wrapper must not propagate the throw').toBe(null);
});
