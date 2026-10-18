import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
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
	fs.mkdirSync(path.join(home, '.pappardelle', 'claude-status'), {
		recursive: true,
	});
	fs.mkdirSync(path.join(home, '.claude', 'sessions'), {recursive: true});
	fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
	fs.mkdirSync(path.join(home, '.worktrees', repoName), {recursive: true});
}

function writeJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data));
}

const scriptsDir = path.resolve(
	import.meta.dirname,
	'../plugins/pappardelle/skills/sous-chef/scripts',
);

// ============================================================================
// wait-for-agent.sh Tests
// ============================================================================

async function runWaitForAgent(
	home: string,
	options: {
		since: number;
		timeoutSecs?: number;
		duringWait?: () => void;
	},
): Promise<number | null> {
	const child = spawn(
		'bash',
		[
			`${scriptsDir}/wait-for-agent.sh`,
			'test-repo',
			'TEST-1',
			String(options.since),
		],
		{
			env: {
				...process.env,
				HOME: home,
				SC_WAIT_TIMEOUT_SECS: String(options.timeoutSecs ?? 0),
			},
			stdio: 'ignore',
		},
	);
	if (options.duringWait) setTimeout(options.duringWait, 300);
	return new Promise(resolve => {
		child.on('exit', code => {
			resolve(code);
		});
	});
}

function agentWorktree(home: string): string {
	return path.join(home, '.worktrees', 'test-repo', 'TEST-1');
}

function writeAgentStatus(
	home: string,
	status: {event: string; cwd: string; lastUpdate: number},
): void {
	writeJson(path.join(home, '.pappardelle', 'claude-status', 'TEST-1.json'), {
		status: 'waiting_for_input',
		...status,
	});
}

test.serial(
	'wait-for-agent: succeeds on a fresh SessionStart from the repo worktree',
	async t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const since = Date.now();
		writeAgentStatus(home, {
			event: 'SessionStart',
			cwd: agentWorktree(home),
			lastUpdate: since,
		});
		t.is(await runWaitForAgent(home, {since}), 0);
	},
);

test.serial(
	'wait-for-agent: times out on a status written before the reopen',
	async t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const since = Date.now();
		writeAgentStatus(home, {
			event: 'SessionStart',
			cwd: agentWorktree(home),
			lastUpdate: since - 1,
		});
		t.is(await runWaitForAgent(home, {since}), 1);
	},
);

test.serial(
	"wait-for-agent: times out on another repo's space with the same key",
	async t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const since = Date.now();
		writeAgentStatus(home, {
			event: 'SessionStart',
			cwd: path.join(home, '.worktrees', 'test-repo-other', 'TEST-1'),
			lastUpdate: since,
		});
		t.is(await runWaitForAgent(home, {since}), 1);
	},
);

test.serial(
	'wait-for-agent: succeeds when a later event replaced SessionStart',
	async t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const since = Date.now();
		writeAgentStatus(home, {
			event: 'Stop',
			cwd: agentWorktree(home),
			lastUpdate: since,
		});
		t.is(await runWaitForAgent(home, {since}), 0);
	},
);

test.serial('wait-for-agent: times out when the agent ended', async t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	const since = Date.now();
	writeAgentStatus(home, {
		event: 'SessionEnd',
		cwd: agentWorktree(home),
		lastUpdate: since,
	});
	t.is(await runWaitForAgent(home, {since}), 1);
});

test.serial('wait-for-agent: times out without a status file', async t => {
	const home = createTempHome();
	setupDirs(home, 'test-repo');
	t.is(await runWaitForAgent(home, {since: Date.now()}), 1);
});

test.serial(
	'wait-for-agent: succeeds when the agent starts during the wait',
	async t => {
		const home = createTempHome();
		setupDirs(home, 'test-repo');
		const since = Date.now();
		const exitCode = await runWaitForAgent(home, {
			since,
			timeoutSecs: 10,
			duringWait() {
				writeAgentStatus(home, {
					event: 'SessionStart',
					cwd: agentWorktree(home),
					lastUpdate: Date.now(),
				});
			},
		});
		t.is(exitCode, 0);
	},
);
