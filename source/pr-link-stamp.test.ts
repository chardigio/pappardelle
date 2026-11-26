import {test, expect} from 'bun:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {testState} from '../test/helpers/state.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

test('the stamp reads zero until a PR is linked, then the time on the clock each touch', async () => {
	let now = 1_800_000_000_000;
	const stamp = testState({clock: () => new Date(now)}).daos.prLinkStamp;
	expect(stamp.read()).toBe(0);
	await stamp.touch();
	expect(stamp.read()).toBe(1_800_000_000_000);
	now += 5000;
	await stamp.touch();
	expect(stamp.read()).toBe(1_800_000_005_000);
});

// link-pr runs in another process than the rail whose backoff it ends.
test('a stamp touched by another process is read here', async () => {
	const state = testState();
	expect(state.daos.prLinkStamp.read()).toBe(0);
	const before = Date.now();
	await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
await createStateDaos({repo: 'another-repo', stateDir: ${JSON.stringify(state.stateDir)}}).prLinkStamp.touch();
`,
		],
		{timeout: 30_000},
	);
	expect(state.daos.prLinkStamp.read() >= before - 1000).toBe(true);
});
