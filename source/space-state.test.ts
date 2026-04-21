import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getSpaceStatePath,
	readSpaceState,
	writeSpaceState,
	extractRecapFromJsonl,
	findLatestSessionJsonl,
	type SpaceState,
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
// getSpaceStatePath
// ============================================================================

test('getSpaceStatePath uses ~/.pappardelle/repos/{repo}/space-state/{space}.json', t => {
	const base = tempDir();
	const p = getSpaceStatePath('stardust-labs', 'STA-123', base);
	t.is(
		p,
		path.join(base, 'repos', 'stardust-labs', 'space-state', 'STA-123.json'),
	);
});

// ============================================================================
// readSpaceState
// ============================================================================

test('readSpaceState returns null when file does not exist', t => {
	const base = tempDir();
	t.is(readSpaceState('stardust-labs', 'STA-999', base), null);
});

test('readSpaceState returns parsed state when file exists', t => {
	const base = tempDir();
	const p = getSpaceStatePath('stardust-labs', 'STA-100', base);
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(
		p,
		JSON.stringify({
			pipeline: 'passing',
			unresolvedCommentCount: 2,
			prNumber: 849,
			updatedAt: '2026-04-21T05:00:00.000Z',
		}),
	);
	const state = readSpaceState('stardust-labs', 'STA-100', base);
	t.truthy(state);
	t.is(state!.pipeline, 'passing');
	t.is(state!.unresolvedCommentCount, 2);
	t.is(state!.prNumber, 849);
});

test('readSpaceState returns null for malformed JSON', t => {
	const base = tempDir();
	const p = getSpaceStatePath('stardust-labs', 'STA-100', base);
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, 'not valid json{{{');
	t.is(readSpaceState('stardust-labs', 'STA-100', base), null);
});

// ============================================================================
// writeSpaceState
// ============================================================================

test('writeSpaceState creates file with given fields and updatedAt', t => {
	const base = tempDir();
	writeSpaceState(
		'stardust-labs',
		'STA-200',
		{pipeline: 'failing', unresolvedCommentCount: 3, prNumber: 42},
		base,
	);
	const state = readSpaceState('stardust-labs', 'STA-200', base);
	t.truthy(state);
	t.is(state!.pipeline, 'failing');
	t.is(state!.unresolvedCommentCount, 3);
	t.is(state!.prNumber, 42);
	t.truthy(state!.updatedAt);
	// ISO 8601 sanity check
	t.regex(state!.updatedAt!, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeSpaceState merges with existing state rather than replacing it', t => {
	const base = tempDir();
	writeSpaceState(
		'stardust-labs',
		'STA-300',
		{pipeline: 'passing', unresolvedCommentCount: 0},
		base,
	);
	writeSpaceState(
		'stardust-labs',
		'STA-300',
		{recap: {customTitle: 'Refactor auth', lastPrompt: 'ship it'}},
		base,
	);
	const state = readSpaceState('stardust-labs', 'STA-300', base);
	t.is(state!.pipeline, 'passing');
	t.is(state!.unresolvedCommentCount, 0);
	t.is(state!.recap?.customTitle, 'Refactor auth');
	t.is(state!.recap?.lastPrompt, 'ship it');
});

test('writeSpaceState creates parent directories if missing', t => {
	const base = tempDir();
	// Note: base exists but repos/.../space-state does not.
	writeSpaceState(
		'stardust-labs',
		'STA-400',
		{pipeline: 'progressing_clean', unresolvedCommentCount: 1},
		base,
	);
	const p = getSpaceStatePath('stardust-labs', 'STA-400', base);
	t.true(fs.existsSync(p));
});

test('writeSpaceState serialises null pipeline as null (not undefined)', t => {
	const base = tempDir();
	writeSpaceState(
		'stardust-labs',
		'STA-500',
		{pipeline: null, unresolvedCommentCount: 0},
		base,
	);
	const raw = fs.readFileSync(
		getSpaceStatePath('stardust-labs', 'STA-500', base),
		'utf-8',
	);
	const parsed = JSON.parse(raw) as SpaceState;
	t.is(parsed.pipeline, null);
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

test('extractRecapFromJsonl returns null when file does not exist', t => {
	const d = tempDir();
	t.is(extractRecapFromJsonl(path.join(d, 'nope.jsonl')), null);
});

test('extractRecapFromJsonl pulls custom-title and last-prompt', t => {
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
	const recap = extractRecapFromJsonl(p);
	t.truthy(recap);
	t.is(recap!.customTitle, 'STA-870 persist state');
	t.is(recap!.lastPrompt, 'keep going');
});

test('extractRecapFromJsonl takes the most recent custom-title when duplicated', t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'custom-title', customTitle: 'old title'},
		{type: 'user', message: {content: 'x'}},
		{type: 'custom-title', customTitle: 'fresh title'},
	]);
	const recap = extractRecapFromJsonl(p);
	t.is(recap!.customTitle, 'fresh title');
});

test('extractRecapFromJsonl captures the last assistant text snippet', t => {
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
	const recap = extractRecapFromJsonl(p);
	t.is(recap!.lastAssistantExcerpt, 'second reply with more detail');
});

test('extractRecapFromJsonl truncates long assistant excerpts', t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	const longText = 'x'.repeat(1000);
	writeJsonl(p, [
		{type: 'assistant', message: {content: [{type: 'text', text: longText}]}},
	]);
	const recap = extractRecapFromJsonl(p);
	t.true(recap!.lastAssistantExcerpt!.length <= 500);
});

test('extractRecapFromJsonl skips malformed lines without crashing', t => {
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
	const recap = extractRecapFromJsonl(p);
	t.is(recap!.customTitle, 'valid');
});

// ============================================================================
// findLatestSessionJsonl
// ============================================================================

test('findLatestSessionJsonl returns null when project dir is missing', t => {
	const projectsDir = tempDir();
	const worktree = path.join('/Users/x', '.worktrees', 'repo', 'STA-111');
	t.is(findLatestSessionJsonl(worktree, projectsDir), null);
});

test('findLatestSessionJsonl returns the newest top-level jsonl', t => {
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

	t.is(findLatestSessionJsonl(worktree, projectsDir), newer);
});

test('findLatestSessionJsonl ignores subagent jsonls in nested dirs', t => {
	const projectsDir = tempDir();
	const worktree = '/Users/x/.worktrees/repo/STA-333';
	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(projectsDir, encoded);
	fs.mkdirSync(path.join(projectDir, 'subagents'), {recursive: true});

	const nested = path.join(projectDir, 'subagents', 'agent.jsonl');
	fs.writeFileSync(nested, '');

	t.is(findLatestSessionJsonl(worktree, projectsDir), null);
});

test('extractRecapFromJsonl returns null when no recap-worthy entries exist', t => {
	const d = tempDir();
	const p = path.join(d, 'conv.jsonl');
	writeJsonl(p, [
		{type: 'agent-setting', agentSetting: {}},
		{type: 'permission-mode', mode: 'default'},
	]);
	t.is(extractRecapFromJsonl(p), null);
});
