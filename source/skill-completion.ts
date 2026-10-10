import {Buffer} from 'node:buffer';
import os from 'node:os';
import type {Dirent} from 'node:fs';
import fs, {type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {getRepoRoot} from './config.ts';

/**
 * Slash-command autocomplete for the "+ New Session" prompt.
 *
 * The prompt has always accepted free text, and the thing Charlie types most
 * often is a Claude skill invocation. Remembering the exact hyphenation of one
 * of ~170 installed skills is the friction this removes: the moment the prompt
 * opens with `/`, the Profile box gives way to a list of every skill and
 * command on disk, narrowed as you type.
 *
 * The completion is a typing aid and nothing more. It never rewrites the
 * submitted text, never changes which profile a prompt matches, and never
 * fires for a prompt that does not begin with `/`, so an issue key, a bare
 * number, and a plain description all behave exactly as they did before.
 *
 * Every function here is pure or takes its roots as arguments, so the ranking,
 * the trigger rule, and the on-disk scan are all testable without Ink.
 */

/** Rows of the skill picker visible at once. Matches the profile picker's feel. */
export const SKILL_PICKER_MAX_VISIBLE = 6;

export type SkillEntry = {
	/** Invocation name without the leading slash, e.g. `do-pappardelle`. */
	name: string;
	/** First line of the frontmatter `description:`, or '' when absent. */
	description: string;
	/** At equal match quality, repo outranks user, which outranks plugin. */
	source: 'repo' | 'user' | 'plugin';
	kind: 'skill' | 'command';
};

const SOURCE_RANK: Record<SkillEntry['source'], number> = {
	repo: 0,
	user: 1,
	plugin: 2,
};

/**
 * The token the completion list is currently narrowing on, or null when the
 * list should be closed.
 *
 * The rule is deliberately strict (a leading `/` and no whitespace anywhere)
 * because it is the only thing standing between this feature and a prompt that
 * behaves differently than it did on master. Once you type a space the first
 * token is finished, so the list closes and stays closed for the rest of the
 * prompt.
 */
export function skillQuery(value: string): string | null {
	const match = /^\/(\S*)$/.exec(value);
	return match ? match[1]! : null;
}

/** The text the prompt holds after a completion is accepted. */
export function applySkillCompletion(name: string): string {
	return `/${name} `;
}

/**
 * How many leading characters of the prompt spell a skill the user has, or 0.
 *
 * The prompt paints that run in its own color, so the color is a claim about
 * the name: it appears only when the token matches an installed skill or
 * command exactly. A half-typed name stays plain until it is real, which turns
 * the color into the confirmation that the completion list stops giving you the
 * moment you type past it.
 *
 * Unlike `skillQuery` this keeps reading after the first space, because the
 * skill name is still the skill name once you start describing the task.
 */
export function skillTokenLength(
	value: string,
	entries: readonly SkillEntry[],
): number {
	const match = /^\/(\S+)/.exec(value);
	if (!match) return 0;
	const token = match[1]!;
	return entries.some(candidate => candidate.name === token)
		? token.length + 1
		: 0;
}

/**
 * Rank entries for the given query.
 *
 * Two tiers only: names that start with the query, then names that merely
 * contain it. Descriptions are deliberately not searched. A query like `hive`
 * matching a skill because some unrelated skill mentions the word in prose
 * makes the list unpredictable when what you want is the name you half
 * remember.
 */
export function matchSkills(
	entries: readonly SkillEntry[],
	query: string,
): SkillEntry[] {
	const needle = query.toLowerCase();

	const tier = (entry: SkillEntry): number => {
		if (!needle) return 0;
		const name = entry.name.toLowerCase();
		if (name.startsWith(needle)) return 0;
		if (name.includes(needle)) return 1;
		return -1;
	};

	return entries
		.map((entry, index) => ({entry, index, tier: tier(entry)}))
		.filter(row => row.tier >= 0)
		.sort((a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			const sourceRank = (entry: SkillEntry) => SOURCE_RANK[entry.source];
			const bySource = sourceRank(a.entry) - sourceRank(b.entry);
			if (bySource !== 0) return bySource;
			// Stable within a tier: preserve discovery order (name-sorted).
			return a.index - b.index;
		})
		.map(row => row.entry);
}

/**
 * The row the picker should both highlight and hand to `Enter`.
 *
 * The list re-ranks on every keystroke while the text input still has focus, so
 * a selection parked deep in a long list can end up pointing past the end of a
 * short one. Rendering and acceptance have to run the index through this same
 * call, or `Enter` highlights one row and accepts nothing.
 */
export function clampSelection(selectedIndex: number, total: number): number {
	if (selectedIndex < 0 || selectedIndex >= total) return 0;
	return selectedIndex;
}

export type SkillPickerKeyResult = {
	action: 'move' | 'accept' | 'close' | 'ignore';
	index: number;
};

type SkillPickerKey = {
	upArrow?: boolean;
	downArrow?: boolean;
	escape?: boolean;
	tab?: boolean;
};

/**
 * The keymap while the text input still owns the cursor.
 *
 * Tab is the accept key here, because it is the one key a prompt can spare:
 * every printable character has to reach the input, and Enter is spoken for.
 * `j`/`k` are pointedly absent for the same reason. Enter is absent because it
 * arrives through the text input's own submit path, where the dialog hands the
 * list its focus instead.
 */
export function handleSkillPickerKey(
	key: SkillPickerKey,
	selectedIndex: number,
	total: number,
): SkillPickerKeyResult {
	if (key.escape) {
		return {action: 'close', index: selectedIndex};
	}

	if (key.tab) {
		if (total <= 0) return {action: 'ignore', index: selectedIndex};
		return {action: 'accept', index: selectedIndex};
	}

	if (key.upArrow) {
		return {action: 'move', index: Math.max(0, selectedIndex - 1)};
	}

	if (key.downArrow) {
		return {action: 'move', index: Math.min(total - 1, selectedIndex + 1)};
	}

	return {action: 'ignore', index: selectedIndex};
}

export type SkillListKeyResult = {
	action: 'move' | 'accept' | 'back' | 'ignore';
	index: number;
};

type SkillListKey = SkillPickerKey & {return?: boolean};

/**
 * The keymap once Enter has moved the focus into the list.
 *
 * The text input is frozen for as long as this is the active map, which is what
 * buys `j`/`k` and Enter back: no keystroke here has to reach the prompt. Esc
 * returns the focus without closing the list, so the two Esc presses that
 * follow still mean "dismiss the list" and "cancel the dialog", in that order.
 */
export function handleSkillListKey(
	input: string,
	key: SkillListKey,
	selectedIndex: number,
	total: number,
): SkillListKeyResult {
	if (key.escape) {
		return {action: 'back', index: selectedIndex};
	}

	if (key.return || key.tab) {
		if (total <= 0) return {action: 'ignore', index: selectedIndex};
		return {action: 'accept', index: selectedIndex};
	}

	if (key.upArrow || input === 'k') {
		return {action: 'move', index: Math.max(0, selectedIndex - 1)};
	}

	if (key.downArrow || input === 'j') {
		return {action: 'move', index: Math.min(total - 1, selectedIndex + 1)};
	}

	return {action: 'ignore', index: selectedIndex};
}

export type Frontmatter = {
	/** The `description:` value, or '' when absent. */
	description: string;
	/** False when the file sets `user-invocable: false`. */
	userInvocable: boolean;
};

/**
 * Pull the keys the picker needs out of a Claude markdown frontmatter block.
 *
 * Hand-rolled rather than routed through js-yaml because a malformed SKILL.md
 * should cost that one entry its blurb, not throw the whole list away, and
 * because only two scalar keys are ever wanted.
 */
export function parseFrontmatter(contents: string): Frontmatter {
	const result: Frontmatter = {description: '', userInvocable: true};
	const match = /^---\r?\n([\S\s]*?)\r?\n---/.exec(contents);
	if (!match) return result;
	let seenDescription = false;
	for (const line of match[1]!.split('\n')) {
		const field = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (!field) continue;
		const value = field[2]!.trim().replace(/^["']|["']$/g, '');
		if (field[1] === 'description' && !seenDescription) {
			seenDescription = true;
			result.description = value;
		} else if (field[1] === 'user-invocable') {
			result.userInvocable = value !== 'false';
		}
	}

	return result;
}

/**
 * Each in-flight read or listing holds a descriptor, and past macOS's OPEN_MAX
 * of 10240 every `spawn` in the app fails with EBADF.
 */
const SKILL_FS_CONCURRENCY = 32;

type Limit = <T>(task: () => Promise<T>) => Promise<T>;

function createLimit(concurrency: number): Limit {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async task => {
		if (active < concurrency) {
			active++;
		} else {
			await new Promise<void>(resolve => {
				waiting.push(resolve);
			});
		}

		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

const FRONTMATTER_CHARS = 4096;

async function readFrontmatter(file: string): Promise<Frontmatter> {
	let handle: FileHandle;
	try {
		handle = await fs.open(file, 'r');
	} catch {
		return parseFrontmatter('');
	}

	try {
		// Frontmatter lives at the top; skills run to thousands of lines. The
		// window is 4096 characters, and a UTF-8 character is at most 4 bytes.
		const buffer = Buffer.allocUnsafe(FRONTMATTER_CHARS * 4);
		const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
		return parseFrontmatter(
			buffer
				.subarray(0, bytesRead)
				.toString('utf8')
				.slice(0, FRONTMATTER_CHARS),
		);
	} catch {
		return parseFrontmatter('');
	} finally {
		await handle.close().catch(() => undefined);
	}
}

type Candidate = {
	name: string;
	file: string;
	kind: SkillEntry['kind'];
};

async function readEntries(dir: string, limit: Limit): Promise<Dirent[]> {
	try {
		return await limit(async () => fs.readdir(dir, {withFileTypes: true}));
	} catch {
		return [];
	}
}

/** Resolves a symlink to what it points at, or undefined when it dangles. */
async function entryKind(
	item: Dirent,
	full: string,
): Promise<'directory' | 'file' | undefined> {
	if (item.isDirectory()) return 'directory';
	if (item.isFile()) return 'file';
	if (!item.isSymbolicLink()) return undefined;
	try {
		const stats = await fs.stat(full);
		if (stats.isDirectory()) return 'directory';
		return stats.isFile() ? 'file' : undefined;
	} catch {
		return undefined;
	}
}

async function listSkillCandidates(
	dir: string,
	limit: Limit,
): Promise<Candidate[]> {
	const items = await readEntries(dir, limit);
	return items
		.filter(item => item.isDirectory() || item.isSymbolicLink())
		.map(item => ({
			name: item.name,
			file: path.join(dir, item.name, 'SKILL.md'),
			kind: 'skill',
		}));
}

/**
 * Commands nest, and Claude addresses a nested one with a colon: a file at
 * `commands/db/reset.md` is `/db:reset`. Mirroring that here keeps an accepted
 * completion something you can actually run.
 *
 * Symlinked directories are followed, so a link back to an ancestor would
 * recurse forever without the check against the real paths above it.
 */
async function listCommandCandidates(
	dir: string,
	limit: Limit,
	prefix = '',
	ancestors: ReadonlySet<string> = new Set(),
): Promise<Candidate[]> {
	let real: string;
	try {
		real = await fs.realpath(dir);
	} catch {
		return [];
	}

	if (ancestors.has(real)) return [];
	const lineage = new Set(ancestors).add(real);

	const items = await readEntries(dir, limit);
	const nested = await Promise.all(
		items.map(async (item): Promise<Candidate[]> => {
			const full = path.join(dir, item.name);
			const kind = await entryKind(item, full);
			if (kind === 'directory') {
				return listCommandCandidates(
					full,
					limit,
					`${prefix}${item.name}:`,
					lineage,
				);
			}

			if (kind === 'file' && item.name.endsWith('.md')) {
				return [
					{
						name: `${prefix}${item.name.slice(0, -3)}`,
						file: full,
						kind: 'command',
					},
				];
			}

			return [];
		}),
	);
	return nested.flat();
}

async function readCandidates(
	candidates: Candidate[],
	source: SkillEntry['source'],
	limit: Limit,
): Promise<SkillEntry[]> {
	const entries = await Promise.all(
		candidates.map(
			async (candidate): Promise<SkillEntry | undefined> =>
				limit(async () => {
					if (candidate.kind === 'skill') {
						try {
							await fs.access(candidate.file);
						} catch {
							return undefined;
						}
					}

					const frontmatter = await readFrontmatter(candidate.file);
					if (!frontmatter.userInvocable) return undefined;
					return {
						name: candidate.name,
						description: frontmatter.description,
						source,
						kind: candidate.kind,
					};
				}),
		),
	);
	return entries
		.filter(entry => entry !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export type SkillRoots = {repoRoot: string; homeDir: string};

async function scanScope(
	root: string,
	source: SkillEntry['source'],
	limit: Limit,
): Promise<SkillEntry[]> {
	const claude = path.join(root, '.claude');
	const [skills, commands] = await Promise.all([
		listSkillCandidates(path.join(claude, 'skills'), limit),
		listCommandCandidates(path.join(claude, 'commands'), limit),
	]);
	return readCandidates([...skills, ...commands], source, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Plugin keys (`name@marketplace`) switched on for this repo. Claude layers
 * `enabledPlugins` from the user settings, then the repo's shared settings,
 * then its local ones, with the later file winning per key.
 */
async function enabledPluginKeys(roots: SkillRoots): Promise<Set<string>> {
	const layers = await Promise.all(
		[
			path.join(roots.homeDir, '.claude', 'settings.json'),
			path.join(roots.repoRoot, '.claude', 'settings.json'),
			path.join(roots.repoRoot, '.claude', 'settings.local.json'),
		].map(async file => readJson(file)),
	);
	const merged: Record<string, unknown> = {};
	for (const layer of layers) {
		if (isRecord(layer) && isRecord(layer['enabledPlugins'])) {
			Object.assign(merged, layer['enabledPlugins']);
		}
	}

	return new Set(Object.keys(merged).filter(key => merged[key] === true));
}

type Plugin = {key: string; installPath: string};

/**
 * An install with a `projectPath` belongs to that one project; the rest are
 * installed for the user and apply everywhere.
 */
async function enabledPlugins(roots: SkillRoots): Promise<Plugin[]> {
	const [installed, enabled] = await Promise.all([
		readJson(
			path.join(roots.homeDir, '.claude', 'plugins', 'installed_plugins.json'),
		),
		enabledPluginKeys(roots),
	]);
	const plugins =
		isRecord(installed) && isRecord(installed['plugins'])
			? installed['plugins']
			: {};

	const result: Plugin[] = [];
	for (const [key, installs] of Object.entries(plugins)) {
		if (!enabled.has(key) || !Array.isArray(installs)) continue;
		const install: unknown = installs.find(
			candidate =>
				isRecord(candidate) &&
				typeof candidate['installPath'] === 'string' &&
				(candidate['projectPath'] === undefined ||
					candidate['projectPath'] === roots.repoRoot),
		);
		if (isRecord(install)) {
			result.push({key, installPath: install['installPath'] as string});
		}
	}

	return result;
}

function manifestPaths(
	manifest: unknown,
	field: 'skills' | 'commands',
	installPath: string,
): string[] {
	const value = isRecord(manifest) ? manifest[field] : undefined;
	const list =
		typeof value === 'string'
			? [value]
			: Array.isArray(value)
				? value.filter(item => typeof item === 'string')
				: [];
	return list.map(item => path.resolve(installPath, item));
}

/**
 * A plugin's manifest can point at extra skill and command paths on top of
 * the default `skills/` and `commands/` directories. A skill path is either a
 * skill itself (it holds a SKILL.md) or a directory of skills; a command path
 * is a markdown file or a directory of them.
 */
async function pluginCandidates(
	plugin: Plugin,
	limit: Limit,
): Promise<Candidate[]> {
	const manifest = await readJson(
		path.join(plugin.installPath, '.claude-plugin', 'plugin.json'),
	);
	const name =
		isRecord(manifest) && typeof manifest['name'] === 'string'
			? manifest['name']
			: plugin.key.split('@')[0]!;

	const skillPaths = new Set([
		path.join(plugin.installPath, 'skills'),
		...manifestPaths(manifest, 'skills', plugin.installPath),
	]);
	const commandPaths = new Set([
		path.join(plugin.installPath, 'commands'),
		...manifestPaths(manifest, 'commands', plugin.installPath),
	]);

	const found = await Promise.all([
		...[...skillPaths].map(async dir => {
			const file = path.join(dir, 'SKILL.md');
			try {
				await fs.access(file);
				const skill: Candidate = {
					name: path.basename(dir),
					file,
					kind: 'skill',
				};
				return [skill];
			} catch {
				return listSkillCandidates(dir, limit);
			}
		}),
		...[...commandPaths].map(async target => {
			if (!target.endsWith('.md')) return listCommandCandidates(target, limit);
			const command: Candidate = {
				name: path.basename(target, '.md'),
				file: target,
				kind: 'command',
			};
			return [command];
		}),
	]);
	return found.flat().map(candidate => ({
		...candidate,
		name: `${name}:${candidate.name}`,
	}));
}

async function scanPlugins(
	roots: SkillRoots,
	limit: Limit,
): Promise<SkillEntry[]> {
	const plugins = await enabledPlugins(roots);
	const candidates = await Promise.all(
		plugins.map(async plugin => pluginCandidates(plugin, limit)),
	);
	return readCandidates(candidates.flat(), 'plugin', limit);
}

/**
 * Every skill and command Claude could invoke from this worktree: repo
 * entries, then user entries, then enabled plugins', each group sorted by name.
 *
 * A repo entry hides a user entry of the same name, matching how Claude itself
 * resolves the two scopes: the more specific definition is the one that runs,
 * so it is the only one worth offering. Plugin entries carry their plugin's
 * name as a prefix, so they never collide with either.
 */
export async function discoverSkills(roots: SkillRoots): Promise<SkillEntry[]> {
	const limit = createLimit(SKILL_FS_CONCURRENCY);
	const scopes = await Promise.all([
		scanScope(roots.repoRoot, 'repo', limit),
		scanScope(roots.homeDir, 'user', limit),
		scanPlugins(roots, limit),
	]);

	const seen = new Set<string>();
	const result: SkillEntry[] = [];
	for (const entry of scopes.flat()) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		result.push(entry);
	}

	return result;
}

export type SkillSnapshot = {
	/** The last completed scan for these roots, or undefined before one lands. */
	current(roots: SkillRoots): SkillEntry[] | undefined;
	refresh(roots: SkillRoots): Promise<SkillEntry[]>;
};

/**
 * The last scan, kept across dialog opens so the prompt can offer completions
 * on its first frame while a rescan picks up skills installed since.
 */
export function createSkillSnapshot(
	discover: (roots: SkillRoots) => Promise<SkillEntry[]> = discoverSkills,
): SkillSnapshot {
	const keyFor = (roots: SkillRoots) => `${roots.repoRoot}\0${roots.homeDir}`;
	let stored: {key: string; entries: SkillEntry[]} | undefined;
	let inFlight: {key: string; promise: Promise<SkillEntry[]>} | undefined;

	const current = (roots: SkillRoots) =>
		stored?.key === keyFor(roots) ? stored.entries : undefined;

	return {
		current,
		async refresh(roots) {
			const key = keyFor(roots);
			if (inFlight?.key === key) return inFlight.promise;

			const promise: Promise<SkillEntry[]> = Promise.resolve()
				.then(async () => discover(roots))
				.then(entries => {
					if (inFlight?.promise === promise) stored = {key, entries};
					return entries;
				})
				.catch(() => current(roots) ?? [])
				.finally(() => {
					if (inFlight?.promise === promise) inFlight = undefined;
				});
			inFlight = {key, promise};
			return promise;
		},
	};
}

export const skillSnapshot = createSkillSnapshot();

export function skillRoots(): SkillRoots | null {
	try {
		return {repoRoot: getRepoRoot(), homeDir: os.homedir()};
	} catch {
		return null;
	}
}

/**
 * Where the highlight belongs after the skill list changes under it. The
 * rescan can land while a row is highlighted, and a newly installed skill
 * sorting ahead would otherwise shift a different skill under the same index,
 * so Tab would accept something the user never saw highlighted.
 */
export function reanchorSelection(
	highlightedName: string | undefined,
	entries: readonly SkillEntry[],
): number {
	const index = entries.findIndex(entry => entry.name === highlightedName);
	return Math.max(index, 0);
}
