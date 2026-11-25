// With claude and companion widths configured, the claude width sizes the rail. Selecting a space with its own
// companion width drops the claude width, so the rail must stay where it was.
// Runs in its own file: the configured widths are module state in tmux.ts.
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {
	rebuildLayout,
	reconcilePaneLayout,
	setConfiguredPaneWidthsForTests,
	setSpaceCompanionWidth,
} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';

const exec = promisify(execFile);

const paneWidth = async (
	paneId: string,
	run: (args: string[]) => Promise<string>,
) =>
	Number(await run(['display-message', '-p', '-t', paneId, '#{pane_width}']));

test('a space width keeps the rail that a configured claude width gave it', async () => {
	try {
		await exec('tmux', ['-V']);
	} catch {
		expect().pass('tmux unavailable');
		return;
	}

	const dir = fs.mkdtempSync(`${tmpdir()}/psc-`);
	setConfiguredPaneWidthsForTests({claude: 90, companion: 50});
	const socket = path.join(dir, 's');
	const run = async (args: string[]) => {
		const {stdout} = await exec('tmux', ['-S', socket, ...args], {
			env: {...process.env, TMUX: ''},
			timeout: 5000,
		});
		return stdout;
	};

	testTmuxState();
	teardown(async () => {
		setSpaceCompanionWidth(null);
		try {
			await exec('tmux', ['-S', socket, 'kill-server']);
		} catch {}

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
		'220',
		'-y',
		'50',
	]);
	await run(['set-option', '-g', 'status', 'off']);
	const paneOutput = await run(['display-message', '-p', '#{pane_id}']);
	const pane = paneOutput.trim();
	const rebuilt = await rebuildLayout(pane, '', '', run);
	const layout = rebuilt?.layout;
	if (!layout) {
		expect.unreachable('layout');
		return;
	}

	const cols = async (id: string) => paneWidth(id, run);

	await reconcilePaneLayout(layout, false, run);
	const rail = await cols(pane);

	setSpaceCompanionWidth({key: 'A', width: 30});
	await reconcilePaneLayout(layout, false, run);
	expect(await cols(layout.companionViewerPaneId)).toBe(30);
	expect(await cols(pane)).toBe(rail);
});
