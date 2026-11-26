// Cross-terminal highlight requests: `pappardelle highlight STA-XXX` asks a
// running TUI to select a space, and with `--focus` to move focus to its
// agent pane.

import path from 'node:path';
import {internalEntryCommand} from './runtime.ts';
import {shellQuote} from './shell-quote.ts';
import type {SpaceData} from './types.ts';

export type HighlightRequest = {issueKey: string; focus: boolean};

/** Where a repo's highlight target file was, for the one-time import. */
export function getHighlightFilePath(
	repoName: string,
	baseDir: string,
): string {
	return path.join(baseDir, 'repos', repoName, 'highlight-target');
}

/**
 * A shell line that makes `request` in `repo`'s stores in the database at
 * `dbPath`, for the sous-chef key binding to run from tmux. The tmux server's
 * environment is not the TUI's, so the database is named. Its output and
 * failures are dropped: either would put the pane the key was pressed in into
 * view mode.
 */
export function highlightShellCommand(
	repo: string,
	dbPath: string,
	{issueKey, focus}: HighlightRequest,
): string {
	const command = [
		...internalEntryCommand('--internal-state', 'state-cli'),
		'highlight',
		'--repo',
		repo,
		issueKey,
		...(focus ? ['--focus'] : []),
	];
	return `PAPPARDELLE_STATE_DB=${shellQuote(dbPath)} ${command.map(word => shellQuote(word)).join(' ')} >/dev/null 2>&1 || true`;
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
	 * Call `listener` with each request made from now on. A request made before
	 * this call is not reported. Returns an unwatch function.
	 */
	watch(listener: (request: HighlightRequest) => void): () => void;
	/** Forget the request, once it has been acted on. */
	clear(): Promise<void>;
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
