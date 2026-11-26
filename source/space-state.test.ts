import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {thrownBy} from '../test/helpers/thrown.ts';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState} from '../test/helpers/state.ts';
import {
	agyTranscriptPath,
	extractRecapFromJsonl,
	findLatestSessionJsonl,
	parseSpaceState,
	resolveSpaceAgentKind,
	type SpaceState,
	type SpacePrLink,
} from './space-state.ts';
import type {PappardelleConfig} from './config.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

// ============================================================================
// SpaceStateDao
// ============================================================================

const link = (rest: Partial<SpacePrLink> = {}): SpacePrLink => ({
	host: 'github.com',
	project: 'user/repo',
	localBranch: 'STA-1',
	remoteBranch: 'published',
	url: 'https://github.com/user/repo/pull/1',
	number: 1,
	...rest,
});

storeTest('a space with nothing recorded reads as null', s => {
	expect(s.daos.spaceState.read('STA-999')).toBe(null);
});

storeTest(
	'a lookup tells a recorded space from one with nothing recorded',
	async s => {
		expect(s.daos.spaceState.lookup('STA-1')).toStrictEqual({kind: 'none'});
		await s.daos.spaceState.write('STA-1', {profile: 'dev'});
		const lookup = s.daos.spaceState.lookup('STA-1');
		expect(lookup.kind === 'state' ? lookup.state.profile : undefined).toBe(
			'dev',
		);
	},
);

test('parseSpaceState leaves out each value that is not what its field holds, and keeps the rest', () => {
	const valid = {
		prLinks: [link(), link({localBranch: 'STA-2', number: 2})],
		pipeline: null,
		unresolvedCommentCount: 2,
		prNumber: 9,
		hasConflict: true,
		recap: {customTitle: 'Title', lastPrompt: 'Prompt'},
		updatedAt: '2026-01-02T03:04:05.678Z',
		profile: 'codex',
		issueTitle: 'Fix the rail',
		agentProfile: {name: 'codex-high', isClaude: false},
	};
	expect(parseSpaceState(JSON.stringify(valid))).toStrictEqual(valid);

	const {number: _number, ...incompleteLink} = link({localBranch: 'STA-3'});
	expect(
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
				issueTitle: 12,
				agentProfile: {name: 'codex'},
			}),
		),
	).toStrictEqual({
		prLinks: [link()],
		recap: {lastPrompt: 'Prompt'},
		profile: 'codex',
	});

	expect(
		parseSpaceState(JSON.stringify({prLinks: 'none', recap: 'none'})),
	).toStrictEqual({});
	for (const content of ['[]', '"profile"', 'null']) {
		const error = thrownBy(() => parseSpaceState(content));
		expect(error.message).toBe('Not a space state');
	}
});

test('a write records its fields with the time of the write', async () => {
	const s = testState({
		clock: () => new Date('2026-01-02T03:04:05.678Z'),
	});
	await s.daos.spaceState.write('STA-200', {
		pipeline: 'passing',
		unresolvedCommentCount: 2,
		hasConflict: false,
	});
	const expected: SpaceState = {
		pipeline: 'passing',
		unresolvedCommentCount: 2,
		hasConflict: false,
		updatedAt: '2026-01-02T03:04:05.678Z',
	};
	expect(s.daos.spaceState.read('STA-200')).toStrictEqual(expected);
});

storeTest(
	'a write keeps the fields its patch does not name',
	async ({daos: {spaceState}}) => {
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
		expect(state?.pipeline).toBe('passing');
		expect(state?.unresolvedCommentCount).toBe(0);
		expect(state?.recap).toStrictEqual({customTitle: 'Initial title'});
	},
);

storeTest(
	'the issue title is read back, and kept through a profile write and a rail poll',
	async s => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-320', {issueTitle: 'Fix the rail'});
		await spaceState.write('STA-320', {profile: 'dev'});
		await spaceState.writeMany([
			{key: 'STA-320', patch: {pipeline: 'passing'}},
		]);
		expect(spaceState.read('STA-320')).toMatchObject({
			issueTitle: 'Fix the rail',
			profile: 'dev',
			pipeline: 'passing',
		});
	},
);

