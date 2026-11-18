import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {
	exactSessionTarget,
	newOuterSessionArgs,
	outerSessionName,
} from './tmux.ts';

const runtimeTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.skip;

runtimeTest(
	'a repo whose name reads as a tmux format still gets its own outer session, titled 🍝 <repo> even when the user turned titles off',
	t => {
		const root = realpathSync(mkdtempSync('/tmp/outer-title-'));
		const conf = path.join(root, 'tmux.conf');
		writeFileSync(
			conf,
			'set -g set-titles off\nset -g set-titles-string "#h:#W"\n',
		);
		const tmux = (...args: string[]) =>
			spawnSync('tmux', ['-S', path.join(root, 's'), '-f', conf, ...args], {
				encoding: 'utf8',
			});
		t.teardown(() => {
			tmux('kill-server');
			rmSync(root, {recursive: true, force: true});
		});

		const repo = 'pasta#S';
		// Detached, since the test has no terminal for the client.
		const [command, ...rest] = newOuterSessionArgs(repo, [], 'sleep 30');
		const created = tmux(command!, '-d', ...rest);
		t.is(created.status, 0, created.stderr);

		const shown = tmux(
			'display-message',
			'-p',
			'-t',
			exactSessionTarget(outerSessionName(repo)),
			'#{session_name}|#{set-titles}|#{T:set-titles-string}',
		);
		t.is(shown.stdout.trim(), 'pappardelle-pasta#S|1|🍝 pasta#S');
	},
);
