import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import type {RailStatusPatch, SpacePrLink} from './space-state.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

/** A store whose clock moves a second on every write. */
function fixture() {
	let seconds = 0;
	const s = testState({
		clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)),
	});
	const {db} = openStateDb(stateDbPath(s.stateDir));
	return {
		...s,
		spaceState: s.daos.spaceState,
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
// every space's record each time made `updatedAt` mean "last poll".
test('a rail poll that learns nothing new writes no row', async () => {
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
		rows: [f.row('STA-1'), f.row('STA-2')],
		changes: f.changes(),
	};
	expect(before.rows[0]?.['updated_at']).toBe('2026-01-01T00:00:00.000Z');

	await poll(rail());
	expect({
		rows: [f.row('STA-1'), f.row('STA-2')],
		changes: f.changes(),
	}).toStrictEqual(before);

	await poll(rail({unresolvedCommentCount: 1}));
	expect(f.row('STA-1')?.['updated_at']).toBe('2026-01-01T00:00:02.000Z');
	expect(f.row('STA-2')).toStrictEqual(before.rows[1]!);
});

test('recording the same PR link again writes nothing', async () => {
	const f = fixture();
	await f.spaceState.addPrLink('STA-1', link);
	const before = f.changes();
	await f.spaceState.addPrLink('STA-1', link);
	expect(f.changes()).toBe(before);
});

// A writer that read the whole record, changed its own field and wrote all
// of it back would undo a profile saved during a rail poll.
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
const {spaceState} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(f.stateDir)}});
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
});
