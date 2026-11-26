import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';

test('the subprocess runner keeps UI timers running while tmux is slow', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-slow-tmux-'));
	teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	fs.writeFileSync(
		path.join(dir, 'tmux'),
		`#!/bin/sh
sleep 0.06
case " $* " in
*" display-message "*" %1 "*) printf /dev/claude ;;
*" display-message "*) printf /dev/companion ;;
*" list-clients "*) printf '/dev/claude\\n/dev/companion\\n' ;;
esac
`,
		{mode: 0o755},
	);
	const moduleUrl = new URL('tmux.ts', import.meta.url).href;
	const script = `
import {attachToSpace, initTmuxState} from ${JSON.stringify(moduleUrl)};
import {getRepoName} from ${JSON.stringify(new URL('config.ts', import.meta.url).href)};
import {createStateDaos} from ${JSON.stringify(new URL('state-daos.ts', import.meta.url).href)};
initTmuxState(createStateDaos({repo: getRepoName(), stateDir: ${JSON.stringify(path.join(dir, 'state'))}, sqlite: false}));
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const success = await attachToSpace('%1', '%2', 'TEST-SLOW', '%0', undefined, undefined, {agentName: 'claude'});
clearInterval(timer);
console.log(JSON.stringify({success, ticks}));
`;
	const {stdout} = await promisify(execFile)(
		process.execPath,
		['--input-type=module', '-e', script],
		{
			env: {
				...process.env,
				PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
			},
			timeout: 15_000,
		},
	);
	const result = JSON.parse(stdout) as {success: boolean; ticks: number};
	expect(result.success).toBe(true);
	expect(
		result.ticks >= 10,
		`only ${result.ticks} UI ticks during slow tmux calls`,
	).toBe(true);
});
