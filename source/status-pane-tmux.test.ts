import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	parseStatusPane,
	STATUS_MONITOR_OPTION,
	STATUS_PANE_FORMAT,
	statusMarker,
} from './program-status-monitor.ts';

const tmuxTest = spawnSync('tmux', ['-V']).status === 0 ? test : test.skip;

// The pane's process exits with remain-on-exit on, as a user's tmux.conf can
// set it. tmux 3.8 then lists no pid for the pane.
tmuxTest(
	'a monitored pane that died is read as dead under the generation it was monitored with',
	async () => {
		const socket = path.join(tempDir('status-pane-'), 's');
		const tmux = (...args: string[]) =>
			spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
				encoding: 'utf8',
			});
		teardown(() => tmux('kill-server'));
		const created = tmux(
			'new-session',
			'-d',
			'-s',
			'agent',
			'sleep 1',
			';',
			'set-option',
			'-g',
			'remain-on-exit',
			'on',
		);
		expect(created.status, created.stderr).toBe(0);
		const read = () =>
			parseStatusPane(
				tmux('display-message', '-p', '-t', '=agent:', STATUS_PANE_FORMAT)
					.stdout,
				socket,
			);

		const alive = read()!;
		const marked = tmux(
			'set-option',
			'-p',
			'-t',
			alive.id,
			STATUS_MONITOR_OPTION,
			statusMarker(alive.pid),
		);
		expect(marked.status, marked.stderr).toBe(0);
		const monitored = read()!;
		for (let i = 0; i < 100 && !read()?.dead; i++) await delay(50);

		expect(read()).toMatchObject({
			dead: true,
			pid: monitored.pid,
			generation: monitored.generation,
		});
	},
);
