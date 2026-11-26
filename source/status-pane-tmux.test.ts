import path from 'node:path';
import {expect} from 'bun:test';
import {tmuxOn, tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {until} from '../test/helpers/wait.ts';
import {
	parseStatusPane,
	STATUS_MONITOR_OPTION,
	STATUS_PANE_FORMAT,
	statusMarker,
} from './program-status-monitor.ts';

// The pane's process exits with remain-on-exit on, as a user's tmux.conf can
// set it. tmux 3.8 then lists no pid for the pane.
tmuxTest(
	'a monitored pane that died is read as dead under the generation it was monitored with',
	async () => {
		const socket = path.join(tempDir('status-pane-'), 's');
		const tmux = tmuxOn(socket);
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
		await until(() => read()?.dead === true, {
			what: 'the pane to be read as dead',
			frame: () => JSON.stringify(read()),
			intervalMs: 50,
		});

		expect(read()).toMatchObject({
			dead: true,
			pid: monitored.pid,
			generation: monitored.generation,
		});
	},
);
