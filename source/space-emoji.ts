// Resolves the emoji to render in the ticket rail for a single space.
//
// Single source of truth: the profile name persisted in the per-space state
// file (`~/.pappardelle/repos/{repo}/space-state/{ISSUE-KEY}.json`).
//
// Two callers write to that file — both at the moment a space is first added
// to the ticket rail:
//
//   1. `idow` writes the user's selected profile during workspace creation
//      (fast path; emoji is correct on first paint).
//
//   2. This resolver back-fills it the first time it sees a space without a
//      persisted profile but with a cached issue whose project matches a
//      configured profile. Covers spaces created before STA-930 and any
//      space added through means other than `idow`.
//
// Once persisted, every render reads from the same file — no second
// resolution path at render time.
import {
	type PappardelleConfig,
	getProfileEmoji,
	matchProfileByProject,
} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {readSpaceState, writeSpaceState} from './space-state.ts';

export interface ResolveSpaceEmojiArgs {
	config: PappardelleConfig | null;
	repoName: string;
	issueKey: string | undefined;
	cachedIssue: TrackerIssue | null;
	baseDir?: string;
}

export function resolveSpaceEmoji({
	config,
	repoName,
	issueKey,
	cachedIssue,
	baseDir,
}: ResolveSpaceEmojiArgs): string | undefined {
	if (!config) return undefined;

	let profileName: string | undefined;
	if (issueKey) {
		profileName = readSpaceState(repoName, issueKey, baseDir)?.profile;

		if (!profileName) {
			const projectName = cachedIssue?.project?.name;
			const matched = projectName
				? matchProfileByProject(config, projectName, cachedIssue?.project?.key)
				: null;
			if (matched) {
				writeSpaceState(repoName, issueKey, {profile: matched.name}, baseDir);
				profileName = matched.name;
			}
		}
	}

	const profile = profileName ? config.profiles[profileName] : undefined;
	return getProfileEmoji(profile, config);
}
