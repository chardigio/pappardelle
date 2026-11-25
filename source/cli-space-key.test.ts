import {test, expect} from 'bun:test';
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

test('a bare number takes the configured team prefix', () => {
	expect(cliSpaceKey('42', valid, 'linear', noBeadsPrefix)).toStrictEqual({
		kind: 'key',
		key: 'ABC-42',
	});
});

test('a bare number is refused while the config is invalid', () => {
	expect(cliSpaceKey('42', invalid, 'linear', noBeadsPrefix)).toStrictEqual({
		kind: 'invalid-config',
		errors: ['agent_profiles.opus.model: must be a string'],
	});
});

test('a full key still resolves while the config is invalid', () => {
	expect(cliSpaceKey('abc-12', invalid, 'linear', noBeadsPrefix)).toStrictEqual(
		{
			kind: 'key',
			key: 'ABC-12',
		},
	);
	expect(
		cliSpaceKey('pap-a1b2', invalid, 'beads', noBeadsPrefix),
	).toStrictEqual({
		kind: 'key',
		key: 'pap-a1b2',
	});
});

test('without a config a bare number takes the built-in prefix', () => {
	expect(
		cliSpaceKey('42', {kind: 'missing'}, 'linear', noBeadsPrefix),
	).toStrictEqual({
		kind: 'key',
		key: 'STA-42',
	});
});
