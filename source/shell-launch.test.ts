// buildShellLaunchArgs is the argv tmux execs for claude/companion sessions.
// These run it for real against a stub shell that logs each invocation, so
// they check what the user's shell actually receives.
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {buildShellLaunchArgs} from './tmux.ts';

function restoreShell(value: string | undefined): void {
	if (value === undefined) {
		delete process.env['SHELL'];
	} else {
		process.env['SHELL'] = value;
	}
}

function runWithStubShell(command: string): string[] {
	const dir = mkdtempSync(join(tmpdir(), 'shell-launch-'));
	const log = join(dir, 'log');
	const stub = join(dir, 'stub-shell');
	writeFileSync(
		stub,
		`#!/bin/sh\nfor a in "$@"; do printf '<%s>' "$a"; done >> '${log}'\nprintf '\\n' >> '${log}'\n`,
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

	return readFileSync(log, 'utf-8').trim().split('\n');
}

test('runs the command verbatim in an interactive shell, then a login shell', t => {
	const command = `claude --model 'claude-opus-5[1m]' --continue || { printf '\\033[A'; false; }`;
	t.deepEqual(runWithStubShell(command), [`<-ic><${command}>`, '<-l>']);
});

test('a trailing comment in the command does not swallow the login shell', t => {
	t.deepEqual(runWithStubShell('gitui # my note'), [
		'<-ic><gitui # my note>',
		'<-l>',
	]);
});

test('falls back to /bin/sh when SHELL is unset', t => {
	const previousShell = process.env['SHELL'];
	delete process.env['SHELL'];
	try {
		t.is(buildShellLaunchArgs('gitui')[4], '/bin/sh');
	} finally {
		restoreShell(previousShell);
	}
});