storeTest(
	'the launched agent profile is read back, and kept through a rail poll',
	async s => {
		const {spaceState} = s.daos;
		const agentProfile = {name: 'codex-high', isClaude: false};
		await spaceState.write('STA-330', {agentProfile});
		await spaceState.writeMany([
			{key: 'STA-330', patch: {pipeline: 'passing'}},
		]);
		expect(spaceState.read('STA-330')?.agentProfile).toStrictEqual(
			agentProfile,
		);
	},
);

storeTest(
	'a patch key with no value removes the field, and a recap replaces the whole recap',
	async s => {
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
		const state = spaceState.read('STA-310');
		expect('prNumber' in state!).toBe(false);
		expect(state?.recap).toStrictEqual({lastPrompt: 'Newer prompt'});
	},
);

// `pappardelle spaces` prints pipeline as null for a branch with no PR and
// leaves it out for a space the rail has not polled.
storeTest(
	'a pipeline of null is kept apart from no pipeline at all',
	async s => {
		const {spaceState} = s.daos;
		await spaceState.write('POLLED', {
			pipeline: null,
			unresolvedCommentCount: 0,
		});
		await spaceState.write('UNPOLLED', {profile: 'dev'});
		const polled = spaceState.read('POLLED');
		expect('pipeline' in polled!).toBe(true);
		expect(polled?.pipeline).toBe(null);
		expect('pipeline' in spaceState.read('UNPOLLED')!).toBe(false);

		await spaceState.write('POLLED', {pipeline: undefined});
		expect('pipeline' in spaceState.read('POLLED')!).toBe(false);
	},
);

