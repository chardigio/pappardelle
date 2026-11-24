import {
	DEFAULT_TEAM_PREFIX,
	getBeadsPrefixes,
	getTeamPrefix,
	type ConfigLoad,
} from './config.ts';
import {isIssueNumber, resolveSpaceKey} from './issue-utils.ts';
import type {TrackerProviderName} from './providers/types.ts';

export type CliSpaceKey =
	| {kind: 'key'; key: string}
	| {kind: 'invalid-config'; errors: string[]};

/**
 * A bare number needs the configured team prefix, so it can't be resolved
 * while the config is invalid. Any other key is used as typed, which keeps
 * `pappardelle space …` (what the MCP tools run) working on a broken config;
 * only a beads key typed in another case misses its space then.
 */
export function cliSpaceKey(
	rawKey: string,
	load: ConfigLoad,
	provider: TrackerProviderName,
	beadsIssuePrefix: () => string | undefined,
): CliSpaceKey {
	switch (load.kind) {
		case 'valid': {
			return {
				kind: 'key',
				key: resolveSpaceKey(
					rawKey,
					getTeamPrefix(load.config),
					provider,
					getBeadsPrefixes(load.config, beadsIssuePrefix()),
				),
			};
		}

		case 'missing': {
			return {
				kind: 'key',
				key: resolveSpaceKey(rawKey, DEFAULT_TEAM_PREFIX, provider, []),
			};
		}

		case 'invalid': {
			return isIssueNumber(rawKey.trim())
				? {kind: 'invalid-config', errors: load.errors}
				: {
						kind: 'key',
						key: resolveSpaceKey(rawKey, DEFAULT_TEAM_PREFIX, provider, []),
					};
		}
	}
}
