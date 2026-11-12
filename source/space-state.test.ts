import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {
	extractRecapFromJsonl,
	findLatestSessionJsonl,
	parseSpaceState,
	type SpaceState,
	type SpacePrLink,
} from './space-state.ts';

let tempCounter = 0;

function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-space-state-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// ============================================================================
// SpaceStateDao
// ============================================================================

const stateFile = (s: TestState, key: string) =>
	path.join(s.stateDir, 'repos', 'repo', 'space-state', `${key}.json`);

const fileContent = (s: TestState, key: string) =>
	JSON.parse(fs.readFileSync(stateFile(s, key), 'utf8')) as SpaceState;

/** A state file as a process that does not use the database leaves it. */
function writeStateFile(s: TestState, key: string, state: unknown): void {
	fs.mkdirSync(path.dirname(stateFile(s, key)), {recursive: true});
	fs.writeFileSync(stateFile(s, key), JSON.stringify(state, null, 2) + '\n');
}

const link = (rest: Partial<SpacePrLink> = {}): SpacePrLink => ({
	host: 'github.com',
	project: 'user/repo',
	localBranch: 'STA-1',
	remoteBranch: 'published',
	url: 'https://github.com/user/repo/pull/1',
	number: 1,
	...rest,
});

contractTest('a space with nothing recorded reads as null', (t, s) => {
	t.is(s.daos.spaceState.read('STA-999'), null);
	t.is(
		s.daos.spaceState.file('STA-999'),
		path.join(s.stateDir, 'repos', 'repo', 'space-state', 'STA-999.json'),
	);
});

contractTest('a file that is not JSON reads as nothing recorded', (t, s) => {
	fs.mkdirSync(path.dirname(stateFile(s, 'STA-100')), {recursive: true});
	fs.writeFileSync(stateFile(s, 'STA-100'), 'not json{{{');
	t.is(s.daos.spaceState.read('STA-100'), null);
});

// Another build, or a hand edit, can leave a value this build does not use.
// The rail rewrites the file on its next poll, from what was read.
contractTest(
	'a file with a field that cannot be used keeps its other fields, through a rail write too',
	async (t, s) => {
		const {spaceState} = s.daos;
		writeStateFile(s, 'STA-150', {
			profile: 'codex',
			prLinks: [link()],
			pipeline: 'purple',
			prNumber: null,
			recap: {customTitle: 5, lastPrompt: 'Prompt'},
		});
		const expected = {
			profile: 'codex',
			prLinks: [link()],
			recap: {lastPrompt: 'Prompt'},
		};
		t.like(spaceState.read('STA-150'), expected);

		await spaceState.writeRailStatuses([
			{key: 'STA-150', patch: {unresolvedCommentCount: 4}},
		]);
		t.like(spaceState.read('STA-150'), {
			...expected,
			unresolvedCommentCount: 4,
		});
		t.like(fileContent(s, 'STA-150'), {
			...expected,
			unresolvedCommentCount: 4,
		});
	},
);

test('parseSpaceState leaves out each value that is not what its field holds, and keeps the rest', t => {
	const valid = {
		prLinks: [link(), link({localBranch: 'STA-2', number: 2})],
		pipeline: null,
		unresolvedCommentCount: 2,
		prNumber: 9,
		hasConflict: true,
		recap: {customTitle: 'Title', lastPrompt: 'Prompt'},
		updatedAt: '2026-01-02T03:04:05.678Z',
		profile: 'codex',
	};
	t.deepEqual(parseSpaceState(JSON.stringify(valid)), valid);

	const {number: _number, ...incompleteLink} = link({localBranch: 'STA-3'});
	t.deepEqual(
		parseSpaceState(
			JSON.stringify({
				prLinks: [link(), incompleteLink, 'not a link'],
				pipeline: 'purple',
				unresolvedCommentCount: null,
				prNumber: '9',
				hasConflict: 'yes',
				recap: {customTitle: 5, lastPrompt: 'Prompt', lastAssistantExcerpt: []},
				updatedAt: 7,
				profile: 'codex',
			}),
		),
		{prLinks: [link()], recap: {lastPrompt: 'Prompt'}, profile: 'codex'},
	);

	t.deepEqual(
		parseSpaceState(JSON.stringify({prLinks: 'none', recap: 'none'})),
		{},
	);
	for (const content of ['[]', '"profile"', 'null'])
		t.throws(() => parseSpaceState(content), {message: 'Not a space state'});
});

