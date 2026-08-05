// Resolves which profile a space belongs to.
//
// Single source of truth: the profile name persisted in the per-space state
// file (`~/.pappardelle/repos/{repo}/space-state/{ISSUE-KEY}.json`).
//
// Two callers write to that file — both at the moment a space is first added
// to the ticket rail:
//
//   1. `idow` writes the user's selected profile during workspace creation
//      (fast path; the profile is correct on first paint).
//
//   2. This resolver back-fills it the first time it sees a space without a
//      persisted profile but with a cached issue whose project matches a
//      configured profile. Covers spaces created before STA-930 and any
//      space added through means other than `idow`.
//
// Extracted from space-emoji.ts in STA-1850: the profile is now the input to
// two per-space decisions (which emoji to draw, which agent CLI to launch), and
// both must agree on the answer.

import {type PappardelleConfig, matchProfileByProject} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {readSpaceState, writeSpaceState} from './space-state.ts';

export interface ResolveSpaceProfileArgs {
	config: PappardelleConfig | null;
	repoName: string;
	issueKey: string | undefined;
	cachedIssue: TrackerIssue | null;
	baseDir?: string;
}

/**
 * The profile name for a space, or undefined when none can be determined
 * (no config, no issue key, or an issue whose project matches no profile).
 */
export function resolveSpaceProfileName({
	config,
	repoName,
	issueKey,
	cachedIssue,
	baseDir,
}: ResolveSpaceProfileArgs): string | undefined {
	if (!config || !issueKey) return undefined;

	const persisted = readSpaceState(repoName, issueKey, baseDir)?.profile;
	if (persisted) return persisted;

	const projectName = cachedIssue?.project?.name;
	const matched = projectName
		? matchProfileByProject(config, projectName, cachedIssue?.project?.key)
		: null;
	if (!matched) return undefined;

	writeSpaceState(repoName, issueKey, {profile: matched.name}, baseDir);
	return matched.name;
}
