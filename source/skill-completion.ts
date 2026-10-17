import fs from 'node:fs';
import path from 'node:path';

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
	/** Repo entries outrank user entries of equal match quality. */
	source: 'repo' | 'user';
	kind: 'skill' | 'command';
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
			const sourceRank = (entry: SkillEntry) =>
				entry.source === 'repo' ? 0 : 1;
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

/**
 * Pull the `description:` out of a Claude markdown frontmatter block.
 *
 * Hand-rolled rather than routed through js-yaml because a malformed SKILL.md
 * should cost that one entry its blurb, not throw the whole list away, and
 * because only one scalar key is ever wanted.
 */
export function parseFrontmatterDescription(contents: string): string {
	const match = /^---\r?\n([\S\s]*?)\r?\n---/.exec(contents);
	if (!match) return '';
	for (const line of match[1]!.split('\n')) {
		const field = /^description:\s*(.*)$/.exec(line.trim());
		if (field) {
			return field[1]!.trim().replace(/^["']|["']$/g, '');
		}
	}
	return '';
}

function readDescription(file: string): string {
	try {
		// Frontmatter lives at the top; skills run to thousands of lines.
		return parseFrontmatterDescription(
			fs.readFileSync(file, 'utf8').slice(0, 4096),
		);
	} catch {
		return '';
	}
}

function scanSkillDir(dir: string, source: SkillEntry['source']): SkillEntry[] {
	let names: string[];
	try {
		names = fs
			.readdirSync(dir, {withFileTypes: true})
			.filter(item => item.isDirectory() || item.isSymbolicLink())
			.map(item => item.name);
	} catch {
		return [];
	}

	const found: SkillEntry[] = [];
	for (const name of names) {
		const file = path.join(dir, name, 'SKILL.md');
		if (!fs.existsSync(file)) continue;
		found.push({
			name,
			description: readDescription(file),
			source,
			kind: 'skill',
		});
	}
	return found;
}

/**
 * Commands nest, and Claude addresses a nested one with a colon: a file at
 * `commands/db/reset.md` is `/db:reset`. Mirroring that here keeps an accepted
 * completion something you can actually run.
 */
function scanCommandDir(
	dir: string,
	source: SkillEntry['source'],
	prefix = '',
): SkillEntry[] {
	let items: fs.Dirent[];
	try {
		items = fs.readdirSync(dir, {withFileTypes: true});
	} catch {
		return [];
	}

	const found: SkillEntry[] = [];
	for (const item of items) {
		const full = path.join(dir, item.name);
		if (item.isDirectory()) {
			found.push(...scanCommandDir(full, source, `${prefix}${item.name}:`));
		} else if (item.isFile() && item.name.endsWith('.md')) {
			found.push({
				name: `${prefix}${item.name.slice(0, -3)}`,
				description: readDescription(full),
				source,
				kind: 'command',
			});
		}
	}
	return found;
}

/**
 * Every skill and command Claude could invoke from this worktree, repo entries
 * first and each group sorted by name.
 *
 * A repo entry hides a user entry of the same name, matching how Claude itself
 * resolves the two scopes: the more specific definition is the one that runs,
 * so it is the only one worth offering.
 */
export function discoverSkills(roots: {
	repoRoot: string;
	homeDir: string;
}): SkillEntry[] {
	const byScope: Array<[string, SkillEntry['source']]> = [
		[roots.repoRoot, 'repo'],
		[roots.homeDir, 'user'],
	];

	const seen = new Set<string>();
	const result: SkillEntry[] = [];

	for (const [root, source] of byScope) {
		const claude = path.join(root, '.claude');
		const scoped = [
			...scanSkillDir(path.join(claude, 'skills'), source),
			...scanCommandDir(path.join(claude, 'commands'), source),
		].sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of scoped) {
			if (seen.has(entry.name)) continue;
			seen.add(entry.name);
			result.push(entry);
		}
	}

	return result;
}
