// `pappardelle agent-profile list`: the agent profiles a space can be opened
// on, so callers pick a valid --agent-profile without reading the config.

import {parseArgs} from 'node:util';
import {AGENT_PROFILE_HELP, AGENT_PROFILE_USAGE} from './cli-args.ts';
import {
	agentProfileNames,
	loadAgentProfileSources,
	loadConfig,
	type PappardelleConfig,
} from './config.ts';

export type AgentProfileCommandDeps = {
	/** Throws when the config can't be read. */
	loadConfig: () => PappardelleConfig;
	/** The config files that define each agent profile. */
	loadSources: () => Record<string, string[]>;
	out: (text: string) => void;
	err: (text: string) => void;
};

function usage(deps: AgentProfileCommandDeps, message?: string): number {
	if (message) deps.err(message);
	deps.err(AGENT_PROFILE_USAGE);
	return 2;
}

/** Exit codes: 0 printed, 2 usage, 3 when the config can't be read. */
export function runAgentProfileCommand(
	argv: string[],
	deps: AgentProfileCommandDeps,
): number {
	const [verb, ...args] = argv;
	if (verb === '--help' || verb === '-h' || args.includes('--help')) {
		deps.out(AGENT_PROFILE_HELP);
		return 0;
	}

	if (verb !== 'list') return usage(deps);
	let json: boolean;
	try {
		json =
			parseArgs({args, options: {json: {type: 'boolean'}}}).values.json ??
			false;
	} catch (error) {
		return usage(deps, error instanceof Error ? error.message : String(error));
	}

	let names: string[];
	let sources: Record<string, string[]>;
	try {
		names = agentProfileNames(deps.loadConfig());
		sources = json ? deps.loadSources() : {};
	} catch (error) {
		deps.err(
			`Could not read the config: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 3;
	}

	deps.out(
		json
			? JSON.stringify(
					names.map(name => ({name, sources: sources[name] ?? []})),
					null,
					2,
				)
			: names.join('\n'),
	);
	return 0;
}

export function defaultAgentProfileCommandDeps(): AgentProfileCommandDeps {
	return {
		loadConfig,
		loadSources: () => loadAgentProfileSources(),
		out: text => console.log(text),
		err: text => console.error(text),
	};
}
