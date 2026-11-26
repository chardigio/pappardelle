// `pappardelle mcp` as a client sees it: a real stdio server running the real
// CLI against a real tmux server. tmux runs under its own TMUX_TMPDIR with
// $TMUX unset, which is what keeps it off the user's servers, and it is killed
// through its socket path only.
import {tmpdir} from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {test, expect} from 'bun:test';
import {tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {until, untilValue} from '../test/helpers/wait.ts';
import {createStateDaos} from './state-daos.ts';
import {closeStateDb, stateDbPath} from './state-db.ts';

const entry = path.join(import.meta.dirname, 'mcp-cli.ts');

function fixture(options: {config?: boolean; aware?: boolean} = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(`${tmpdir()}/pm-`));
	teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const repo = path.join(root, 'project');
	const home = path.join(root, 'home');
	const tmuxDir = path.join(root, 't');
	for (const dir of [repo, home, tmuxDir]) fs.mkdirSync(dir);
	spawnSync('git', ['init', '--quiet', repo]);
	if (options.config !== false) {
		fs.writeFileSync(
			path.join(repo, '.pappardelle.yml'),
			`version: 1
${options.aware === false ? '' : 'workspace_aware_agents: true\n'}team_prefix: STE
issue_tracker:
  provider: jira
  base_url: https://example.invalid
profiles:
  test:
    display_name: Test
`,
		);
	}

	// This suite may itself run inside a space. A status socket the run names
	// is kept. The children's database is under their throwaway HOME.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				name === 'PAPPARDELLE_STATUS_SOCKET' ||
				!/^(TMUX|PAPPARDELLE_)/.test(name),
		),
	) as Record<string, string>;
	const env: Record<string, string> = {
		...inherited,
		HOME: home,
		SHELL: '/bin/sh',
		TMUX_TMPDIR: tmuxDir,
	};
	return {root, repo, home, tmuxDir, env};
}

/** Record a space as idow does before it starts the space's sessions. */
function prepareSpace(
	f: ReturnType<typeof fixture>,
	key: string,
	worktree = f.repo,
) {
	const recorded = spawnSync(
		process.execPath,
		[
			path.join(import.meta.dirname, 'state-cli.ts'),
			'prepare-space',
			'--repo',
			'project',
			'--worktree',
			worktree,
			'--main-root',
			f.repo,
			'--register',
			'--owner',
			String(process.pid),
			key,
		],
		{env: f.env, encoding: 'utf8'},
	);
	expect(recorded.status, recorded.stderr).toBe(0);
}

async function connect(
	f: ReturnType<typeof fixture>,
	env: Record<string, string> = {},
) {
	const client = new Client({name: 'test', version: '1'});
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [entry],
			cwd: f.repo,
			env: {...f.env, ...env},
			stderr: 'ignore',
		}),
	);
	teardown(async () => client.close());
	return client;
}

const text = (result: unknown) =>
	(result as {content: Array<{text: string}>}).content[0]!.text;

test('a repo with no config gets no tools or instructions', async () => {
	const f = fixture({config: false});
	const client = await connect(f);
	expect(client.getServerCapabilities()?.tools).toBe(undefined);
	expect(client.getInstructions()).toBe(undefined);
});

test('a repo that leaves workspace_aware_agents off gets no tools or instructions', async () => {
	const f = fixture({aware: false});
	const client = await connect(f);
	expect(client.getServerCapabilities()?.tools).toBe(undefined);
	expect(client.getInstructions()).toBe(undefined);
});

