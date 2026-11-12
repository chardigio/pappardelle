import test from 'ava';
import {testTmuxState} from '../test/helpers/state.ts';
import type {PappardelleConfig} from './config.ts';
import {runningAgentProfile} from './tmux.ts';

// No space has this key, so no agent has recorded a session under it.
const KEY = 'no-such-space-r29';

test('a space runs the agent profile of the profile saved for it', async t => {
	const {daos} = testTmuxState(t);
	const config: PappardelleConfig = {
		version: 1,
		agent_profiles: {codex: {command: 'codex'}},
		profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
	};
	t.is(runningAgentProfile(config, KEY).name, 'claude');
	await daos.spaceState.write(KEY, {profile: 'other'});
	t.is(runningAgentProfile(config, KEY).name, 'codex');
});
