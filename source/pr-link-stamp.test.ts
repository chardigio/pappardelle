import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

contractTest(
	'the stamp reads zero until a PR is linked, then a later time each touch',
	async state => {
		const stamp = state.daos.prLinkStamp;
		expect(stamp.read()).toBe(0);
		const before = Date.now();
		await stamp.touch();
		const first = stamp.read();
		expect(first >= before - 1000).toBe(true);
		expect(first <= Date.now() + 1000).toBe(true);
		expect(fs.existsSync(path.join(state.stateDir, 'pr-link.stamp'))).toBe(
			true,
		);
	},
);

// link-pr runs in another process than the rail whose backoff it ends.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a stamp touched by another process is read here`, async () => {
		const state = testState({sqlite});
		expect(state.daos.prLinkStamp.read()).toBe(0);
		const before = Date.now();
		await exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
await createStateDaos({repo: 'another-repo', stateDir: ${JSON.stringify(state.stateDir)}, sqlite: ${sqlite}}).prLinkStamp.touch();
`,
			],
			{timeout: 30_000},
		);
		expect(state.daos.prLinkStamp.read() >= before - 1000).toBe(true);
	});
}

test('sqlite: the stamp is the time on the injected clock, and the file is touched with it', async () => {
	let now = 1_800_000_000_000;
	const state = testState({sqlite: true, clock: () => new Date(now)});
	const stamp = state.daos.prLinkStamp;
	await stamp.touch();
	expect(stamp.read()).toBe(1_800_000_000_000);
	now += 5000;
	await stamp.touch();
	expect(stamp.read()).toBe(1_800_000_005_000);
	expect(
		fs.readFileSync(path.join(state.stateDir, 'pr-link.stamp'), 'utf8'),
	).toBe('1800000005000\n');
});

test('the two stores leave the same stamp file', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState({
			sqlite,
			clock: () => new Date(1_800_000_000_000),
		});
		await state.daos.prLinkStamp.touch();
		files.push(
			fs.readFileSync(path.join(state.stateDir, 'pr-link.stamp'), 'utf8'),
		);
	}

	expect(files[0]).toBe(files[1]);
	expect(files[0]).toBe('1800000000000\n');
});
