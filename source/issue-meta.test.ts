import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {testState, type TestState} from '../test/helpers/state.ts';

const metaFile = (s: TestState, key: string) =>
	path.join(s.stateDir, 'repos', 'repo', 'issue-meta', `${key}.json`);

// Every case runs against both stores, each with a clock of its own.
for (const sqlite of [false, true]) {
	const name = sqlite ? 'sqlite' : 'json';
	const state = (t: Parameters<typeof testState>[0]) =>
		testState(t, {sqlite, clock: () => new Date('2026-01-02T03:04:05.678Z')});

	test(`${name}: an issue Pappardelle created is recorded with the time, to the second, in the store and in its file`, async t => {
		const s = state(t);
		t.is(s.daos.issueMeta.read('STA-1'), null);
		await s.daos.issueMeta.markCreated('STA-1');
		t.deepEqual(s.daos.issueMeta.read('STA-1'), {
			createdByPappardelle: true,
			createdAt: '2026-01-02T03:04:05Z',
		});
		t.deepEqual(JSON.parse(fs.readFileSync(metaFile(s, 'STA-1'), 'utf8')), {
			created_by_pappardelle: true,
			created_at: '2026-01-02T03:04:05Z',
		});
		t.is(s.daos.issueMeta.read('STA-2'), null);
	});

	test(`${name}: a file written by a process without the database is read, and a deleted file is nothing recorded`, async t => {
		const s = state(t);
		await s.daos.issueMeta.markCreated('STA-1');
		// What idow wrote before it asked the binary to.
		fs.writeFileSync(
			metaFile(s, 'STA-1'),
			'{"created_by_pappardelle": true, "created_at": "2025-06-07T08:09:10Z"}\n',
		);
		t.deepEqual(s.daos.issueMeta.read('STA-1'), {
			createdByPappardelle: true,
			createdAt: '2025-06-07T08:09:10Z',
		});
		fs.rmSync(metaFile(s, 'STA-1'));
		t.is(s.daos.issueMeta.read('STA-1'), null);
	});

	test(`${name}: a file of another shape is nothing recorded`, t => {
		const s = state(t);
		fs.mkdirSync(path.dirname(metaFile(s, 'STA-1')), {recursive: true});
		fs.writeFileSync(metaFile(s, 'STA-1'), '{"title": "Fix it"}');
		t.is(s.daos.issueMeta.read('STA-1'), null);
	});
}