test('spaces_list answers from the CLI in a configured repo', async () => {
	const f = fixture();
	const registry = path.join(
		f.home,
		'.pappardelle',
		'repos',
		'project',
		'open-spaces.json',
	);
	fs.mkdirSync(path.dirname(registry), {recursive: true});
	fs.writeFileSync(registry, '["STE-1"]\n');
	const client = await connect(f);
	expect(client.getInstructions() ?? '').toMatch(/isn't in a space/);
	const result = await client.callTool({name: 'spaces_list', arguments: {}});
	const report = JSON.parse(text(result)) as {
		spaces: Array<{name: string; tmuxSession: string}>;
	};
	expect(
		report.spaces.map(space => [space.name, space.tmuxSession]),
	).toStrictEqual([['STE-1', 'agent-project-STE-1']]);
});

test('with no PAPPARDELLE_SPACE, the worktree path names the space for the server and the CLI', async () => {
	const f = fixture();
	const git = (...args: string[]) =>
		spawnSync(
			'git',
			['-c', 'user.email=a@b', '-c', 'user.name=a', '-C', f.repo, ...args],
			{encoding: 'utf8'},
		);
	git('commit', '--quiet', '--allow-empty', '-m', 'init');
	const tree = path.join(f.home, '.worktrees', 'project', 'KEY-9');
	git('worktree', 'add', '--quiet', tree, '-b', 'KEY-9');
	prepareSpace(f, 'KEY-9', tree);
	const client = await connect({...f, repo: tree});
	expect(client.getInstructions() ?? '').toMatch(
		/space KEY-9 \(repo project\)/,
	);
	const result = await client.callTool({
		name: 'companion_list',
		arguments: {},
	});
	expect(result.isError).toBe(true);
	expect(text(result)).toMatch(/No companion session for KEY-9/);
});

test('link_pr verifies through gh from the source repository and saves the link', async () => {
	const f = fixture();
	const bin = path.join(f.root, 'bin');
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, 'gh'),
		`#!/bin/sh
echo '{"state":"open","number":7,"head":{"repo":{"full_name":"o/child"},"ref":"sd-child"}}'
`,
		{mode: 0o755},
	);
	const child = path.join(f.repo, 'child');
	fs.mkdirSync(child);
	spawnSync('git', ['init', '--quiet', '-b', 'nested', child]);
	spawnSync('git', [
		'-C',
		child,
		'remote',
		'add',
		'origin',
		'git@github.com:o/child.git',
	]);
	spawnSync('git', ['-C', f.repo, 'symbolic-ref', 'HEAD', 'refs/heads/KEY-5']);
	const client = await connect(f, {
		PATH: `${bin}:${f.env['PATH'] ?? ''}`,
	});

	const result = await client.callTool({
		name: 'link_pr',
		arguments: {
			url: 'https://github.com/o/child/pull/7',
			repository: child,
			workspace: f.repo,
		},
	});

	expect(result.isError, text(result)).toBeFalsy();
	const stateDir = path.join(f.home, '.pappardelle');
	const daos = createStateDaos({repo: 'project', stateDir, home: f.home});
	teardown(() => {
		daos.disconnectStatusDaemon();
		closeStateDb(stateDbPath(stateDir));
	});
	expect(daos.spaceState.read('KEY-5')?.prLinks?.[0]).toMatchObject({
		project: 'o/child',
		localBranch: 'nested',
		remoteBranch: 'sd-child',
		number: 7,
	});
});

test('the server stops when the client closes stdin', async () => {
	const f = fixture();
	const child = spawn(process.execPath, [entry], {
		cwd: f.repo,
		env: f.env,
		stdio: ['pipe', 'ignore', 'ignore'],
	});
	teardown(() => child.kill('SIGKILL'));
	await delay(500);
	child.stdin.end();
	const [code] = await Promise.race([
		once(child, 'exit'),
		delay(10_000).then(() => ['timed out']),
	]);
	expect(code).toBe(0);
});

