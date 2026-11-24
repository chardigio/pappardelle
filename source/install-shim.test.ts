import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';
import {tempDir, type Teardown} from '../test/helpers/temp-dir.ts';

const root = path.join(import.meta.dirname, '..');
const installSh = path.join(root, 'install.sh');

// An install whose executable prints each argument it was given.
function install(
	t: Teardown,
	options: {executable: boolean; directory?: string},
) {
	const home = tempDir(t, 'install-shim-test-');
	const installDir = path.join(
		home,
		options.directory ?? 'install with spaces',
	);
	fs.mkdirSync(path.join(installDir, 'scripts'), {recursive: true});
	fs.copyFileSync(
		path.join(root, 'scripts', 'pappardelle-shim-template.sh'),
		path.join(installDir, 'scripts', 'pappardelle-shim-template.sh'),
	);
	const executable = path.join(installDir, 'dist', 'pappardelle');
	if (options.executable) {
		fs.mkdirSync(path.dirname(executable));
		fs.writeFileSync(
			executable,
			'#!/bin/bash\nfor arg in "$@"; do echo "ARG:$arg"; done\n',
			{mode: 0o755},
		);
	}

	const written = spawnSync(
		'/bin/bash',
		[
			'-c',
			'source "$1" && INSTALL_DIR="$2" install_shim',
			'bash',
			installSh,
			installDir,
		],
		{
			encoding: 'utf8',
			env: {
				HOME: home,
				PATH: process.env['PATH'],
				PAPPARDELLE_INSTALL_SOURCE_ONLY: '1',
			},
		},
	);
	if (written.status !== 0)
		throw new Error(`install_shim failed: ${written.stderr}`);
	return {shim: path.join(home, '.local', 'bin', 'pappardelle'), executable};
}

// PATH is empty: the shim needs no Bun, nor anything else, to start the executable.
function runShim(shim: string, args: string[] = []) {
	return spawnSync('/bin/bash', [shim, ...args], {
		env: {PATH: ''},
		encoding: 'utf8',
	});
}

test("the installed shim runs the install's executable with its arguments untouched", t => {
	const {shim} = install(t, {executable: true});

	const result = runShim(shim, ['highlight', 'STA-1682', 'two words']);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout, 'ARG:highlight\nARG:STA-1682\nARG:two words\n');
});

// Bash 5.2 replaces an unquoted & in a pattern substitution with the match.
test('the installed shim runs an executable whose path has an ampersand', t => {
	const {shim} = install(t, {executable: true, directory: 'tools & more'});

	const result = runShim(shim, ['--version']);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout, 'ARG:--version\n');
});

test('the installed shim names a missing executable and how to reinstall', t => {
	const {shim, executable} = install(t, {executable: false});

	const result = runShim(shim, ['--version']);

	t.is(result.status, 1);
	t.is(result.stdout, '');
	t.true(
		result.stderr.includes(`${executable} is missing or not executable`),
		`stderr: ${result.stderr}`,
	);
	t.true(result.stderr.includes('install.sh'), `stderr: ${result.stderr}`);
});
