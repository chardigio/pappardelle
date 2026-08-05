// Resolves the emoji to render in the ticket rail for a single space.
//
// The profile lookup (including the back-fill that persists a matched profile
// on first sight) lives in space-profile.ts, shared with the agent-CLI
// resolver so the two can never disagree about which profile a space is in.
import {type PappardelleConfig, getProfileEmoji} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {resolveSpaceProfileName} from './space-profile.ts';

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

	const profileName = resolveSpaceProfileName({
		config,
		repoName,
		issueKey,
		cachedIssue,
		baseDir,
	});

	const profile = profileName ? config.profiles[profileName] : undefined;
	return getProfileEmoji(profile, config);
}
