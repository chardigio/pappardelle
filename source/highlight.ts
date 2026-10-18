// Cross-terminal highlight IPC
// Allows `pappardelle highlight STA-XXX` to select a row in a running TUI.
// Uses a file-based IPC mechanism: the CLI writes an issue key to
// ~/.pappardelle/repos/{repoName}/highlight-target, and the running app
// watches for changes via fs.watch(). With `--focus` the line also carries
// FOCUS_MARKER, and the rail moves focus to the space's agent pane.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	watch,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {shellQuote} from './shell-quote.ts';
import type {SpaceData} from './types.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');
const FOCUS_MARKER = 'focus';

export type HighlightRequest = {issueKey: string; focus: boolean};

function serializeRequest({issueKey, focus}: HighlightRequest): string {
	return focus ? `${issueKey}\t${FOCUS_MARKER}` : issueKey;
}

function parseRequest(content: string): HighlightRequest | null {
	const [issueKey, marker] = content.trim().split('\t');
	if (!issueKey) return null;
	return {issueKey, focus: marker === FOCUS_MARKER};
}

/**
 * Get the path to the highlight target file for a repo.
 */
export function getHighlightFilePath(
	repoName: string,
	baseDir?: string,
): string {
	const base = baseDir ?? DEFAULT_BASE_DIR;
	return path.join(base, 'repos', repoName, 'highlight-target');
}

/**
 * Write a highlight request to the highlight target file.
 * Called by `pappardelle highlight STA-XXX` from another terminal.
 */
export function writeHighlightTarget(
	repoName: string,
	request: HighlightRequest,
	baseDir?: string,
): void {
	const filePath = getHighlightFilePath(repoName, baseDir);
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, serializeRequest(request) + '\n');
}

/**
 * The shell form of writeHighlightTarget, for the sous-chef key binding to run
 * from tmux without starting Pappardelle. Its output and failures are dropped:
 * either would put the pane the key was pressed in into view mode.
 */
export function highlightWriteCommand(
	repoName: string,
	request: HighlightRequest,
	baseDir?: string,
): string {
	const line = shellQuote(serializeRequest(request));
	const file = shellQuote(getHighlightFilePath(repoName, baseDir));
	return `printf '%s\\n' ${line} > ${file} 2>/dev/null || true`;
}

/**
 * Read the current highlight request.
 * Returns null if no file exists.
 */
export function readHighlightTarget(
	repoName: string,
	baseDir?: string,
): HighlightRequest | null {
	const filePath = getHighlightFilePath(repoName, baseDir);
	try {
		if (!existsSync(filePath)) return null;
		return parseRequest(readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Remove the highlight target file.
 */
export function clearHighlightTarget(repoName: string, baseDir?: string): void {
	const filePath = getHighlightFilePath(repoName, baseDir);
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
		}
	} catch {
		// Non-critical
	}
}

/**
 * Find the index of a space matching the given issue key.
 * Case-insensitive match against space.name.
 * Returns -1 if not found.
 */
export function findSpaceIndexByIssueKey(
	spaces: readonly SpaceData[],
	issueKey: string,
): number {
	const key = issueKey.toUpperCase();
	return spaces.findIndex(s => s.name.toUpperCase() === key);
}

/**
 * Watch the highlight target file for changes.
 * Calls the callback with the request whenever the file is written to.
 * Returns an unwatch function.
 */
export function watchHighlightTarget(
	repoName: string,
	callback: (request: HighlightRequest) => void,
	baseDir?: string,
): () => void {
	return watchFileContent(getHighlightFilePath(repoName, baseDir), callback);
}

/**
 * Call `callback` with the trimmed content of `filePath` each time it is
 * written. The directory is watched rather than the file, so writes that
 * replace the file by rename are seen too.
 */
export function watchFileContent(
	filePath: string,
	callback: (content: string) => void,
): () => void {
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);

	mkdirSync(dir, {recursive: true});

	const watcher = watch(dir, (_eventType, changedFile) => {
		if (changedFile !== filename) return;
		try {
			const request = parseRequest(readFileSync(filePath, 'utf-8'));
			if (request) callback(request);
		} catch {
			// File may have been deleted between event and read
		}
	});

	return () => watcher.close();
}
