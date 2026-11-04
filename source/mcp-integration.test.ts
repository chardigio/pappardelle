// `pappardelle mcp` as a client sees it: a real stdio server running the real
// CLI against a real tmux server. tmux runs under its own TMUX_TMPDIR with
// $TMUX unset, which is what keeps it off the user's servers, and it is killed
// through its socket path only.
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import test, {type ExecutionContext} from 'ava';

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;
const entry = path.join(import.meta.dirname, 'mcp-cli.ts');
const tsx = import.meta.resolve('tsx');

function fixture(t: ExecutionContext, options: {config?: boolean} = {}) {
	const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/pm-'));
	t.teardown(() => {
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
team_prefix: STE
issue_tracker:
  provider: jira
  base_url: https://example.invalid
profiles:
  test:
    display_name: Test
`,
		);
	}

	// This suite may itself run inside a space.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^(TMUX|PAPPARDELLE_)/.test(name),
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

async function connect(
	t: ExecutionContext,
	f: ReturnType<typeof fixture>,
	env: Record<string, string> = {},
) {
	const client = new Client({name: 'test', version: '1'});
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: ['--import', tsx, entry],
			cwd: f.repo,
			env: {...f.env, ...env},
			stderr: 'ignore',
		}),
	);
	t.teardown(async () => client.close());
	return client;
}

const text = (result: unknown) =>
	(result as {content: Array<{text: string}>}).content[0]!.text;

test.serial('a repo with no config gets no tools or instructions', async t => {
	const f = fixture(t, {config: false});
	const client = await connect(t, f);
	t.is(client.getServerCapabilities()?.tools, undefined);
	t.is(client.getInstructions(), undefined);
});

test.serial(
	'spaces_list answers from the CLI in a configured repo',
	async t => {
		const f = fixture(t);
		const registry = path.join(
			f.home,
			'.pappardelle',
			'repos',
			'project',
			'open-spaces.json',
		);
		fs.mkdirSync(path.dirname(registry), {recursive: true});
		fs.writeFileSync(registry, '["STE-1"]\n');
		const client = await connect(t, f);
		t.regex(client.getInstructions() ?? '', /isn't in a space/);
		const result = await client.callTool({name: 'spaces_list', arguments: {}});
		const report = JSON.parse(text(result)) as {
			spaces: Array<{name: string; tmuxSession: string}>;
		};
		t.deepEqual(
			report.spaces.map(space => [space.name, space.tmuxSession]),
			[['STE-1', 'agent-project-STE-1']],
		);
	},
);

test.serial(
	'with no PAPPARDELLE_SPACE, the worktree path names the space for the server and the CLI',
	async t => {
		const f = fixture(t);
		const git = (...args: string[]) =>
			spawnSync(
				'git',
				['-c', 'user.email=a@b', '-c', 'user.name=a', '-C', f.repo, ...args],
				{encoding: 'utf8'},
			);
		git('commit', '--quiet', '--allow-empty', '-m', 'init');
		const tree = path.join(f.home, '.worktrees', 'project', 'KEY-9');
		git('worktree', 'add', '--quiet', tree, '-b', 'KEY-9');
		const client = await connect(t, {...f, repo: tree});
		t.regex(client.getInstructions() ?? '', /space KEY-9 \(repo project\)/);
		const result = await client.callTool({
			name: 'companion_list',
			arguments: {},
		});
		t.true(result.isError);
		t.regex(text(result), /No companion session for KEY-9/);
	},
);

test.serial(
	'link_pr verifies through gh from the source repository and saves the link',
	async t => {
		const f = fixture(t);
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
		spawnSync('git', [
			'-C',
			f.repo,
			'symbolic-ref',
			'HEAD',
			'refs/heads/KEY-5',
		]);
		const client = await connect(t, f, {
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

		t.falsy(result.isError, text(result));
		const state = JSON.parse(
			fs.readFileSync(
				path.join(
					f.home,
					'.pappardelle',
					'repos',
					'project',
					'space-state',
					'KEY-5.json',
				),
				'utf8',
			),
		) as {prLinks: Array<Record<string, unknown>>};
		t.like(state.prLinks[0], {
			project: 'o/child',
			localBranch: 'nested',
			remoteBranch: 'sd-child',
			number: 7,
		});
	},
);

test.serial('the server stops when the client closes stdin', async t => {
	const f = fixture(t);
	const child = spawn(process.execPath, ['--import', tsx, entry], {
		cwd: f.repo,
		env: f.env,
		stdio: ['pipe', 'ignore', 'ignore'],
	});
	t.teardown(() => child.kill('SIGKILL'));
	await delay(500);
	child.stdin.end();
	const [code] = await Promise.race([
		once(child, 'exit'),
		delay(10_000).then(() => ['timed out']),
	]);
	t.is(code, 0);
});

tmuxTest(
	'companion tools and space_send reach real panes, and quoting survives',
	async t => {
		const f = fixture(t);
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
		t.teardown(() => {
			if (socket.startsWith(f.tmuxDir))
				spawnSync('tmux', ['-S', socket, 'kill-server'], {env: tmuxEnv});
		});
		if (!socket.startsWith(f.tmuxDir)) {
			t.fail(`tmux is not isolated: ${socket}`);
			return;
		}

		tmux('new-session', '-d', '-s', 'agent-project-KEY-1', '-x', '200', 'cat');
		const client = await connect(t, f, {PAPPARDELLE_SPACE: 'KEY-1'});
		t.regex(client.getInstructions() ?? '', /space KEY-1 \(repo project\)/);

		const ran = await client.callTool({
			name: 'companion_run',
			arguments: {
				pane: 'side',
				split: 'right',
				command: 'echo "from a | pipe" | cat; sleep 600',
			},
		});
		t.falsy(ran.isError, text(ran));

		let shown = '';
		for (
			let attempt = 0;
			attempt < 60 && !shown.includes('from a');
			attempt++
		) {
			// eslint-disable-next-line no-await-in-loop
			shown = text(
				// eslint-disable-next-line no-await-in-loop
				await client.callTool({
					name: 'companion_read',
					arguments: {pane: 'side'},
				}),
			);
			// eslint-disable-next-line no-await-in-loop
			await delay(100);
		}

		t.regex(shown, /from a \| pipe/);

		const list = await client.callTool({name: 'companion_list', arguments: {}});
		const panes = JSON.parse(text(list)) as Array<{name: string}>;
		t.deepEqual(panes.map(pane => pane.name).sort(), ['main', 'side']);

		const tricky = `-it's "quoted" $HOME \`x\``;
		const sent = await client.callTool({
			name: 'space_send',
			arguments: {key: 'KEY-1', text: tricky},
		});
		t.falsy(sent.isError, text(sent));
		let agent = '';
		for (let attempt = 0; attempt < 40 && !agent.includes('$HOME'); attempt++) {
			agent = tmux('capture-pane', '-p', '-t', '=agent-project-KEY-1:');
			// eslint-disable-next-line no-await-in-loop
			await delay(50);
		}

		t.true(agent.includes(tricky), agent);

		const refused = await client.callTool({
			name: 'companion_close',
			arguments: {pane: 'main'},
		});
		t.true(refused.isError);
	},
);