storeTest(
	'a rail poll leaves the profile, the recap and the PR links as they were',
	async s => {
		const {spaceState} = s.daos;
		await spaceState.write('STA-1', {profile: 'stardust_jams'});
		await spaceState.addPrLink('STA-1', link());
		await spaceState.writeMany([
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
		await spaceState.writeMany([
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
		const state = spaceState.read('STA-1');
		expect(state).toMatchObject({
			profile: 'stardust_jams',
			pipeline: 'failing',
			unresolvedCommentCount: 3,
			hasConflict: true,
			recap: {customTitle: 'Title', lastPrompt: 'Prompt'},
			prLinks: [link()],
		});
		expect('prNumber' in state!).toBe(false);

		expect(spaceState.read('STA-2')?.pipeline).toBe(null);
	},
);

storeTest(
	'a PR link replaces the one for the same checkout and becomes the newest',
	async s => {
		const {spaceState} = s.daos;
		const nested = link({project: 'user/nested', localBranch: 'local'});
		await spaceState.addPrLink('STA-1', link());
		await spaceState.addPrLink('STA-1', nested);
		expect(spaceState.read('STA-1')?.prLinks).toStrictEqual([link(), nested]);

		const republished = link({remoteBranch: 'published-again', number: 2});
		await spaceState.addPrLink('STA-1', republished);
		expect(spaceState.read('STA-1')?.prLinks).toStrictEqual([
			nested,
			republished,
		]);
	},
);

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

test('extractRecapFromJsonl returns null when file does not exist', async () => {
	const d = tempDir('pappardelle-space-state-');
	expect(await extractRecapFromJsonl(path.join(d, 'nope.jsonl'))).toBe(null);
});

test('transcript stream errors return without hanging the rail poll', async () => {
	const dir = tempDir('pappardelle-space-state-');
	expect(await extractRecapFromJsonl(dir)).toBe(null);
});

test('extractRecapFromJsonl pulls custom-title and last-prompt', async () => {
	const d = tempDir('pappardelle-space-state-');
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
	expect(recap).toBeTruthy();
	expect(recap!.customTitle).toBe('STA-870 persist state');
	expect(recap!.lastPrompt).toBe('keep going');
});

test('extractRecapFromJsonl takes the most recent custom-title when duplicated', async () => {
	const d = tempDir('pappardelle-space-state-');
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'custom-title', customTitle: 'old title'},
		{type: 'user', message: {content: 'x'}},
		{type: 'custom-title', customTitle: 'fresh title'},
	]);
	const recap = await extractRecapFromJsonl(p);
	expect(recap!.customTitle).toBe('fresh title');
});

test('extractRecapFromJsonl captures the last assistant text snippet', async () => {
	const d = tempDir('pappardelle-space-state-');
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
	expect(recap!.lastAssistantExcerpt).toBe('second reply with more detail');
});

test('extractRecapFromJsonl truncates long assistant excerpts', async () => {
	const d = tempDir('pappardelle-space-state-');
	const p = path.join(d, 'conv.jsonl');
	const longText = 'x'.repeat(1000);
	writeJsonl(p, [
		{type: 'assistant', message: {content: [{type: 'text', text: longText}]}},
	]);
	const recap = await extractRecapFromJsonl(p);
	expect(recap!.lastAssistantExcerpt!.length <= 500).toBe(true);
});

test('extractRecapFromJsonl skips malformed lines without crashing', async () => {
	const d = tempDir('pappardelle-space-state-');
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
	expect(recap!.customTitle).toBe('valid');
});

// ============================================================================
// findLatestSessionJsonl
// ============================================================================

test('findLatestSessionJsonl returns null when project dir is missing', async () => {
	const projectsDir = tempDir('pappardelle-space-state-');
	const worktree = path.join('/Users/x', '.worktrees', 'repo', 'STA-111');
	expect(await findLatestSessionJsonl(worktree, projectsDir)).toBe(null);
});

test('findLatestSessionJsonl returns the newest top-level jsonl', async () => {
	const projectsDir = tempDir('pappardelle-space-state-');
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

	expect(await findLatestSessionJsonl(worktree, projectsDir)).toBe(newer);
});

test('findLatestSessionJsonl ignores subagent jsonls in nested dirs', async () => {
	const projectsDir = tempDir('pappardelle-space-state-');
	const worktree = '/Users/x/.worktrees/repo/STA-333';
	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(projectsDir, encoded);
	fs.mkdirSync(path.join(projectDir, 'subagents'), {recursive: true});

	const nested = path.join(projectDir, 'subagents', 'agent.jsonl');
	fs.writeFileSync(nested, '');

	expect(await findLatestSessionJsonl(worktree, projectsDir)).toBe(null);
});

test('extractRecapFromJsonl returns null when no recap-worthy entries exist', async () => {
	const d = tempDir('pappardelle-space-state-');
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'agent-setting', agentSetting: {}},
		{type: 'permission-mode', mode: 'default'},
	]);
	expect(await extractRecapFromJsonl(p)).toBe(null);
});

test('recaps reuse unchanged snapshots and refresh after append, rewrite, and replacement', async () => {
	const dir = tempDir('pappardelle-space-state-');
	const file = path.join(dir, 'session.jsonl');
	writeJsonl(file, [{type: 'custom-title', customTitle: 'first'}]);
	const first = await extractRecapFromJsonl(file);
	expect(await extractRecapFromJsonl(file)).toBe(first);
	fs.appendFileSync(
		file,
		JSON.stringify({type: 'last-prompt', lastPrompt: 'continue'}) + '\n',
	);
	expect(await extractRecapFromJsonl(file)).toStrictEqual({
		customTitle: 'first',
		lastPrompt: 'continue',
	});
	writeJsonl(file, [{type: 'custom-title', customTitle: 'reset'}]);
	expect(await extractRecapFromJsonl(file)).toStrictEqual({
		customTitle: 'reset',
	});
	const previous = fs.statSync(file);
	const replacement = path.join(dir, 'replacement.jsonl');
	writeJsonl(replacement, [{type: 'custom-title', customTitle: 'other'}]);
	fs.utimesSync(replacement, previous.atime, previous.mtime);
	fs.renameSync(replacement, file);
	expect(await extractRecapFromJsonl(file)).toStrictEqual({
		customTitle: 'other',
	});
	fs.unlinkSync(file);
	expect(await extractRecapFromJsonl(file)).toBe(null);
});

