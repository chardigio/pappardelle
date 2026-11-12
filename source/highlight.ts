// Cross-terminal highlight IPC
// Allows `pappardelle highlight STA-XXX` to select a row in a running TUI.
// Uses a file-based IPC mechanism: the CLI writes an issue key to
// ~/.pappardelle/repos/{repoName}/highlight-target, and the running app
// watches for changes via fs.watch(). With `--focus` the line also carries
// FOCUS_MARKER, and the rail moves focus to the space's agent pane.

import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {shellQuote} from './shell-quote.ts';
import type {SpaceData} from './types.ts';
import {watchFileContent} from './file-watch.ts';

const FOCUS_MARKER = 'focus';

export type HighlightRequest = {issueKey: string; focus: boolean};

function serializeRequest({issueKey, focus}: HighlightRequest): string {
	return focus ? `${issueKey}\t${FOCUS_MARKER}` : issueKey;
}

/** The request a highlight target file's content asks for, if any. */
export function parseHighlightTarget(content: string): HighlightRequest | null {
	const [issueKey, marker] = content.trim().split('\t');
	if (!issueKey) return null;
	return {issueKey, focus: marker === FOCUS_MARKER};
}

/**
 * Get the path to the highlight target file for a repo.
 */
export function getHighlightFilePath(
	repoName: string,
	baseDir: string,
): string {
	return path.join(baseDir, 'repos', repoName, 'highlight-target');
}

/** The highlight target file's content for `request`. */
export function renderHighlightTarget(request: HighlightRequest): string {
	return serializeRequest(request) + '\n';
}

/**
 * A shell line that writes `request` to the target file `file`, for the
 * sous-chef key binding to run from tmux without starting Pappardelle. Its
 * output and failures are dropped: either would put the pane the key was
 * pressed in into view mode.
 */
export function highlightWriteCommand(
	file: string,
	request: HighlightRequest,
): string {
	const line = shellQuote(serializeRequest(request));
	return `printf '%s\\n' ${line} > ${shellQuote(file)} 2>/dev/null || true`;
}

/** The space one repo's running TUI has been asked to select. */
export interface HighlightDao {
	/**
	 * Ask the running TUI to select a space, and with `focus` to move focus to
	 * its agent pane. Called by `pappardelle highlight STA-XXX` from another
	 * terminal.
	 */
	request(request: HighlightRequest): Promise<void>;
	/**
	 * A shell line that makes `request` without starting Pappardelle. Whoever
	 * watches is told of it as of any other request.
	 */
	shellRequest(request: HighlightRequest): string;
	/**
	 * Call `listener` with each request made from now on. A request made before
	 * this call is not reported. Returns an unwatch function.
	 */
	watch(listener: (request: HighlightRequest) => void): () => void;
	/** Forget the request, once it has been acted on. */
	clear(): Promise<void>;
}

/** The request as a file holding the key, watched via fs.watch(). */
export class JsonHighlightDao implements HighlightDao {
	constructor(readonly file: string) {}

	async request(request: HighlightRequest): Promise<void> {
		mkdirSync(path.dirname(this.file), {recursive: true});
		writeFileSync(this.file, renderHighlightTarget(request));
	}

	shellRequest(request: HighlightRequest): string {
		return highlightWriteCommand(this.file, request);
	}

	watch(listener: (request: HighlightRequest) => void): () => void {
		return watchFileContent(this.file, content => {
			const request = parseHighlightTarget(content);
			if (request) listener(request);
		});
	}

	async clear(): Promise<void> {
		try {
			if (existsSync(this.file)) {
				unlinkSync(this.file);
			}
		} catch {
			// Non-critical
		}
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
