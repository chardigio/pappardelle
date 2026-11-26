import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {testTmuxState} from '../test/helpers/state.ts';
import type {PappardelleConfig} from './config.ts';
import {
	runningAgentProfile,
	spaceAgentName,
	storeLaunchedAgentProfiles,
} from './tmux.ts';

// No space has this key, so no agent has recorded a session under it.
const KEY = 'no-such-space-r29';

test('a space runs the agent profile of the profile saved for it', async () => {
	const {daos} = testTmuxState();
	const config: PappardelleConfig = {
		version: 1,
		agent_profiles: {codex: {command: 'codex'}},
		profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
	};
	expect(runningAgentProfile(config, KEY).name).toBe('claude');
	await daos.spaceState.write(KEY, {profile: 'other'});
	expect(runningAgentProfile(config, KEY).name).toBe('codex');
});

test('a space runs the agent profile its agent session was last started with', async () => {
	const {daos} = testTmuxState();
	const config: PappardelleConfig = {
		version: 1,
		agent_profiles: {codex: {command: 'codex'}, pi: {command: 'pi'}},
		profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
	};
	await daos.spaceState.write(KEY, {
		profile: 'other',
		agentProfile: {name: 'pi', isClaude: false},
	});
	expect(runningAgentProfile(config, KEY).name).toBe('pi');
	// The config no longer defines it, so the profile's own runs.
	await daos.spaceState.write(KEY, {
		agentProfile: {name: 'gone', isClaude: false},
	});
	expect(runningAgentProfile(config, KEY).name).toBe('codex');
});

test('an agent launched before its space stored the agent profile gets the one that started last', async () => {
	const {daos} = testTmuxState();
	const config: PappardelleConfig = {
		version: 1,
		agent_profiles: {codex: {command: 'codex'}, pi: {command: 'pi'}},
		profiles: {},
	};
	const record = (key: string, started: Record<string, string>) => {
		const file = daos.agentSessions.file(key);
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(
			file,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(started).map(([name, at]) => [
						name,
						{session_id: name, pid: 7, started: at},
					]),
				),
			),
		);
	};

	record('STA-1', {
		claude: 'Mon Nov  2 10:00:00 2026',
		codex: 'Mon Nov  2 11:30:00 2026',
	});
	record('STA-2', {claude: 'Mon Nov  2 10:00:00 2026'});
	await daos.spaceState.write('STA-2', {
		agentProfile: {name: 'pi', isClaude: false},
	});
	record('STA-3', {gone: 'Mon Nov  2 10:00:00 2026'});

	await storeLaunchedAgentProfiles(config, daos.agentSessions, daos.spaceState);

	expect(daos.spaceState.read('STA-1')?.agentProfile).toStrictEqual({
		name: 'codex',
		isClaude: false,
	});
	expect(daos.spaceState.read('STA-2')?.agentProfile).toStrictEqual({
		name: 'pi',
		isClaude: false,
	});
	expect(daos.spaceState.read('STA-3')?.agentProfile).toBe(undefined);
});

test('the agent frame names the agent a space runs, claude without a config, and agent with an invalid one', async () => {
	const {daos} = testTmuxState();
	const config: PappardelleConfig = {
		version: 1,
		agent_profiles: {custom: {command: 'env X=1 my-agent'}},
		profiles: {},
	};
	await daos.spaceState.write(KEY, {
		agentProfile: {name: 'custom', isClaude: false},
	});
	expect(spaceAgentName({kind: 'valid', config}, KEY)).toBe('my-agent');
	expect(spaceAgentName({kind: 'missing'}, KEY)).toBe('claude');
	expect(spaceAgentName({kind: 'invalid', errors: ['bad']}, KEY)).toBe('agent');
});
