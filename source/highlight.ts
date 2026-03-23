// Cross-terminal highlight IPC
// Allows `pappardelle highlight STA-XXX` to select a row in a running TUI.
// Uses a file-based IPC mechanism: the CLI writes an issue key to
// ~/.pappardelle/repos/{repoName}/highlight-target, and the running app
// watches for changes via fs.watch().

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
import type {SpaceData} from './types.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

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
 * Write an issue key to the highlight target file.
 * Called by `pappardelle highlight STA-XXX` from another terminal.
 */
export function writeHighlightTarget(
	repoName: string,
	issueKey: string,
	baseDir?: string,
): void {
	const filePath = getHighlightFilePath(repoName, baseDir);
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, issueKey + '\n');
}

/**
 * Read the current highlight target issue key.
 * Returns null if no file exists.
 */
export function readHighlightTarget(
	repoName: string,
	baseDir?: string,
): string | null {
	const filePath = getHighlightFilePath(repoName, baseDir);
	try {
		if (!existsSync(filePath)) return null;
		return readFileSync(filePath, 'utf-8').trim();
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
 * Calls the callback with the issue key whenever the file is written to.
 * Returns an unwatch function.
 */
export function watchHighlightTarget(
	repoName: string,
	callback: (issueKey: string) => void,
	baseDir?: string,
): () => void {
	const filePath = getHighlightFilePath(repoName, baseDir);
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);

	mkdirSync(dir, {recursive: true});

	const watcher = watch(dir, (_eventType, changedFile) => {
		if (changedFile !== filename) return;
		try {
			const content = readFileSync(filePath, 'utf-8').trim();
			if (content) {
				callback(content);
			}
		} catch {
			// File may have been deleted between event and read
		}
	});

	return () => watcher.close();
}
