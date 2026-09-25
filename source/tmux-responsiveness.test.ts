import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';

test('the subprocess runner keeps UI timers running while tmux is slow', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-slow-tmux-'));
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	fs.writeFileSync(
		path.join(dir, 'tmux'),
		`#!/usr/bin/env node
const args = process.argv.slice(2);
setTimeout(() => {
  if (args.includes('display-message')) process.stdout.write(args.includes('%1') ? '/dev/claude' : '/dev/companion');
  if (args.includes('list-clients')) process.stdout.write('/dev/claude\\n/dev/companion\\n');
}, 60);
`,
		{mode: 0o755},
	);
	const moduleUrl = new URL('tmux.ts', import.meta.url).href;
	const script = `
import {attachToSpace} from ${JSON.stringify(moduleUrl)};
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const success = await attachToSpace('%1', '%2', 'TEST-SLOW', '%0');
clearInterval(timer);
console.log(JSON.stringify({success, ticks}));
`;
	const {stdout} = await promisify(execFile)(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '-e', script],
		{
			env: {
				...process.env,
				PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
			},
			timeout: 15_000,
		},
	);
	const result = JSON.parse(stdout) as {success: boolean; ticks: number};
	t.true(result.success);
	t.true(
		result.ticks >= 10,
		`only ${result.ticks} UI ticks during slow tmux calls`,
	);
});