for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a write records its fields with the time of the write, in the store and in the file`, async t => {
		const s = testState(t, {
			sqlite,
			clock: () => new Date('2026-01-02T03:04:05.678Z'),
		});
		await s.daos.spaceState.write('STA-200', {
			pipeline: 'passing',
			unresolvedCommentCount: 2,
			hasConflict: false,
		});
		const expected = {
			pipeline: 'passing',
			unresolvedCommentCount: 2,
			hasConflict: false,
			updatedAt: '2026-01-02T03:04:05.678Z',
		};
		t.deepEqual(s.daos.spaceState.read('STA-200'), expected);
		t.deepEqual(fileContent(s, 'STA-200'), expected);
	});
}

contractTest(
	'a write keeps the fields its patch does not name',
	async (t, {daos: {spaceState}}) => {
		await spaceState.write('STA-300', {
			pipeline: 'failing',
			unresolvedCommentCount: 5,
			recap: {customTitle: 'Initial title'},
		});
		await spaceState.write('STA-300', {
			pipeline: 'passing',
			unresolvedCommentCount: 0,
		});
		const state = spaceState.read('STA-300');
		t.is(state?.pipeline, 'passing');
		t.is(state?.unresolvedCommentCount, 0);
		t.deepEqual(state?.recap, {customTitle: 'Initial title'});
	},
);

contractTest(
	'a patch key with no value removes the field, and a recap replaces the whole recap',
	async (t, s) => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-310', {
			prNumber: 12,
			recap: {
				customTitle: 'Title',
				lastPrompt: 'Prompt',
				lastAssistantExcerpt: 'Excerpt',
			},
		});
		await spaceState.write('STA-310', {
			prNumber: undefined,
			recap: {lastPrompt: 'Newer prompt'},
		});
		for (const state of [
			spaceState.read('STA-310'),
			fileContent(s, 'STA-310'),
		]) {
			t.false('prNumber' in state!);
			t.deepEqual(state?.recap, {lastPrompt: 'Newer prompt'});
		}
	},
);

// `pappardelle spaces` prints pipeline as null for a branch with no PR and
// leaves it out for a space the rail has not polled.
contractTest(
	'a pipeline of null is kept apart from no pipeline at all',
	async (t, s) => {
		const {spaceState} = s.daos;
		await spaceState.write('POLLED', {
			pipeline: null,
			unresolvedCommentCount: 0,
		});
		await spaceState.write('UNPOLLED', {profile: 'dev'});
		for (const state of [spaceState.read('POLLED'), fileContent(s, 'POLLED')]) {
			t.true('pipeline' in state!);
			t.is(state?.pipeline, null);
		}

		for (const state of [
			spaceState.read('UNPOLLED'),
			fileContent(s, 'UNPOLLED'),
		])
			t.false('pipeline' in state!);

		await spaceState.write('POLLED', {pipeline: undefined});
		t.false('pipeline' in spaceState.read('POLLED')!);
	},
);

contractTest(
	'a rail poll leaves the profile, the recap and the PR links as they were',
	async (t, s) => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-1', {profile: 'stardust_jams'});
		await spaceState.addPrLink('STA-1', link());
		await spaceState.writeRailStatuses([
			{
				key: 'STA-1',
				patch: {
					pipeline: 'progressing_clean',
					unresolvedCommentCount: 1,
					prNumber: 1,
					hasConflict: false,
					recap: {customTitle: 'Title', lastPrompt: 'Prompt'},
				},
			},
			{
				key: 'STA-2',
				patch: {pipeline: null, unresolvedCommentCount: 0, hasConflict: false},
			},
		]);
		await spaceState.writeRailStatuses([
			{
				key: 'STA-1',
				patch: {
					pipeline: 'failing',
					unresolvedCommentCount: 3,
					prNumber: undefined,
					hasConflict: true,
				},
			},
		]);
		for (const state of [spaceState.read('STA-1'), fileContent(s, 'STA-1')]) {
			t.like(state, {
				profile: 'stardust_jams',
				pipeline: 'failing',
				unresolvedCommentCount: 3,
				hasConflict: true,
				recap: {customTitle: 'Title', lastPrompt: 'Prompt'},
				prLinks: [link()],
			});
			t.false('prNumber' in state!);
		}

		t.is(spaceState.read('STA-2')?.pipeline, null);
	},
);

contractTest(
	'a PR link replaces the one for the same checkout and becomes the newest',
	async (t, s) => {
		const {spaceState} = s.daos;
		const nested = link({project: 'user/nested', localBranch: 'local'});
		await spaceState.addPrLink('STA-1', link());
		await spaceState.addPrLink('STA-1', nested);
		t.deepEqual(spaceState.read('STA-1')?.prLinks, [link(), nested]);

		const republished = link({remoteBranch: 'published-again', number: 2});
		await spaceState.addPrLink('STA-1', republished);
		for (const state of [spaceState.read('STA-1'), fileContent(s, 'STA-1')])
			t.deepEqual(state?.prLinks, [nested, republished]);
	},
);

contractTest(
	'a file written by a process without the database is what the next read returns',
	async (t, s) => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-1', {profile: 'dev', prNumber: 4});
		const edited = {
			profile: 'other',
			pipeline: null,
			unresolvedCommentCount: 2,
			hasConflict: true,
			recap: {lastAssistantExcerpt: 'Done'},
			prLinks: [link()],
			updatedAt: '2026-05-06T07:08:09Z',
		};
		writeStateFile(s, 'STA-1', edited);
		t.deepEqual(spaceState.read('STA-1'), edited);

		await spaceState.write('STA-1', {prNumber: 9});
		const {updatedAt, ...kept} = edited;
		const {updatedAt: rewrittenAt, ...rewritten} = fileContent(s, 'STA-1');
		t.deepEqual(rewritten, {...kept, prNumber: 9});
		t.not(rewrittenAt, updatedAt);
	},
);

contractTest(
	'a space whose file was deleted has nothing recorded',
	async (t, s) => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-1', {profile: 'dev'});
		await spaceState.addPrLink('STA-1', link());
		fs.rmSync(stateFile(s, 'STA-1'));
		t.is(spaceState.read('STA-1'), null);

		await spaceState.write('STA-1', {prNumber: 3});
		t.deepEqual(Object.keys(fileContent(s, 'STA-1')).sort(), [
			'prNumber',
			'updatedAt',
		]);
	},
);

test('both stores leave the same files for the same writes', async t => {
	const files = async (sqlite: boolean) => {
		const s = testState(t, {sqlite});
		const {spaceState} = s.daos;
		await spaceState.write('STA-1', {profile: 'dev'});
		await spaceState.writeRailStatuses([
			{
				key: 'STA-1',
				patch: {
					pipeline: 'passing',
					unresolvedCommentCount: 0,
					prNumber: 7,
					hasConflict: false,
					recap: {customTitle: 'Title', lastAssistantExcerpt: 'Excerpt'},
				},
			},
			{
				key: 'STA-2',
				patch: {
					pipeline: null,
					unresolvedCommentCount: 0,
					prNumber: undefined,
					hasConflict: false,
				},
			},
		]);
		await spaceState.addPrLink('STA-1', link());
		await spaceState.addPrLink('STA-1', link({remoteBranch: 'again'}));
		await spaceState.addPrLink('STA-3', link({localBranch: 'STA-3'}));
		await spaceState.writeRailStatuses([
			{
				key: 'STA-1',
				patch: {
					pipeline: 'failing',
					unresolvedCommentCount: 2,
					prNumber: undefined,
					hasConflict: true,
				},
			},
		]);
		const dir = path.dirname(stateFile(s, 'STA-1'));
		return Object.fromEntries(
			fs
				.readdirSync(dir)
				.sort()
				.map(name => {
					const {updatedAt, ...rest} = JSON.parse(
						fs.readFileSync(path.join(dir, name), 'utf8'),
					) as SpaceState;
					return [name, rest];
				}),
		);
	};

	const json = await files(false);
	t.deepEqual(Object.keys(json), ['STA-1.json', 'STA-2.json', 'STA-3.json']);
	t.deepEqual(await files(true), json);
});

// ============================================================================
// extractRecapFromJsonl
// ============================================================================

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(
		filePath,
		entries.map(e => JSON.stringify(e)).join('\n') + '\n',
	);
}

test('extractRecapFromJsonl returns null when file does not exist', async t => {
	const d = tempDir();
	t.is(await extractRecapFromJsonl(path.join(d, 'nope.jsonl')), null);
});

test('transcript stream errors return without hanging the rail poll', async t => {
	const dir = tempDir();
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	t.is(await extractRecapFromJsonl(dir), null);
});

test('extractRecapFromJsonl pulls custom-title and last-prompt', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{
			type: 'custom-title',
			customTitle: 'STA-870 persist state',
			sessionId: 'abc',
		},
		{
			type: 'user',
			message: {content: 'hello'},
			timestamp: '2026-04-21T05:00:00Z',
		},
		{type: 'last-prompt', lastPrompt: 'keep going', sessionId: 'abc'},
	]);
	const recap = await extractRecapFromJsonl(p);
	t.truthy(recap);
	t.is(recap!.customTitle, 'STA-870 persist state');
	t.is(recap!.lastPrompt, 'keep going');
});

test('extractRecapFromJsonl takes the most recent custom-title when duplicated', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'custom-title', customTitle: 'old title'},
		{type: 'user', message: {content: 'x'}},
		{type: 'custom-title', customTitle: 'fresh title'},
	]);
	const recap = await extractRecapFromJsonl(p);
	t.is(recap!.customTitle, 'fresh title');
});

test('extractRecapFromJsonl captures the last assistant text snippet', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{
			type: 'assistant',
			message: {content: [{type: 'text', text: 'first reply'}]},
		},
		{
			type: 'assistant',
			message: {
				content: [
					{type: 'text', text: 'second reply with more detail'},
					{type: 'tool_use', id: 't1'},
				],
			},
		},
		{type: 'user', message: {content: 'ok'}},
	]);
	const recap = await extractRecapFromJsonl(p);
	t.is(recap!.lastAssistantExcerpt, 'second reply with more detail');
});

test('extractRecapFromJsonl truncates long assistant excerpts', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	const longText = 'x'.repeat(1000);
	writeJsonl(p, [
		{type: 'assistant', message: {content: [{type: 'text', text: longText}]}},
	]);
	const recap = await extractRecapFromJsonl(p);
	t.true(recap!.lastAssistantExcerpt!.length <= 500);
});

test('extractRecapFromJsonl skips malformed lines without crashing', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	fs.writeFileSync(
		p,
		[
			'not json',
			'',
			JSON.stringify({type: 'custom-title', customTitle: 'valid'}),
		].join('\n'),
	);
	const recap = await extractRecapFromJsonl(p);
	t.is(recap!.customTitle, 'valid');
});

// ============================================================================
// findLatestSessionJsonl
// ============================================================================

test('findLatestSessionJsonl returns null when project dir is missing', async t => {
	const projectsDir = tempDir();
	const worktree = path.join('/Users/x', '.worktrees', 'repo', 'STA-111');
	t.is(await findLatestSessionJsonl(worktree, projectsDir), null);
});

test('findLatestSessionJsonl returns the newest top-level jsonl', async t => {
	const projectsDir = tempDir();
	const worktree = '/Users/x/.worktrees/repo/STA-222';
	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(projectsDir, encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const older = path.join(projectDir, 'older.jsonl');
	const newer = path.join(projectDir, 'newer.jsonl');
	fs.writeFileSync(older, '');
	fs.writeFileSync(newer, '');
	// Force mtime ordering (Date.now() resolution can tie on fast FSes).
	const now = Date.now();
	fs.utimesSync(older, now / 1000 - 60, now / 1000 - 60);
	fs.utimesSync(newer, now / 1000, now / 1000);

	t.is(await findLatestSessionJsonl(worktree, projectsDir), newer);
});

test('findLatestSessionJsonl ignores subagent jsonls in nested dirs', async t => {
	const projectsDir = tempDir();
	const worktree = '/Users/x/.worktrees/repo/STA-333';
	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(projectsDir, encoded);
	fs.mkdirSync(path.join(projectDir, 'subagents'), {recursive: true});

	const nested = path.join(projectDir, 'subagents', 'agent.jsonl');
	fs.writeFileSync(nested, '');

	t.is(await findLatestSessionJsonl(worktree, projectsDir), null);
});

test('extractRecapFromJsonl returns null when no recap-worthy entries exist', async t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'agent-setting', agentSetting: {}},
		{type: 'permission-mode', mode: 'default'},
	]);
	t.is(await extractRecapFromJsonl(p), null);
});

test('recaps reuse unchanged snapshots and refresh after append, rewrite, and replacement', async t => {
	const dir = tempDir();
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	const file = path.join(dir, 'session.jsonl');
	writeJsonl(file, [{type: 'custom-title', customTitle: 'first'}]);
	const first = await extractRecapFromJsonl(file);
	t.is(await extractRecapFromJsonl(file), first);
	fs.appendFileSync(
		file,
		JSON.stringify({type: 'last-prompt', lastPrompt: 'continue'}) + '\n',
	);
	t.deepEqual(await extractRecapFromJsonl(file), {
		customTitle: 'first',
		lastPrompt: 'continue',
	});
	writeJsonl(file, [{type: 'custom-title', customTitle: 'reset'}]);
	t.deepEqual(await extractRecapFromJsonl(file), {customTitle: 'reset'});
	const previous = fs.statSync(file);
	const replacement = path.join(dir, 'replacement.jsonl');
	writeJsonl(replacement, [{type: 'custom-title', customTitle: 'other'}]);
	fs.utimesSync(replacement, previous.atime, previous.mtime);
	fs.renameSync(replacement, file);
	t.deepEqual(await extractRecapFromJsonl(file), {customTitle: 'other'});
	fs.unlinkSync(file);
	t.is(await extractRecapFromJsonl(file), null);
});

test('an incomplete last line is picked up when the writer finishes it', async t => {
	const dir = tempDir();
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	const file = path.join(dir, 'session.jsonl');
	fs.writeFileSync(file, '{"type":"last-prompt","lastPrompt":"keep');
	t.is(await extractRecapFromJsonl(file), null);
	fs.appendFileSync(file, ' going"}\n');
	t.deepEqual(await extractRecapFromJsonl(file), {lastPrompt: 'keep going'});
});

test('large transcript scans service UI timers before completing', async t => {
	const dir = tempDir();
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	const file = path.join(dir, 'session.jsonl');
	const line =
		JSON.stringify({type: 'assistant', message: {content: 'x'.repeat(1024)}}) +
		'\n';
	fs.writeFileSync(
		file,
		line.repeat(20_000) +
			JSON.stringify({type: 'last-prompt', lastPrompt: 'latest'}),
	);
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 1);
	t.teardown(() => clearInterval(timer));
	const recap = await extractRecapFromJsonl(file);
	clearInterval(timer);
	t.true(ticks > 1);
	t.is(recap?.lastPrompt, 'latest');
	t.is(recap?.lastAssistantExcerpt, 'x'.repeat(500));
});

test('a 20 MiB line spanning chunks preserves its recap and following lines', async t => {
	const dir = tempDir();
	t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	const file = path.join(dir, 'long-line.jsonl');
	fs.writeFileSync(
		file,
		JSON.stringify({
			type: 'assistant',
			message: {content: 'x'.repeat(20 * 1024 * 1024)},
		}) +
			'\n' +
			JSON.stringify({
				type: 'custom-title',
				customTitle: 'after the long line',
			}) +
			'\n' +
			JSON.stringify({type: 'last-prompt', lastPrompt: 'final line'}),
	);
	const start = performance.now();
	const recap = await extractRecapFromJsonl(file);
	t.is(recap?.lastAssistantExcerpt, 'x'.repeat(500));
	t.is(recap?.lastPrompt, 'final line');
	t.log(
		`20 MiB single-line transcript: ${(performance.now() - start).toFixed(1)} ms`,
	);
});
