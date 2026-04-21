import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createLogger} from './logger.ts';

const log = createLogger('update-check');

const RELEASES_API_URL =
	'https://api.github.com/repos/chardigio/pappardelle/releases/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const HTTP_TIMEOUT_MS = 3000;

export type Semver = {major: number; minor: number; patch: number};

export type CacheEntry = {
	checkedAt: number;
	latestVersion: string;
};

export type UpdateInfo = {
	installedVersion: string;
	latestVersion: string;
};

// ============================================================================
// Pure version helpers
// ============================================================================

export function parseSemver(version: string): Semver | null {
	if (!version) return null;
	const stripped = version.replace(/^[vV]/, '');
	const match = stripped.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return null;
	return {
		major: Number.parseInt(match[1]!, 10),
		minor: Number.parseInt(match[2]!, 10),
		patch: Number.parseInt(match[3]!, 10),
	};
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;
	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
	return 0;
}

// ============================================================================
// package.json + cache IO
// ============================================================================

export function readInstalledVersion(pkgJsonPath: string): string | null {
	try {
		const raw = readFileSync(pkgJsonPath, 'utf8');
		const parsed = JSON.parse(raw) as {version?: unknown};
		if (typeof parsed.version === 'string' && parsed.version.length > 0) {
			return parsed.version;
		}
		return null;
	} catch {
		return null;
	}
}

// The installed version is whatever semver tag is reachable from HEAD in the
// cloned pappardelle repo. Releases live on chardigio/pappardelle as
// `vX.Y.Z` tags (package.json is not bumped on release — see release.yml).
// Returns null if not a git repo, git is missing, or HEAD has no reachable
// semver tag (e.g. a fresh install before the first release has landed).
export function readInstalledVersionFromGit(projectDir: string): string | null {
	try {
		const out = execFileSync(
			'git',
			[
				'-C',
				projectDir,
				'describe',
				'--tags',
				'--abbrev=0',
				'--match',
				'v*.*.*',
			],
			{encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']},
		).trim();
		return out || null;
	} catch {
		return null;
	}
}

// Combined lookup used by the orchestrator: prefer the git tag (source of
// truth) and fall back to package.json so that pre-release installs still
// report something useful in the help overlay.
export function resolveInstalledVersion(projectDir: string): string | null {
	return (
		readInstalledVersionFromGit(projectDir) ??
		readInstalledVersion(path.join(projectDir, 'package.json'))
	);
}

export function readCachedCheck(cachePath: string): CacheEntry | null {
	try {
		const raw = readFileSync(cachePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<CacheEntry>;
		if (
			typeof parsed.checkedAt === 'number' &&
			typeof parsed.latestVersion === 'string'
		) {
			return {checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion};
		}
		return null;
	} catch {
		return null;
	}
}

export function writeCachedCheck(cachePath: string, entry: CacheEntry): void {
	try {
		mkdirSync(path.dirname(cachePath), {recursive: true});
		writeFileSync(cachePath, JSON.stringify(entry, null, 2));
	} catch (err) {
		log.warn(
			`Failed to write update-check cache: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ============================================================================
// LOCAL_MODE detection
// ============================================================================

// Pappardelle ships as a clone at ~/.pappardelle/repo/. When running from the
// monorepo (or any other directory), we're in LOCAL_MODE and must skip the
// update prompt — the monorepo is the source of truth, and curl | bash would
// clobber unpushed work.
export function isLocalMode(projectDir: string): boolean {
	const installedRoot = path.join(homedir(), '.pappardelle', 'repo');
	const normalizedProject = path.resolve(projectDir);
	return (
		normalizedProject !== installedRoot &&
		!normalizedProject.startsWith(installedRoot + path.sep)
	);
}

// ============================================================================
// Network
// ============================================================================

async function fetchLatestVersion(): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	try {
		const res = await fetch(RELEASES_API_URL, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'pappardelle-update-check',
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			log.warn(`GitHub Releases API returned ${res.status}`);
			return null;
		}
		const data = (await res.json()) as {tag_name?: unknown};
		if (typeof data.tag_name === 'string' && data.tag_name.length > 0) {
			return data.tag_name;
		}
		return null;
	} catch (err) {
		log.warn(
			`Update check network error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ============================================================================
// Orchestration
// ============================================================================

export type CheckForUpdateOptions = {
	projectDir: string;
	cachePath?: string;
	now?: number;
	// Injectable for tests. Defaults to `fetchLatestVersion`, which hits
	// api.github.com. Passing a stub here lets tests exercise the
	// stale-cache → fetch branch without going over the network.
	fetchLatest?: () => Promise<string | null>;
};

// Wrapper that never rejects. Use this from `cli.tsx` so render() is not
// blocked on the network and a flaky GitHub response can't crash startup.
export async function safeCheckForUpdate(
	opts: CheckForUpdateOptions,
): Promise<UpdateInfo | null> {
	try {
		return await checkForUpdate(opts);
	} catch (err) {
		log.warn(
			`Update check failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export async function checkForUpdate(
	opts: CheckForUpdateOptions,
): Promise<UpdateInfo | null> {
	if (isLocalMode(opts.projectDir)) {
		log.info('Update check skipped: LOCAL_MODE');
		return null;
	}

	const installedVersion = resolveInstalledVersion(opts.projectDir);
	if (!installedVersion) {
		log.warn('Update check skipped: could not read installed version');
		return null;
	}

	const cachePath =
		opts.cachePath ?? path.join(homedir(), '.pappardelle', 'update-check.json');
	const now = opts.now ?? Date.now();

	const fetchLatest = opts.fetchLatest ?? fetchLatestVersion;

	let latestVersion: string | null = null;
	const cached = readCachedCheck(cachePath);
	if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
		latestVersion = cached.latestVersion;
	} else {
		latestVersion = await fetchLatest();
		if (latestVersion) {
			writeCachedCheck(cachePath, {checkedAt: now, latestVersion});
		}
	}

	if (!latestVersion) return null;
	if (compareSemver(installedVersion, latestVersion) >= 0) return null;

	return {installedVersion, latestVersion};
}

export function pappardelleInstallCommand(): string {
	return 'curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash';
}

// Exported only for tests — ensures the test file sees the cache dir constant.
export const _INTERNAL = {
	RELEASES_API_URL,
	CACHE_TTL_MS,
	HTTP_TIMEOUT_MS,
};