test('an incomplete last line is picked up when the writer finishes it', async () => {
	const dir = tempDir('pappardelle-space-state-');
	const file = path.join(dir, 'session.jsonl');
	fs.writeFileSync(file, '{"type":"last-prompt","lastPrompt":"keep');
	expect(await extractRecapFromJsonl(file)).toBe(null);
	fs.appendFileSync(file, ' going"}\n');
	expect(await extractRecapFromJsonl(file)).toStrictEqual({
		lastPrompt: 'keep going',
	});
});

test('large transcript scans service UI timers before completing', async () => {
	const dir = tempDir('pappardelle-space-state-');
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
	teardown(() => clearInterval(timer));
	const recap = await extractRecapFromJsonl(file);
	clearInterval(timer);
	expect(ticks > 1).toBe(true);
	expect(recap?.lastPrompt).toBe('latest');
	expect(recap?.lastAssistantExcerpt).toBe('x'.repeat(500));
});

test('a 20 MiB line spanning chunks preserves its recap and following lines', async () => {
	const dir = tempDir('pappardelle-space-state-');
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
	expect(recap?.lastAssistantExcerpt).toBe('x'.repeat(500));
	expect(recap?.lastPrompt).toBe('final line');
	console.log(
		`20 MiB single-line transcript: ${(performance.now() - start).toFixed(1)} ms`,
	);
});

test('agyTranscriptPath builds valid paths and rejects empty or traversal ids', () => {
	expect(agyTranscriptPath('abc-123', '/h')).toBe(
		'/h/.gemini/antigravity-cli/brain/abc-123/.system_generated/logs/transcript.jsonl',
	);
	for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b']) {
		expect(agyTranscriptPath(bad, '/h')).toBe(null);
	}
});

test('resolveSpaceAgentKind distinguishes claude, agy (including env wrappers), and other agents', () => {
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'STA',
		agent_profiles: {
			wrapped: {command: 'env -u FOO BAR=1 agy --model x'},
			codex: {command: 'codex'},
		},
		profiles: {dev: {display_name: 'Dev'}},
	};
	expect(resolveSpaceAgentKind(null, null)).toStrictEqual({
		kind: 'claude',
		agentProfileName: 'claude',
	});
	expect(
		resolveSpaceAgentKind(
			{agentProfile: {name: 'wrapped', isClaude: false}},
			config,
		),
	).toStrictEqual({kind: 'agy', agentProfileName: 'wrapped'});
	expect(
		resolveSpaceAgentKind(
			{agentProfile: {name: 'codex', isClaude: false}},
			config,
		),
	).toStrictEqual({kind: 'other', agentProfileName: 'codex'});
	expect(
		resolveSpaceAgentKind(
			{agentProfile: {name: 'custom-missing', isClaude: false}},
			null,
		),
	).toStrictEqual({kind: 'other', agentProfileName: 'custom-missing'});
});

test('extractRecapFromJsonl supports agy truncation and format-scoped caching', async () => {
	const d = tempDir('pappardelle-space-state-');
	const p = path.join(d, 'transcript.jsonl');
	writeJsonl(p, [
		{
			type: 'USER_INPUT',
			content: '<USER_REQUEST>\nfix bug\n</USER_REQUEST>',
		},
		{type: 'PLANNER_RESPONSE', content: 'y'.repeat(700)},
	]);
	expect(await extractRecapFromJsonl(p, 'claude')).toBe(null);
	const recap = await extractRecapFromJsonl(p, 'agy');
	expect(recap?.lastPrompt).toBe('fix bug');
	expect(recap?.lastAssistantExcerpt).toBe('y'.repeat(500));
});
