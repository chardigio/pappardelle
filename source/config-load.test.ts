import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	loadProviderConfigs,
	readConfig,
	readHomeSqliteState,
} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';
import {getRecentErrors} from './logger.ts';

function layers(
	t: {teardown: (fn: () => void) => void},
	files: Record<string, string>,
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-read-'));
	t.teardown(() => {
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

test('no config file in any layer is a missing config', t => {
	const {paths} = layers(t, {});
	t.deepEqual(readConfig(paths), {kind: 'missing'});
});

test('a config that validates is valid', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml': 'version: 1\nteam_prefix: ABC\nprofiles: {}\n',
	});
	const load = readConfig(paths);
	t.is(load.kind, 'valid');
	t.is(load.kind === 'valid' ? load.config.team_prefix : undefined, 'ABC');
});

test('a validation error in an unused agent profile makes the config invalid', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml':
			'version: 1\nprofiles: {}\nagent_profiles:\n  opus:\n    command: claude\n    model: 7\n',
	});
	const load = readConfig(paths);
	t.is(load.kind, 'invalid');
	t.true(
		load.kind === 'invalid' &&
			load.errors.some(error => error.includes('agent_profiles.opus.model')),
	);
});

test('a layer that fails to parse makes the config invalid, not missing', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml': 'version: 1\nprofiles: {}\n',
		'project/.pappardelle.local.yml': 'profiles: [unclosed\n',
	});
	const load = readConfig(paths);
	t.is(load.kind, 'invalid');
	t.true(
		load.kind === 'invalid' &&
			load.errors.some(error => error.includes('.pappardelle.local.yml')),
	);
});

test('a config file that cannot be read makes the config invalid', t => {
	const {dir, paths} = layers(t, {});
	fs.mkdirSync(path.join(dir, 'project', '.pappardelle.yml'));
	const load = readConfig(paths);
	t.is(load.kind, 'invalid');
	t.true(load.kind === 'invalid' && load.errors[0]!.includes('EISDIR'));
});

test('every layer that fails to parse is reported, not just the first', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml': 'version: [unclosed\n',
		'project/.pappardelle.local.yml': 'profiles: [unclosed\n',
	});
	const load = readConfig(paths);
	t.is(load.kind, 'invalid');
	const errors = load.kind === 'invalid' ? load.errors : [];
	t.true(errors.some(error => error.startsWith('.pappardelle.yml: ')));
	t.true(errors.some(error => error.startsWith('.pappardelle.local.yml: ')));
});

test('a config file that cannot be read is named in its error', t => {
	const {dir, paths} = layers(t, {});
	fs.mkdirSync(path.join(dir, 'project', '.pappardelle.local.yml'));
	const load = readConfig(paths);
	t.deepEqual(
		load.kind === 'invalid'
			? load.errors.map(error => error.split(': ')[0])
			: [],
		['.pappardelle.local.yml'],
	);
});

test('a YAML error fits on one line without its code excerpt', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml': 'version: 1\nprofiles: {}\n',
		'project/.pappardelle.local.yml': 'opus: [unclosed\n',
	});
	const load = readConfig(paths);
	const inline = load.kind === 'invalid' ? inlineConfigErrors(load.errors) : '';
	t.true(inline.startsWith('.pappardelle.local.yml'));
	t.false(inline.includes('\n'));
	t.false(inline.endsWith(':'));
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
		test(`a ${shape} ${label} is an invalid config naming the file`, t => {
			const {paths} = layers(t, {
				...(file === 'project/.pappardelle.yml'
					? {}
					: {'project/.pappardelle.yml': validProject}),
				[file]: content!,
			});
			t.deepEqual(readConfig(paths), {
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
	test(`${shape} layer adds nothing`, t => {
		const {paths} = layers(t, {
			'home/.pappardelle.yml': content!,
			'project/.pappardelle.yml': validProject,
			'project/.pappardelle.local.yml': content!,
		});
		t.is(readConfig(paths).kind, 'valid');
	});
}

test('a scalar layer is listed as unparsable by loadProviderConfigs', t => {
	const {paths} = layers(t, {
		'project/.pappardelle.yml':
			'version: 1\nprofiles: {}\nissue_tracker: {provider: beads}\n',
		'project/.pappardelle.local.yml': 'oops\n',
	});
	const providers = loadProviderConfigs(paths);
	t.deepEqual(providers.unparsable, [
		'.pappardelle.local.yml: the top level must be a map',
	]);
	t.deepEqual(providers.issue_tracker, {provider: 'beads'});
});

test('a scalar home config leaves the sqlite flag off and says so', t => {
	const {dir} = layers(t, {'home/.pappardelle.yml': 'true\n'});
	t.false(readHomeSqliteState(path.join(dir, 'home')));
	t.like(
		getRecentErrors().filter(entry =>
			entry.message.includes(path.join(dir, 'home', '.pappardelle.yml')),
		),
		[{level: 'warn'}],
	);
});
