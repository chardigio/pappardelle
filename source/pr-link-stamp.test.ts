import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

contractTest(
	'the stamp reads zero until a PR is linked, then a later time each touch',
	async (t, state) => {
		const stamp = state.daos.prLinkStamp;
		t.is(stamp.read(), 0);
		const before = Date.now();
		await stamp.touch();
		const first = stamp.read();
		t.true(first >= before - 1000);
		t.true(first <= Date.now() + 1000);
		t.true(fs.existsSync(path.join(state.stateDir, 'pr-link.stamp')));
	},
);

// link-pr runs in another process than the rail whose backoff it ends.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a stamp touched by another process is read here`, async t => {
		const state = testState(t, {sqlite});
		t.is(state.daos.prLinkStamp.read(), 0);
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
		t.true(state.daos.prLinkStamp.read() >= before - 1000);
	});
}

test('sqlite: the stamp is the time on the injected clock, and the file is touched with it', async t => {
	let now = 1_800_000_000_000;
	const state = testState(t, {sqlite: true, clock: () => new Date(now)});
	const stamp = state.daos.prLinkStamp;
	await stamp.touch();
	t.is(stamp.read(), 1_800_000_000_000);
	now += 5000;
	await stamp.touch();
	t.is(stamp.read(), 1_800_000_005_000);
	t.is(
		fs.readFileSync(path.join(state.stateDir, 'pr-link.stamp'), 'utf8'),
		'1800000005000\n',
	);
});

test('the two stores leave the same stamp file', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState(t, {
			sqlite,
			clock: () => new Date(1_800_000_000_000),
		});
		await state.daos.prLinkStamp.touch();
		files.push(
			fs.readFileSync(path.join(state.stateDir, 'pr-link.stamp'), 'utf8'),
		);
	}

	t.is(files[0], files[1]);
	t.is(files[0], '1800000000000\n');
});
