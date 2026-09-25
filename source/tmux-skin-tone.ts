import {spawnSync} from 'node:child_process';
import {stripSkinTones} from './emoji-rail-width.ts';
import {isInTmux} from './tmux.ts';

// tmux 3.6 draws an emoji plus a Fitzpatrick skin-tone modifier (💪🏼) as
// two wide glyphs, 4 cells, while Ink and outer terminals draw the grapheme
// as 2 cells. A row laid out for 2 cells then runs 2 cells past the pane and
// the rail icons wrap. The combining-order fix (tmux/tmux#4726) landed in
// 3.6a; every release from 3.6a on agrees with Ink.
//
// 3.5 and earlier predate the regression, so only a bare 3.6 needs the
// modifiers stripped.

let skinToneWide: boolean | null = null;
let probe = queryTmuxVersion;

export function queryTmuxVersion(): string | null {
	try {
		const result = spawnSync('tmux', ['display-message', '-p', '#{version}'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		if (result.error || result.status !== 0) {
			return null;
		}
		const version = result.stdout.trim();
		return version === '' ? null : version;
	} catch {
		return null;
	}
}

function isBare36(version: string): boolean {
	const match = version.match(/(\d+)\.(\d+)([a-z])?/);
	return (
		match !== null &&
		match[1] === '3' &&
		match[2] === '6' &&
		match[3] === undefined
	);
}

/**
 * True only when the TUI runs inside tmux 3.6, the release that draws
 * skin-tone modifiers as extra wide glyphs.
 */
export function tmuxDrawsSkinToneWide(): boolean {
	if (skinToneWide !== null) return skinToneWide;
	if (!isInTmux()) {
		skinToneWide = false;
		return false;
	}
	const version = probe();
	// An unreadable version cannot be confirmed as the broken release, and
	// every other known release draws the grapheme correctly.
	skinToneWide = version !== null && isBare36(version);
	return skinToneWide;
}

/** Strip skin-tone modifiers only when the running tmux mis-draws them. */
export function maybeStripSkinTones(text: string): string;
export function maybeStripSkinTones(text: undefined): undefined;
export function maybeStripSkinTones(
	text: string | undefined,
): string | undefined;
export function maybeStripSkinTones(
	text: string | undefined,
): string | undefined {
	if (text === undefined) return undefined;
	return tmuxDrawsSkinToneWide() ? stripSkinTones(text) : text;
}

/** Override the version probe and clear the cache (for tests). */
export function setTmuxVersionProbeForTests(
	next: (() => string | null) | null,
): void {
	probe = next ?? queryTmuxVersion;
	skinToneWide = null;
}
