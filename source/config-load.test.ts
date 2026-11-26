import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadProviderConfigs, readConfig} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';

function layers(files: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-read-'));
	teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	for (const [name, content] of Object.entries(files)) {
		const filePath = path.join(dir, name);
		fs.mkdirSync(path.dirname(filePath), {recursive: true});
		fs.writeFileSync(filePath, content, 'utf-8');
	}

	fs.mkdirSync(path.join(dir, 'home'), {recursive: true});
	fs.mkdirSync(path.join(dir, 'project'), {recursive: true});
	return {
		dir,
		paths: {
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		},
	};
}

test('no config file in any layer is a missing config', () => {
	const {paths} = layers({});
	expect(readConfig(paths)).toStrictEqual({kind: 'missing'});
});

test('a config that validates is valid', () => {
	const {paths} = layers({
		'project/.pappardelle.yml': 'version: 1\nteam_prefix: ABC\nprofiles: {}\n',
	});
	const load = readConfig(paths);
	expect(load.kind).toBe('valid');
	expect(load.kind === 'valid' ? load.config.team_prefix : undefined).toBe(
		'ABC',
	);
});

test('a validation error in an unused agent profile makes the config invalid', () => {
	const {paths} = layers({
		'project/.pappardelle.yml':
			'version: 1\nprofiles: {}\nagent_profiles:\n  opus:\n    command: claude\n    model: 7\n',
	});
	const load = readConfig(paths);
	expect(load.kind).toBe('invalid');
	expect(
		load.kind === 'invalid' &&
			load.errors.some(error => error.includes('agent_profiles.opus.model')),
	).toBe(true);
});

test('a layer that fails to parse makes the config invalid, not missing', () => {
	const {paths} = layers({
		'project/.pappardelle.yml': 'version: 1\nprofiles: {}\n',
		'project/.pappardelle.local.yml': 'profiles: [unclosed\n',
	});
	const load = readConfig(paths);
	expect(load.kind).toBe('invalid');
	expect(
		load.kind === 'invalid' &&
			load.errors.some(error => error.includes('.pappardelle.local.yml')),
	).toBe(true);
});

test('a config file that cannot be read makes the config invalid', () => {
	const {dir, paths} = layers({});
	fs.mkdirSync(path.join(dir, 'project', '.pappardelle.yml'));
	const load = readConfig(paths);
	expect(load.kind).toBe('invalid');
	expect(load.kind === 'invalid' && load.errors[0]!.includes('EISDIR')).toBe(
		true,
	);
});

test('every layer that fails to parse is reported, not just the first', () => {
	const {paths} = layers({
		'project/.pappardelle.yml': 'version: [unclosed\n',
		'project/.pappardelle.local.yml': 'profiles: [unclosed\n',
	});
	const load = readConfig(paths);
	expect(load.kind).toBe('invalid');
	const errors = load.kind === 'invalid' ? load.errors : [];
	expect(errors.some(error => error.startsWith('.pappardelle.yml: '))).toBe(
		true,
	);
	expect(
		errors.some(error => error.startsWith('.pappardelle.local.yml: ')),
	).toBe(true);
});

test('a config file that cannot be read is named in its error', () => {
	const {dir, paths} = layers({});
	fs.mkdirSync(path.join(dir, 'project', '.pappardelle.local.yml'));
	const load = readConfig(paths);
	expect(
		load.kind === 'invalid'
			? load.errors.map(error => error.split(': ')[0])
			: [],
	).toStrictEqual(['.pappardelle.local.yml']);
});

test('a YAML error fits on one line without its code excerpt', () => {
	const {paths} = layers({
		'project/.pappardelle.yml': 'version: 1\nprofiles: {}\n',
		'project/.pappardelle.local.yml': 'opus: [unclosed\n',
	});
	const load = readConfig(paths);
	const inline = load.kind === 'invalid' ? inlineConfigErrors(load.errors) : '';
	expect(inline.startsWith('.pappardelle.local.yml')).toBe(true);
	expect(inline.includes('\n')).toBe(false);
	expect(inline.endsWith(':')).toBe(false);
});

const layerFiles = {
	'~/.pappardelle/.pappardelle.yml': 'home/.pappardelle.yml',
	'.pappardelle.yml': 'project/.pappardelle.yml',
	'.pappardelle.local.yml': 'project/.pappardelle.local.yml',
};
const validProject = 'version: 1\nprofiles: {}\n';

for (const [label, file] of Object.entries(layerFiles)) {
	for (const [shape, content] of [
		['scalar', 'just a string\n'],
		['list', '- version: 1\n'],
	]) {
		test(`a ${shape} ${label} is an invalid config naming the file`, () => {
			const {paths} = layers({
				...(file === 'project/.pappardelle.yml'
					? {}
					: {'project/.pappardelle.yml': validProject}),
				[file]: content!,
			});
			expect(readConfig(paths)).toStrictEqual({
				kind: 'invalid',
				errors: [`${label}: the top level must be a map`],
			});
		});
	}
}

for (const [shape, content] of [
	['an empty', ''],
	['a null', '~\n'],
	['a document-marker-only', '---\n'],
]) {
	test(`${shape} layer adds nothing`, () => {
		const {paths} = layers({
			'home/.pappardelle.yml': content!,
			'project/.pappardelle.yml': validProject,
			'project/.pappardelle.local.yml': content!,
		});
		expect(readConfig(paths).kind).toBe('valid');
	});
}

test("loadProviderConfigs reports a scalar layer's error", () => {
	const {paths} = layers({
		'project/.pappardelle.yml':
			'version: 1\nprofiles: {}\nissue_tracker: {provider: beads}\n',
		'project/.pappardelle.local.yml': 'oops\n',
	});
	const providers = loadProviderConfigs(paths);
	expect(providers.layerErrors).toStrictEqual([
		'.pappardelle.local.yml: the top level must be a map',
	]);
	expect(providers.issue_tracker).toStrictEqual({provider: 'beads'});
});
