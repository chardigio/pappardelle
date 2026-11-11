import {useSyncExternalStore} from 'react';
import {stripSkinTones} from './emoji-rail-width.ts';
import {isInTmux} from './tmux.ts';
import {parseTmuxVersion, readTmuxVersion} from './tmux-version.ts';

// tmux 3.6 draws an emoji plus a Fitzpatrick skin-tone modifier (💪🏼) as
// two wide glyphs, 4 cells, while OpenTUI lays the grapheme out as 2 cells and
// outer terminals draw it as 2. A row laid out for 2 cells then runs 2 cells
// past the pane and the rail icons wrap. The combining-order fix
// (tmux/tmux#4726) landed in 3.6a; every release from 3.6a on agrees with
// OpenTUI.
//
// 3.5 and earlier predate the regression, so only a bare 3.6 needs the
// modifiers stripped.

let skinToneWide = false;
let resolution: Promise<void> | undefined;
let probe = queryTmuxVersion;
const listeners = new Set<() => void>();

async function queryTmuxVersion(): Promise<string | null> {
	const read = await readTmuxVersion();
	return read?.version ?? null;
}

function isBare36(version: string): boolean {
	const release = parseTmuxVersion(version);
	return (
		release?.major === 3 && release.minor === 6 && release.letter === undefined
	);
}

/**
 * Probe the running tmux once per process. Until it answers, rows keep the
 * modifiers, since only one release mis-draws them.
 */
export async function resolveTmuxSkinTone(): Promise<void> {
	resolution ??= (async () => {
		if (!isInTmux()) return;
		const version = await probe();
		// An unreadable version cannot be confirmed as the broken release, and
		// every other known release draws the grapheme correctly.
		if (version === null || !isBare36(version)) return;
		skinToneWide = true;
		for (const listener of listeners) listener();
	})();
	return resolution;
}

/**
 * True only once the TUI is known to run inside tmux 3.6, the release that
 * draws skin-tone modifiers as extra wide glyphs.
 */
export function tmuxDrawsSkinToneWide(): boolean {
	return skinToneWide;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	void resolveTmuxSkinTone();
	return () => {
		listeners.delete(listener);
	};
}

/** Re-renders the caller once the tmux version is known. */
export function useTmuxSkinToneWide(): boolean {
	return useSyncExternalStore(subscribe, tmuxDrawsSkinToneWide);
}

/** Strip skin-tone modifiers only when the running tmux mis-draws them. */
export function maybeStripSkinTones(text: string, wide: boolean): string;
export function maybeStripSkinTones(text: undefined, wide: boolean): undefined;
export function maybeStripSkinTones(
	text: string | undefined,
	wide: boolean,
): string | undefined;
export function maybeStripSkinTones(
	text: string | undefined,
	wide: boolean,
): string | undefined {
	if (text === undefined) return undefined;
	return wide ? stripSkinTones(text) : text;
}

/** Override the version probe and clear the cache (for tests). */
export function setTmuxVersionProbeForTests(
	next: (() => Promise<string | null>) | null,
): void {
	probe = next ?? queryTmuxVersion;
	skinToneWide = false;
	resolution = undefined;
}
