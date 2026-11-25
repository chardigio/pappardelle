import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {
	INNER_SOCKET,
	enableTmuxControlClients,
	setupPappardellLayout,
} from './tmux.ts';

const exec = promisify(execFile);

// tmux 3.4 crashes when the layout's splits notify the TUI's control client
// while the server is still setting it up. Newer releases survive it, so the
// test slows the control client's start down and checks that the splits wait.
test("the layout's splits run once the TUI's control client has attached", async () => {
	const tmux = Bun.which('tmux');
	if (!tmux) {
		expect().pass('tmux unavailable');
		return;
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-control-wait-'));
	const shims = path.join(dir, 'bin');
	fs.mkdirSync(shims);
	fs.writeFileSync(
		path.join(shims, 'tmux'),
		`#!/bin/sh
for arg do [ "$arg" = -C ] && sleep 0.2; done
exec '${tmux}' "$@"
`,
		{mode: 0o755},
	);
	const socket = path.join(dir, 'outer');
	const env = {...process.env, TMUX: '', TMUX_TMPDIR: dir};
	const run = async (args: string[]) => {
		const {stdout} = await exec(tmux, ['-S', socket, ...args], {env});
		return stdout.trim();
	};

	const saved = {
		PATH: process.env['PATH'],
		TMUX: process.env['TMUX'],
		TMUX_PANE: process.env['TMUX_PANE'],
		TMUX_TMPDIR: process.env['TMUX_TMPDIR'],
	};
	testTmuxState();
	teardown(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}

		for (const server of [
			['-S', socket],
			['-L', INNER_SOCKET],
		]) {
			try {
				await exec(tmux, [...server, 'kill-server'], {env});
			} catch {}
		}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	await run([
		'-f',
		'/dev/null',
		'new-session',
		'-d',
		'-s',
		'fixture',
		'-x',
		'200',
		'-y',
		'50',
		';',
		'set-hook',
		'-g',
		'after-split-window',
		'set-option -gF @attached_at_split "#{session_attached}"',
	]);
	process.env['PATH'] = `${shims}:${saved.PATH}`;
	process.env['TMUX'] = `${socket},0,0`;
	process.env['TMUX_PANE'] = await run(['display-message', '-p', '#{pane_id}']);
	process.env['TMUX_TMPDIR'] = dir;

	enableTmuxControlClients();
	expect(await setupPappardellLayout()).toBeTruthy();
	expect(await run(['show-option', '-gqv', '@attached_at_split'])).toBe('1');
});
