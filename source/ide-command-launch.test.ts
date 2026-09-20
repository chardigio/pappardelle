// The `d` key hands `ide_command` to `bash -c`, which means the worktree path
// reaches a shell parser. Interpolating the path into the command string (the
// way custom keybindings expand `${VAR}` via expandTemplate) would let a branch
// name containing `$(...)` or backticks run as the user. Passing the workspace
// variables through the child's environment instead keeps them as data: bash
// expands them after parsing, so the value is never itself parsed as source.
//
// These tests drive a stand-in editor that prints its argv, so they assert on
// what the editor actually receives rather than on the string we built.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {DEFAULT_IDE_COMMAND, expandTemplate} from './config.ts';

/** A worktree path carrying every shell metacharacter that could bite us. */
const HOSTILE_PATH = '/tmp/$(printf PWNED)/a b`whoami`"q"\'s';

let tempCounter = 0;

function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-ide-launch-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

/**
 * Write a stand-in editor that appends each argv element it receives to a file,
 * one per line, so the test can compare against the literal path.
 */
function makeFakeEditor(dir: string): {bin: string; argsFile: string} {
	const bin = path.join(dir, 'fake-editor');
	const argsFile = path.join(dir, 'args.txt');
	fs.writeFileSync(
		bin,
		`#!/bin/bash\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argsFile)}; done\n`,
		{mode: 0o755},
	);
	return {bin, argsFile};
}

/**
 * Run a command the way handleOpenIDE does: `bash -c` with the workspace
 * variables supplied as environment entries and never interpolated.
 */
async function runIdeCommand(
	command: string,
	vars: Record<string, string>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('bash', ['-c', command], {
			stdio: 'ignore',
			env: {...process.env, ...vars},
		});
		child.on('error', reject);
		child.on('close', () => {
			resolve();
		});
	});
}

function readArgs(argsFile: string): string[] {
	if (!fs.existsSync(argsFile)) return [];
	return fs.readFileSync(argsFile, 'utf-8').split('\n').slice(0, -1);
}

test('env-supplied WORKTREE_PATH reaches the editor as one literal argument', async t => {
	const dir = tempDir();
	const {bin, argsFile} = makeFakeEditor(dir);

	await runIdeCommand(`${JSON.stringify(bin)} "\${WORKTREE_PATH}"`, {
		WORKTREE_PATH: HOSTILE_PATH,
	});

	t.deepEqual(readArgs(argsFile), [HOSTILE_PATH]);
});

test('interpolating the path into the command string executes it instead', async t => {
	const dir = tempDir();
	const {bin, argsFile} = makeFakeEditor(dir);

	// The rejected implementation: expandTemplate pastes the value into the
	// command source, so bash parses `$(printf PWNED)` as a substitution. This
	// test pins the behavior we are deliberately NOT shipping.
	const interpolated = expandTemplate(
		`${JSON.stringify(bin)} "\${WORKTREE_PATH}"`,
		{
			WORKTREE_PATH: HOSTILE_PATH,
		},
	);
	await runIdeCommand(interpolated, {});

	const args = readArgs(argsFile);
	t.notDeepEqual(
		args,
		[HOSTILE_PATH],
		'expected interpolation to corrupt the path — if this passes, the env-based launch is no longer the thing under test',
	);
	t.true(args[0]?.includes('PWNED'), 'command substitution should have run');
});

test('the built-in default survives a worktree path containing spaces', async t => {
	const dir = tempDir();
	const {bin, argsFile} = makeFakeEditor(dir);
	const spacey = path.join(dir, 'a b', 'c');

	// Same shape as DEFAULT_IDE_COMMAND, with the editor swapped for the stub.
	const command = DEFAULT_IDE_COMMAND.replace('cursor', JSON.stringify(bin));
	await runIdeCommand(command, {WORKTREE_PATH: spacey});

	t.deepEqual(readArgs(argsFile), [spacey]);
});
