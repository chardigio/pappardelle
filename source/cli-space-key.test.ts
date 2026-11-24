import test from 'ava';
import type {ConfigLoad, PappardelleConfig} from './config.ts';
import {cliSpaceKey} from './cli-space-key.ts';

const config: PappardelleConfig = {
	version: 1,
	team_prefix: 'ABC',
	profiles: {},
};
const valid: ConfigLoad = {kind: 'valid', config};
const invalid: ConfigLoad = {
	kind: 'invalid',
	errors: ['agent_profiles.opus.model: must be a string'],
};
const noBeadsPrefix = () => undefined;

test('a bare number takes the configured team prefix', t => {
	t.deepEqual(cliSpaceKey('42', valid, 'linear', noBeadsPrefix), {
		kind: 'key',
		key: 'ABC-42',
	});
});

test('a bare number is refused while the config is invalid', t => {
	t.deepEqual(cliSpaceKey('42', invalid, 'linear', noBeadsPrefix), {
		kind: 'invalid-config',
		errors: ['agent_profiles.opus.model: must be a string'],
	});
});

test('a full key still resolves while the config is invalid', t => {
	t.deepEqual(cliSpaceKey('abc-12', invalid, 'linear', noBeadsPrefix), {
		kind: 'key',
		key: 'ABC-12',
	});
	t.deepEqual(cliSpaceKey('pap-a1b2', invalid, 'beads', noBeadsPrefix), {
		kind: 'key',
		key: 'pap-a1b2',
	});
});

test('without a config a bare number takes the built-in prefix', t => {
	t.deepEqual(cliSpaceKey('42', {kind: 'missing'}, 'linear', noBeadsPrefix), {
		kind: 'key',
		key: 'STA-42',
	});
});
