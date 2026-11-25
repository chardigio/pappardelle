import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import type {RailStatusPatch, SpacePrLink} from './space-state.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

/** A SQLite-backed store whose clock moves a second on every write. */
function fixture() {
	let seconds = 0;
	const s = testState({
		sqlite: true,
		clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)),
	});
	const file = (key: string) =>
		path.join(s.stateDir, 'repos', 'repo', 'space-state', `${key}.json`);
	const {db} = openStateDb(stateDbPath(s.stateDir));
	return {
		...s,
		spaceState: s.daos.spaceState,
		file,
		content: (key: string) =>
			JSON.parse(fs.readFileSync(file(key), 'utf8')) as Record<string, unknown>,
		signature(key: string) {
			const stat = fs.statSync(file(key), {bigint: true});
			return `${stat.ino}:${stat.mtimeNs}`;
		},
		row: (key: string) =>
			db
				.query<
					Record<string, unknown>,
					[string]
				>("SELECT * FROM space_state WHERE repo = 'repo' AND key = ?")
				.get(key),
		changes: () =>
			db
				.query<{changes: number}, []>('SELECT total_changes() AS changes')
				.get()!.changes,
	};
}

const rail = (rest: RailStatusPatch = {}): RailStatusPatch => ({
	pipeline: 'passing',
	unresolvedCommentCount: 0,
	prNumber: 7,
	hasConflict: false,
	...rest,
});

const link: SpacePrLink = {
	host: 'github.com',
	project: 'user/repo',
	localBranch: 'STA-1',
	remoteBranch: 'published',
	url: 'https://github.com/user/repo/pull/1',
	number: 1,
};

// The rail polls every few seconds and usually learns nothing new. Rewriting
// every space's file each time made `updatedAt` mean "last poll".
test('a rail poll that learns nothing new writes no row and no file', async () => {
	const f = fixture();
	const poll = async (first: RailStatusPatch) =>
		f.spaceState.writeMany([
			{key: 'STA-1', patch: first},
			{
				key: 'STA-2',
				patch: rail({
					pipeline: null,
					prNumber: undefined,
					recap: {lastPrompt: 'Go'},
				}),
			},
		]);
	await poll(rail());
	const before = {
		files: [f.signature('STA-1'), f.signature('STA-2')],
		rows: [f.row('STA-1'), f.row('STA-2')],
		changes: f.changes(),
	};
	expect(before.rows[0]?.['updated_at']).toBe('2026-01-01T00:00:00.000Z');

	await poll(rail());
	expect({
		files: [f.signature('STA-1'), f.signature('STA-2')],
		rows: [f.row('STA-1'), f.row('STA-2')],
		changes: f.changes(),
	}).toStrictEqual(before);

	await poll(rail({unresolvedCommentCount: 1}));
	expect(f.signature('STA-1')).not.toBe(before.files[0]);
	expect(f.row('STA-1')?.['updated_at']).toBe('2026-01-01T00:00:02.000Z');
	expect(f.content('STA-1')['updatedAt']).toBe('2026-01-01T00:00:02.000Z');
	expect(f.signature('STA-2')).toBe(before.files[1]);
	expect(f.row('STA-2')).toStrictEqual(before.rows[1]);
});

test('recording the same PR link again writes nothing', async () => {
	const f = fixture();
	await f.spaceState.addPrLink('STA-1', link);
	const before = {file: f.signature('STA-1'), changes: f.changes()};
	await f.spaceState.addPrLink('STA-1', link);
	expect({file: f.signature('STA-1'), changes: f.changes()}).toStrictEqual(
		before,
	);
});

// The file's writers each read it, changed their own field and wrote all of
// it back, so a profile saved during a rail poll could be undone by the poll.
test('a profile write and rail polls from two processes at once all land', async () => {
	const f = fixture();
	const worker = async (write: string) =>
		exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {spaceState} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(f.stateDir)}, sqlite: true});
for (let i = 1; i <= 40; i++) await ${write};
`,
			],
			{timeout: 30_000},
		);
	await Promise.all([
		worker(`spaceState.write('STA-1', {profile: 'profile-' + i})`),
		worker(
			`spaceState.writeMany([{key: 'STA-1', patch: {pipeline: 'failing', unresolvedCommentCount: i, hasConflict: i % 2 === 0}}])`,
		),
	]);
	const expected = {
		profile: 'profile-40',
		pipeline: 'failing',
		unresolvedCommentCount: 40,
		hasConflict: true,
	};
	expect(f.spaceState.read('STA-1')).toMatchObject(expected);
	expect(f.content('STA-1')).toMatchObject(expected);
});

// The first write after the flag is turned on finds a file the database has
// never seen. idow or an earlier Pappardelle saved the profile there.
test('the first write to a space keeps what its file already held', async () => {
	const f = fixture();
	fs.mkdirSync(path.dirname(f.file('STA-1')), {recursive: true});
	fs.writeFileSync(
		f.file('STA-1'),
		JSON.stringify({profile: 'codex', updatedAt: '2025-12-31T00:00:00Z'}),
	);
	await f.spaceState.addPrLink('STA-1', link);
	expect(f.content('STA-1')).toStrictEqual({
		profile: 'codex',
		updatedAt: '2025-12-31T00:00:00Z',
		prLinks: [link],
	});
	expect(f.row('STA-1')?.['profile']).toBe('codex');
});

test('a file that is not space state leaves the stored record in place', async () => {
	const f = fixture();
	await f.spaceState.write('STA-1', {profile: 'dev', pipeline: 'passing'});
	fs.writeFileSync(f.file('STA-1'), JSON.stringify(['passing']));
	expect(f.spaceState.read('STA-1')).toMatchObject({
		profile: 'dev',
		pipeline: 'passing',
	});

	await f.spaceState.write('STA-1', {prNumber: 3});
	expect(f.content('STA-1')).toMatchObject({
		profile: 'dev',
		pipeline: 'passing',
		prNumber: 3,
	});
});