tmuxTest(
	'companion tools and space_send reach real panes, and quoting survives',
	async () => {
		const f = fixture();
		const tmuxEnv = f.env;
		const tmux = (...args: string[]) => {
			const r = spawnSync('tmux', ['-L', 'pappardelle_inner', ...args], {
				encoding: 'utf8',
				env: tmuxEnv,
				timeout: 5000,
			});
			if (r.status !== 0) throw new Error(`tmux ${args[0]}: ${r.stderr}`);
			return r.stdout.trim();
		};

		tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'companion-project-KEY-1', 'sleep 600'); // prettier-ignore
		const socket = tmux('display-message', '-p', '#{socket_path}');
		teardown(() => {
			if (socket.startsWith(f.tmuxDir))
				spawnSync('tmux', ['-S', socket, 'kill-server'], {env: tmuxEnv});
		});
		if (!socket.startsWith(f.tmuxDir)) {
			expect.unreachable(`tmux is not isolated: ${socket}`);
			return;
		}

		tmux('new-session', '-d', '-s', 'agent-project-KEY-1', '-x', '200', 'cat');
		prepareSpace(f, 'KEY-1');
		const client = await connect(f, {PAPPARDELLE_SPACE: 'KEY-1'});
		expect(client.getInstructions() ?? '').toMatch(
			/space KEY-1 \(repo project\)/,
		);

		const ran = await client.callTool({
			name: 'companion_run',
			arguments: {
				pane: 'side',
				split: 'right',
				command: 'echo "from a | pipe" | cat; sleep 600',
			},
		});
		expect(ran.isError, text(ran)).toBeFalsy();

		const shown = await untilValue(
			async () =>
				text(
					await client.callTool({
						name: 'companion_read',
						arguments: {pane: 'side'},
					}),
				),
			screen => screen.includes('from a'),
			{
				what: 'the side pane to show the command',
				timeoutMs: 6000,
				intervalMs: 100,
			},
		);

		expect(shown).toMatch(/from a \| pipe/);

		const list = await client.callTool({name: 'companion_list', arguments: {}});
		const panes = JSON.parse(text(list)) as Array<{name: string}>;
		expect(panes.map(pane => pane.name).sort()).toStrictEqual(['main', 'side']);

		const tricky = `-it's "quoted" $HOME \`x\``;
		const sent = await client.callTool({
			name: 'space_send',
			arguments: {key: 'KEY-1', text: tricky},
		});
		expect(sent.isError, text(sent)).toBeFalsy();
		const agent = await untilValue(
			() => tmux('capture-pane', '-p', '-t', '=agent-project-KEY-1:'),
			screen => screen.includes('$HOME'),
			{what: 'the sent text in the agent pane', intervalMs: 50},
		);

		expect(agent.includes(tricky), agent).toBe(true);

		const refused = await client.callTool({
			name: 'companion_close',
			arguments: {pane: 'main'},
		});
		expect(refused.isError).toBe(true);
	},
);

