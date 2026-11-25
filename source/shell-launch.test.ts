// buildShellLaunchArgs is the argv tmux execs for claude/companion sessions.
// These run it for real against a stub shell that logs each invocation, so
// they check what the user's shell actually receives.
import {execFileSync} from 'node:child_process';
import {chmodSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test, expect} from 'bun:test';
import {buildShellLaunchArgs} from './tmux.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

function restoreShell(value: string | undefined): void {
	if (value === undefined) {
		delete process.env['SHELL'];
	} else {
		process.env['SHELL'] = value;
	}
}

function runWithStubShell(command: string): string[] {
	const dir = tempDir('shell-launch-');
	const log = join(dir, 'log');
	const stub = join(dir, 'stub-shell');
	writeFileSync(
		stub,
		`#!/bin/sh\nfor a in "$@"; do printf '<%s>' "$a"; done >> '${log}'\nprintf '\\0' >> '${log}'\n`,
	);
	chmodSync(stub, 0o755);

	const previousShell = process.env['SHELL'];
	process.env['SHELL'] = stub;
	try {
		const [file, ...args] = buildShellLaunchArgs(command);
		execFileSync(file!, args);
	} finally {
		restoreShell(previousShell);
	}

	return readFileSync(log, 'utf-8').split('\0').slice(0, -1);
}

test('runs the command in an interactive shell, then a login shell', () => {
	const command = `claude --model 'claude-opus-5[1m]' --continue || { printf '\\033[A'; false; }`;
	expect(runWithStubShell(command)).toStrictEqual([
		`<-ic><${command}\n:>`,
		'<-l>',
	]);
});

test('a trailing comment in the command does not swallow the login shell', () => {
	expect(runWithStubShell('gitui # my note')).toStrictEqual([
		'<-ic><gitui # my note\n:>',
		'<-l>',
	]);
});

test('falls back to /bin/sh when SHELL is unset', () => {
	const previousShell = process.env['SHELL'];
	delete process.env['SHELL'];
	try {
		expect(buildShellLaunchArgs('gitui')[4]).toBe('/bin/sh');
	} finally {
		restoreShell(previousShell);
	}
});
