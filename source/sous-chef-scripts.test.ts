import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execSync} from 'node:child_process';
import test from 'ava';

// ============================================================================
// Helpers
// ============================================================================

let tempCounter = 0;

function createTempHome(): string {
	const dir = path.join(
		os.tmpdir(),
		`sous-chef-test-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

function setupDirs(home: string, repoName: string): void {
	fs.mkdirSync(
		path.join(home, '.pappardelle', 'repos', repoName, 'issue-meta'),
		{recursive: true},
	);
	fs.mkdirSync(path.join(home, '.pappardelle', 'agent-status'), {
		recursive: true,
	});
	fs.mkdirSync(path.join(home, '.claude', 'sessions'), {recursive: true});
	fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
	fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
	fs.mkdirSync(path.join(home, '.worktrees', repoName), {recursive: true});
}

/**
 * Write a Codex rollout for a worktree. Codex files rollouts under a
 * date-partitioned tree and records the cwd in the session_meta header, so both
 * the directory shape and the header matter to the lookup.
 */
function writeCodexRollout(
	home: string,
	worktreePath: string,
	lines: Array<Record<string, unknown>>,
	stamp = '2026/08/04',
): string {
	const dir = path.join(home, '.codex', 'sessions', ...stamp.split('/'));
	fs.mkdirSync(dir, {recursive: true});
	const file = path.join(
		dir,
		`rollout-${stamp.replaceAll('/', '-')}-abc.jsonl`,
	);
	const body = [
		{type: 'session_meta', payload: {id: 'abc', cwd: worktreePath}},
		...lines,
	]
		.map(l => JSON.stringify(l))
		.join('\n');
	fs.writeFileSync(file, body + '\n');
	return file;
}

function writeJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data));
}

const scriptsDir = path.resolve(
	import.meta.dirname,
	'../plugins/pappardelle/skills/sous-chef/scripts',
);

function runGather(
	home: string,
	repoName = 'test-repo',
): Record<string, unknown> {
	const result = execSync(
		`bash "${scriptsDir}/gather-spaces.sh" "${repoName}"`,
		{env: {...process.env, HOME: home}, encoding: 'utf-8'},
	);
	return JSON.parse(result) as Record<string, unknown>;
}

function runReadConversation(
	home: string,
	issueKey: string,
	repoName = 'test-repo',
	maxMessages = '20',
): Record<string, unknown> {
	const result = execSync(
		`bash "${scriptsDir}/read-conversation.sh" "${issueKey}" "${repoName}" "${maxMessages}"`,
		{env: {...process.env, HOME: home}, encoding: 'utf-8'},
	);
	return JSON.parse(result) as Record<string, unknown>;
}

// ============================================================================
// gather-spaces.sh Tests
// ============================================================================

test.serial('gather: fails when repo name argument is missing', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	const error = t.throws(() => {
		execSync(`bash "${scriptsDir}/gather-spaces.sh"`, {
			env: {...process.env, HOME: home},
			encoding: 'utf-8',
			stdio: 'pipe',
		});
	});
	t.truthy(error);
});

test.serial(
	'read-conversation: fails when repo name argument is missing',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const error = t.throws(() => {
			execSync(`bash "${scriptsDir}/read-conversation.sh" "STA-123"`, {
				env: {...process.env, HOME: home},
				encoding: 'utf-8',
				stdio: 'pipe',
			});
		});
		t.truthy(error);
	},
);

test.serial('gather: returns error when no open-spaces file exists', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	const result = runGather(home);
	t.is(result['error'], 'No open spaces file found');
	t.deepEqual(result['spaces'], []);
});

test.serial('gather: returns empty spaces for empty open-spaces array', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		[],
	);

	const result = runGather(home);
	t.is(result['totalSpaces'], 0);
	t.deepEqual(result['spaces'], []);
	t.truthy(result['timestamp']);
});

test.serial('gather: populates normalized state from agent-status files', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-100'],
	);
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-100.json'), {
		schema: 1,
		agent: 'claude',
		state: 'needs-answer',
		statusKey: 'STA-100',
		lastUpdate: Date.now(),
		sessionId: 'sess-abc',
		decoration: {tool: 'AskUserQuestion', model: 'claude-opus-5'},
	});

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces.length, 1);
	t.is(spaces[0]!['state'], 'needs-answer');
	t.is(spaces[0]!['agent'], 'claude');
	t.is(spaces[0]!['currentTool'], 'AskUserQuestion');
	t.is(spaces[0]!['model'], 'claude-opus-5');
	t.is(spaces[0]!['sessionId'], 'sess-abc');
	t.is(typeof spaces[0]!['minutesAgo'], 'number');
});

test.serial(
	'gather: reports a Codex space with the same normalized shape',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		writeJson(
			path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
			['STA-101'],
		);
		writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-101.json'), {
			schema: 1,
			agent: 'codex',
			state: 'needs-approval',
			statusKey: 'STA-101',
			lastUpdate: Date.now(),
			decoration: {tool: 'shell'},
		});

		const result = runGather(home);
		const spaces = result['spaces'] as Array<Record<string, unknown>>;
		t.is(spaces[0]!['state'], 'needs-approval');
		t.is(spaces[0]!['agent'], 'codex');
		t.is(spaces[0]!['currentTool'], 'shell');
	},
);

test.serial('gather: reports no_status when status file is missing', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-200'],
	);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['state'], 'no_status');
});

test.serial('gather: includes issue metadata when present', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-300'],
	);
	writeJson(
		path.join(
			home,
			'.pappardelle',
			'repos',
			'test-repo',
			'issue-meta',
			'STA-300.json',
		),
		{
			title: 'Fix the thing',
			state: 'In Progress',
		},
	);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	const meta = spaces[0]!['meta'] as Record<string, unknown>;
	t.is(meta['title'], 'Fix the thing');
});

test.serial(
	'gather: surfaces persisted rail-status + recap from space-state',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		writeJson(
			path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
			['STA-350'],
		);
		writeJson(
			path.join(
				home,
				'.pappardelle',
				'repos',
				'test-repo',
				'space-state',
				'STA-350.json',
			),
			{
				pipeline: 'failing',
				unresolvedCommentCount: 4,
				prNumber: 777,
				recap: {
					customTitle: 'refactor auth',
					lastPrompt: 'ship it',
					lastAssistantExcerpt: 'tests pass, awaiting review',
				},
				updatedAt: '2026-04-21T05:00:00.000Z',
			},
		);

		const result = runGather(home);
		const spaces = result['spaces'] as Array<Record<string, unknown>>;
		t.is(spaces[0]!['pipeline'], 'failing');
		t.is(spaces[0]!['unresolvedCommentCount'], 4);
		t.is(spaces[0]!['prNumber'], 777);
		t.is(spaces[0]!['spaceStateUpdatedAt'], '2026-04-21T05:00:00.000Z');
		const recap = spaces[0]!['recap'] as Record<string, unknown>;
		t.is(recap['customTitle'], 'refactor auth');
		t.is(recap['lastPrompt'], 'ship it');
	},
);

test.serial(
	'gather: omits rail-status + recap fields when space-state file is absent',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		writeJson(
			path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
			['STA-360'],
		);

		const result = runGather(home);
		const spaces = result['spaces'] as Array<Record<string, unknown>>;
		t.false('pipeline' in spaces[0]!);
		t.false('unresolvedCommentCount' in spaces[0]!);
		t.false('recap' in spaces[0]!);
	},
);

test.serial('gather: handles malformed space-state file gracefully', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-370'],
	);
	const spaceStateFile = path.join(
		home,
		'.pappardelle',
		'repos',
		'test-repo',
		'space-state',
		'STA-370.json',
	);
	fs.mkdirSync(path.dirname(spaceStateFile), {recursive: true});
	fs.writeFileSync(spaceStateFile, 'not json{{{');

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	// Should not crash; should not include rail-status fields
	t.false('pipeline' in spaces[0]!);
});

test.serial('gather: matches sessions using full worktree prefix', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-400'],
	);
	writeJson(path.join(home, '.claude', 'sessions', 'sess1.json'), {
		pid: 12345,
		cwd: `${home}/.worktrees/test-repo/STA-400`,
	});

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['pid'], 12345);
	t.is(spaces[0]!['worktreePath'], `${home}/.worktrees/test-repo/STA-400`);
});

test.serial('gather: does not match sessions from similarly-named repos', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	fs.mkdirSync(path.join(home, '.worktrees', 'test-repo-api'), {
		recursive: true,
	});
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-500'],
	);
	// Session is in test-repo-api, not test-repo
	writeJson(path.join(home, '.claude', 'sessions', 'sess2.json'), {
		pid: 99999,
		cwd: `${home}/.worktrees/test-repo-api/STA-500`,
	});

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['pid'], undefined);
});

test.serial(
	'gather: prefers most recent session when multiple match same issue key',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		writeJson(
			path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
			['STA-450'],
		);
		// Stale session (older startedAt)
		writeJson(path.join(home, '.claude', 'sessions', 'stale.json'), {
			pid: 11111,
			cwd: `${home}/.worktrees/test-repo/STA-450`,
			startedAt: '2026-01-01T00:00:00Z',
		});
		// Fresh session (newer startedAt)
		writeJson(path.join(home, '.claude', 'sessions', 'fresh.json'), {
			pid: 22222,
			cwd: `${home}/.worktrees/test-repo/STA-450`,
			startedAt: '2026-04-01T00:00:00Z',
		});

		const result = runGather(home);
		const spaces = result['spaces'] as Array<Record<string, unknown>>;
		t.is(spaces[0]!['pid'], 22222);
	},
);

test.serial('gather: sorts spaces by lastUpdate descending', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	const now = Date.now();
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-OLD', 'STA-NEW', 'STA-MID'],
	);
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-OLD.json'), {
		agent: 'claude',
		state: 'done',
		lastUpdate: now - 60_000,
	});
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-NEW.json'), {
		agent: 'claude',
		state: 'working',
		lastUpdate: now,
	});
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-MID.json'), {
		agent: 'codex',
		state: 'idle',
		lastUpdate: now - 30_000,
	});

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['name'], 'STA-NEW');
	t.is(spaces[1]!['name'], 'STA-MID');
	t.is(spaces[2]!['name'], 'STA-OLD');
});

test.serial('gather: generates correct tmux session name', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-600'],
	);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['tmuxSession'], 'claude-test-repo-STA-600');
});

test.serial('gather: handles malformed status file gracefully', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-700'],
	);
	fs.writeFileSync(
		path.join(home, '.pappardelle', 'agent-status', 'STA-700.json'),
		'not valid json{{{',
	);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['state'], 'unknown');
});

test.serial('gather: finds conversation log in projects dir', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-800'],
	);

	// Create the encoded project dir with a JSONL file
	const worktreePath = `${home}/.worktrees/test-repo/STA-800`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});
	fs.writeFileSync(
		path.join(projectDir, 'conversation.jsonl'),
		'{"type":"user"}\n',
	);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.truthy(spaces[0]!['conversationLog']);
	t.truthy(spaces[0]!['logModified']);
});

// ============================================================================
// read-conversation.sh Tests
// ============================================================================

test.serial('read-conversation: returns error when project dir missing', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	const result = runReadConversation(home, 'STA-999');
	t.is(result['issueKey'], 'STA-999');
	t.truthy(result['error']);
});

test.serial('read-conversation: returns error when no JSONL files exist', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	// Create project dir but no JSONL files
	const worktreePath = `${home}/.worktrees/test-repo/STA-100`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const result = runReadConversation(home, 'STA-100');
	t.is(result['error'], 'No conversation log found for STA-100');
});

test.serial('read-conversation: extracts user and assistant messages', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	const worktreePath = `${home}/.worktrees/test-repo/STA-200`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const lines = [
		JSON.stringify({
			type: 'user',
			message: {content: 'Hello world'},
			timestamp: 1000,
		}),
		JSON.stringify({
			type: 'assistant',
			message: {content: 'Hi there'},
			timestamp: 2000,
		}),
		JSON.stringify({
			type: 'system',
			message: {content: 'ignored'},
			timestamp: 3000,
		}),
	].join('\n');
	fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

	const result = runReadConversation(home, 'STA-200');
	t.is(result['totalMessages'], 2);
	const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
	t.is(msgs.length, 2);
	t.is(msgs[0]!['role'], 'user');
	t.is(msgs[0]!['text'], 'Hello world');
	t.is(msgs[1]!['role'], 'assistant');
	t.is(msgs[1]!['text'], 'Hi there');
});

test.serial('read-conversation: handles list-style content blocks', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	const worktreePath = `${home}/.worktrees/test-repo/STA-300`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const lines = [
		JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{type: 'text', text: 'Part one'},
					{type: 'tool_use', id: 'tool1'},
					{type: 'text', text: 'Part two'},
				],
			},
			timestamp: 1000,
		}),
	].join('\n');
	fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

	const result = runReadConversation(home, 'STA-300');
	const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
	t.is(msgs.length, 1);
	t.is(msgs[0]!['text'], 'Part one Part two');
});

test.serial('read-conversation: respects max-messages limit', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	const worktreePath = `${home}/.worktrees/test-repo/STA-400`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const lines = Array.from({length: 10}, (_, i) =>
		JSON.stringify({
			type: 'user',
			message: {content: `Message ${i}`},
			timestamp: i * 1000,
		}),
	).join('\n');
	fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

	const result = runReadConversation(home, 'STA-400', 'test-repo', '3');
	t.is(result['totalMessages'], 10);
	const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
	t.is(msgs.length, 3);
	// Should be the last 3
	t.is(msgs[0]!['text'], 'Message 7');
	t.is(msgs[2]!['text'], 'Message 9');
});

test.serial('read-conversation: skips malformed JSON lines', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');

	const worktreePath = `${home}/.worktrees/test-repo/STA-500`;
	const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
	const projectDir = path.join(home, '.claude', 'projects', encoded);
	fs.mkdirSync(projectDir, {recursive: true});

	const lines = [
		'not json at all',
		'',
		JSON.stringify({
			type: 'user',
			message: {content: 'Valid message'},
			timestamp: 1000,
		}),
	].join('\n');
	fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

	const result = runReadConversation(home, 'STA-500');
	t.is(result['totalMessages'], 1);
	const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
	t.is(msgs[0]!['text'], 'Valid message');
});

test.serial(
	'read-conversation: skips assistant messages with empty text',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');

		const worktreePath = `${home}/.worktrees/test-repo/STA-600`;
		const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
		const projectDir = path.join(home, '.claude', 'projects', encoded);
		fs.mkdirSync(projectDir, {recursive: true});

		const lines = [
			JSON.stringify({
				type: 'assistant',
				message: {content: ''},
				timestamp: 1000,
			}),
			JSON.stringify({
				type: 'assistant',
				message: {content: '   '},
				timestamp: 2000,
			}),
			JSON.stringify({
				type: 'assistant',
				message: {content: 'Actual response'},
				timestamp: 3000,
			}),
		].join('\n');
		fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

		const result = runReadConversation(home, 'STA-600');
		t.is(result['totalMessages'], 1);
		const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
		t.is(msgs[0]!['text'], 'Actual response');
	},
);

test.serial(
	'read-conversation: truncates long string content to 500 chars',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');

		const worktreePath = `${home}/.worktrees/test-repo/STA-700`;
		const encoded = worktreePath.replaceAll('/', '-').replaceAll('.', '-');
		const projectDir = path.join(home, '.claude', 'projects', encoded);
		fs.mkdirSync(projectDir, {recursive: true});

		const longText = 'x'.repeat(1000);
		const lines = [
			JSON.stringify({
				type: 'user',
				message: {content: longText},
				timestamp: 1000,
			}),
		].join('\n');
		fs.writeFileSync(path.join(projectDir, 'conv.jsonl'), lines);

		const result = runReadConversation(home, 'STA-700');
		const msgs = result['recentMessages'] as Array<Record<string, unknown>>;
		t.is((msgs[0]!['text'] as string).length, 500);
	},
);

// ============================================================================
// Codex transcripts (STA-1850)
// ============================================================================

test.serial('gather: finds a Codex rollout by its session_meta cwd', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(
		path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
		['STA-800'],
	);
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-800.json'), {
		agent: 'codex',
		state: 'working',
		lastUpdate: Date.now(),
	});
	const worktree = path.join(home, '.worktrees', 'test-repo', 'STA-800');
	const rollout = writeCodexRollout(home, worktree, [
		{type: 'event_msg', payload: {type: 'user_message', message: 'hi'}},
	]);

	const result = runGather(home);
	const spaces = result['spaces'] as Array<Record<string, unknown>>;
	t.is(spaces[0]!['conversationLog'], rollout);
});

test.serial(
	'gather: ignores a Codex rollout belonging to a different worktree',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		writeJson(
			path.join(home, '.pappardelle', 'repos', 'test-repo', 'open-spaces.json'),
			['STA-801'],
		);
		writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-801.json'), {
			agent: 'codex',
			state: 'working',
			lastUpdate: Date.now(),
		});
		writeCodexRollout(home, '/somewhere/else/entirely', [
			{type: 'event_msg', payload: {type: 'user_message', message: 'hi'}},
		]);

		const result = runGather(home);
		const spaces = result['spaces'] as Array<Record<string, unknown>>;
		t.is(spaces[0]!['conversationLog'], undefined);
	},
);

test.serial('read-conversation: parses a Codex rollout', t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	writeJson(path.join(home, '.pappardelle', 'agent-status', 'STA-802.json'), {
		agent: 'codex',
		state: 'done',
		lastUpdate: Date.now(),
	});
	const worktree = path.join(home, '.worktrees', 'test-repo', 'STA-802');
	writeCodexRollout(home, worktree, [
		{
			type: 'event_msg',
			payload: {type: 'user_message', message: 'fix the bug'},
		},
		{
			type: 'event_msg',
			payload: {
				type: 'agent_message',
				message: 'looking at it now',
				phase: 'commentary',
			},
		},
		{
			type: 'event_msg',
			payload: {
				type: 'agent_message',
				message: 'fixed it',
				phase: 'final_answer',
			},
		},
	]);

	const result = runReadConversation(home, 'STA-802');
	t.is(result['agent'], 'codex');
	const messages = result['recentMessages'] as Array<Record<string, unknown>>;
	// Mid-turn `commentary` narration is dropped — only final answers count as
	// something the agent actually said to the human.
	t.deepEqual(
		messages.map(m => [m['role'], m['text']]),
		[
			['user', 'fix the bug'],
			['assistant', 'fixed it'],
		],
	);
});

test.serial(
	'read-conversation: defaults to Claude when there is no status file',
	t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const result = runReadConversation(home, 'STA-803');
		t.is(result['agent'], 'claude');
	},
);