tmuxTest(
	'space_state reads a real prompt, space_answer approves cleanup and holds a push, space_wait sees it finish',
	async () => {
		const f = fixture();
		const tmuxEnv = f.env;
		const tmux = (...args: string[]) => {
			const r = spawnSync('tmux', ['-L', 'pappardelle_inner', ...args], {
				encoding: 'utf8',
				env: tmuxEnv,
				timeout: 5000,
			});
			if (r.status !== 0) throw new Error(`tmux ${args[0]}: ${r.stderr}`);
			return r.stdout.trim();
		};

		tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'seed', 'sleep 600'); // prettier-ignore
		const socket = tmux('display-message', '-p', '#{socket_path}');
		teardown(() => {
			if (socket.startsWith(f.tmuxDir))
				spawnSync('tmux', ['-S', socket, 'kill-server'], {env: tmuxEnv});
		});
		if (!socket.startsWith(f.tmuxDir)) {
			expect.unreachable(`tmux is not isolated: ${socket}`);
			return;
		}

		// A stand-in agent: shows a Claude permission prompt for `command`,
		// records the one key it gets, then drops to an idle prompt. It clears
		// the screen and the scrollback, as clear does, with the escapes
		// themselves: macOS's clear has no terminfo for tmux's terminal and
		// leaves the prompt up.
		const agent = (key: string, command: string) => {
			const prompt = path.join(f.root, `${key}.prompt`);
			fs.writeFileSync(
				prompt,
				[
					'─'.repeat(40),
					' Bash command',
					' Tidy up',
					'╌'.repeat(40),
					` ${command}`,
					'╌'.repeat(40),
					' Do you want to proceed?',
					' ❯ 1. Yes',
					'   2. No',
					' Esc to cancel',
					'',
				].join('\n'),
			);
			prepareSpace(f, key);
			const answered = path.join(f.root, `${key}.answer`);
			tmux('new-session', '-d', '-s', `agent-project-${key}`, '-x', '120', `bash -c 'cat ${prompt}; read -rn1 k; echo "$k" > ${answered}; printf "\\033[H\\033[2J\\033[3J"; echo "❯ "; sleep 600'`); // prettier-ignore
			return answered;
		};

		const cleanup = agent('STE-2', 'rm -rf /tmp/q-abc');
		const push = agent('STE-3', 'git push origin main');
		// The approval check runs `claude -p`; this one says yes and keeps what it was asked.
		const bin = path.join(f.root, 'bin');
		const asked = path.join(f.root, 'asked');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat > ${asked}\necho '{"structured_output":{"approve":true,"reason":"local cleanup"}}'\n`, {mode: 0o755}); // prettier-ignore
		await delay(500);
		// The sous-chef, which answers for the spaces.
		const client = await connect(f, {
			PAPPARDELLE_SPACE: 'main',
			PATH: `${bin}:${f.env['PATH'] ?? ''}`,
		});
		const call = async (name: string, args: Record<string, unknown>) =>
			client.callTool({name, arguments: args});

		const state = JSON.parse(
			text(await call('space_state', {key: 'STE-2'})),
		) as {
			state: string;
			permission: {command: string};
		};
		expect(state.state).toBe('permission');
		expect(state.permission.command).toBe('rm -rf /tmp/q-abc');

		const approved = await call('space_answer', {key: 'STE-2', option: 1});
		expect(approved.isError, text(approved)).toBeFalsy();
		const waited = JSON.parse(
			text(
				await call('space_wait', {
					key: 'STE-2',
					until: 'idle',
					timeout_seconds: 20,
				}),
			),
		) as {state: string; timedOut: boolean};
		expect(waited).toMatchObject({state: 'idle', timedOut: false});
		expect(fs.readFileSync(cleanup, 'utf8').trim()).toBe('1');
		expect(fs.existsSync(push)).toBe(false);
		expect(fs.readFileSync(asked, 'utf8')).toMatch(
			/Call:\nrm -rf \/tmp\/q-abc/,
		);

		const sentIntoPrompt = await call('space_send', {
			key: 'STE-3',
			text: '1',
			force: true,
		});
		expect(sentIntoPrompt.isError).toBe(true);
		expect(fs.existsSync(push)).toBe(false);

		// A push to main is held: declined with No, and kept for the chef.
		// This space has no worktree on disk, so any push from it holds.
		const held = await call('space_answer', {key: 'STE-3', option: 1});
		expect(held.isError, text(held)).toBeFalsy();
		expect(text(held)).toMatch(/^Held h\w+: a push .+\ngit push origin main/);
		await until(() => fs.existsSync(push), {
			what: 'the push prompt to be declined',
		});
		expect(fs.readFileSync(push, 'utf8').trim()).toBe('2');
		const holds = JSON.parse(text(await call('space_holds', {}))) as Array<{
			key: string;
			state: string;
		}>;
		expect(holds[0]).toMatchObject({key: 'STE-3', state: 'open'});

		const log = fs
			.readFileSync(
				path.join(
					f.home,
					'.pappardelle',
					'repos',
					'project',
					'supervise.jsonl',
				),
				'utf8',
			)
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as Record<string, string>);
		expect(log[0]).toMatchObject({
			caller: 'main',
			key: 'STE-2',
			verdict: 'allowed: local cleanup',
		});
		expect(log[1]).toMatchObject({
			caller: 'main',
			action: 'send',
			key: 'STE-3',
			detail: 'prompt',
		});
		expect(log[2]).toMatchObject({
			caller: 'main',
			action: 'hold',
			key: 'STE-3',
			command: 'git push origin main',
		});
	},
);
