import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	attachedPartnerSessions,
	buildAttachCommand,
	buildPartnerLaunchCommand,
	describePartners,
	isPartnerAgentName,
	keptSessionKeys,
	listPartnerAgents,
	partnerAgentRows,
	partnerAgentStatusKey,
	resolvePartnerSessionLaunch,
	validatePartnerAgents,
} from './partner-agents.ts';
import type {ResolvedAgentProfile} from './config.ts';

// Status keys depend on which hook files exist, so read from an empty dir.
const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-status-'));
process.env['PAPPARDELLE_STATUS_DIR'] = statusDir;

const PROFILES = new Set(['claude', 'codex']);

test('no agents key validates and lists nothing (off by default)', t => {
	t.deepEqual(validatePartnerAgents(undefined, PROFILES), []);
	t.deepEqual(listPartnerAgents({profiles: {}, version: 1}), []);
});

test('listPartnerAgents keeps config order', t => {
	const agents = listPartnerAgents({
		version: 1,
		profiles: {},
		agents: {
			trotbot: {emoji: '🐴', attach: {socket: 'trotbot', session: 'trotbot'}},
			reviewer: {agent_profile: 'codex'},
		},
	});
	t.deepEqual(
		agents.map(agent => agent.name),
		['trotbot', 'reviewer'],
	);
	t.is(agents[0]!.emoji, '🐴');
});

test('validatePartnerAgents accepts a normal agent and an attach agent', t => {
	t.deepEqual(
		validatePartnerAgents(
			{
				reviewer: {
					emoji: '🔍',
					agent_profile: 'codex',
					initialization_command: '/review-queue',
				},
				trotbot: {attach: {socket: 'trotbot', session: 'trotbot'}},
				scribe: {},
			},
			PROFILES,
		),
		[],
	);
});

test('validatePartnerAgents rejects a non-object map', t => {
	t.deepEqual(validatePartnerAgents(['a'], PROFILES), [
		'agents: must be an object',
	]);
});

test('validatePartnerAgents rejects names that could collide with a space', t => {
	const errors = validatePartnerAgents(
		{main: {}, 'STA-1': {}, 'has space': {}},
		PROFILES,
	);
	t.true(errors.some(error => error.startsWith('agents.main:')));
	t.true(errors.some(error => error.startsWith('agents.STA-1:')));
	t.true(errors.some(error => error.startsWith('agents.has space:')));
});

test('validatePartnerAgents checks field types and profile references', t => {
	const errors = validatePartnerAgents(
		{
			a: {emoji: 3},
			b: {agent_profile: 'nope'},
			c: {initialization_command: 7},
			d: 'x',
		},
		PROFILES,
	);
	t.true(errors.includes('agents.a.emoji: must be a string'));
	t.true(
		errors.includes(
			'agents.b.agent_profile: agent profile "nope" not found in agent_profiles',
		),
	);
	t.true(errors.includes('agents.c.initialization_command: must be a string'));
	t.true(errors.includes('agents.d: must be an object'));
});

test('validatePartnerAgents rejects a half-set or mixed attach', t => {
	const errors = validatePartnerAgents(
		{
			a: {attach: {socket: 'x'}},
			b: {attach: {socket: 'x', session: 'y'}, agent_profile: 'codex'},
			c: {attach: 'x'},
			d: {
				attach: {socket: 'x', session: 'y'},
				initialization_command: '/go',
			},
		},
		PROFILES,
	);
	t.true(errors.includes('agents.a.attach.session: required non-empty string'));
	t.true(
		errors.includes(
			'agents.b: agent_profile does not apply to an attach agent',
		),
	);
	t.true(errors.includes('agents.c.attach: must be an object'));
	t.true(
		errors.includes(
			'agents.d: initialization_command does not apply to an attach agent',
		),
	);
});

test('isPartnerAgentName only takes lowercase slugs other than main', t => {
	t.true(isPartnerAgentName('trotbot'));
	t.true(isPartnerAgentName('code-review_2'));
	t.false(isPartnerAgentName('main'));
	t.false(isPartnerAgentName('STA-12'));
	t.false(isPartnerAgentName('9lives'));
	t.false(isPartnerAgentName(''));
});

test('partnerAgentStatusKey qualifies the name with the repo, as the hook does', t => {
	t.is(
		partnerAgentStatusKey('stardust-labs', 'trotbot'),
		'stardust-labs-trotbot',
	);
});

test('partnerAgentStatusKey reads the bare name when only that file exists', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-bare-'));
	fs.writeFileSync(path.join(dir, 'trotbot.json'), '{}');
	t.is(partnerAgentStatusKey('stardust-labs', 'trotbot', dir), 'trotbot');
});

test('buildAttachCommand attaches a nested client and retries while the bot is down', t => {
	t.is(
		buildAttachCommand('trotbot', {socket: 'trotbot', session: 'trotbot'}),
		"while :; do env -u TMUX tmux -L trotbot attach-session -t '=trotbot' 2>/dev/null || { printf '\\033[2J\\033[H%s\\n' 'trotbot is not running (tmux -L trotbot has no session trotbot). Retrying every 5s; Ctrl-C stops.'; sleep 5; }; done",
	);
});

test('buildAttachCommand uses -S for a socket path and quotes values', t => {
	const command = buildAttachCommand('bot', {
		socket: '/tmp/my sock',
		session: "it's",
	});
	t.true(
		command.includes("tmux -S '/tmp/my sock' attach-session -t '=it'\\''s'"),
	);
});

const CLAUDE: ResolvedAgentProfile = {
	name: 'claude',
	command: 'claude',
	args: '',
	resumeArgs: '--resume {session_id}',
	isClaude: true,
	model: '',
	effort: '',
	modelArgs: '--model {model}',
	effortArgs: '--effort {effort}',
	extraArgs: [],
	skillPrefix: '/',
};

test('first launch is fresh, never --continue (main repo root is the sous-chef dir)', t => {
	const command = buildPartnerLaunchCommand('reviewer', CLAUDE, {
		skipPermissions: false,
	});
	t.is(command, 'claude --name reviewer');
	t.false(command.includes('--continue'));
});

test('first launch passes the initialization command as the prompt', t => {
	t.is(
		buildPartnerLaunchCommand('reviewer', CLAUDE, {
			skipPermissions: true,
			initializationCommand: 'review-queue',
		}),
		"claude --dangerously-skip-permissions --name reviewer '/review-queue'",
	);
});

test('a recorded session resumes by id and falls back to a fresh launch', t => {
	t.is(
		buildPartnerLaunchCommand('reviewer', CLAUDE, {
			skipPermissions: false,
			sessionId: 'abc-123',
			initializationCommand: '/review-queue',
		}),
		"claude --name reviewer --resume abc-123 || { printf '\\033[A\\033[2K'; false; } || claude --name reviewer '/review-queue'",
	);
});

test('a non-claude agent uses its prompt_args and gets no --name', t => {
	const agy: ResolvedAgentProfile = {
		...CLAUDE,
		name: 'agy',
		command: 'agy',
		isClaude: false,
		resumeArgs: undefined,
		skillPrefix: '$',
	};
	t.is(
		buildPartnerLaunchCommand('scribe', agy, {
			skipPermissions: true,
			initializationCommand: 'notes',
			promptArgs: '-i {prompt}',
		}),
		"agy -i '$notes'",
	);
});

test('keptSessionKeys keeps partner sessions from the startup reaper', t => {
	t.deepEqual(
		[...keptSessionKeys(['STA-1'], {agents: {trotbot: {}}})],
		['STA-1', 'trotbot'],
	);
	t.deepEqual([...keptSessionKeys(['STA-1'], null)], ['STA-1']);
});

const deps = (sessionId?: string) => ({
	mainRepoRoot: '/repo',
	readSessionId: () => sessionId,
});

test('resolvePartnerSessionLaunch ignores a name that is not a partner', t => {
	t.is(
		resolvePartnerSessionLaunch(
			{version: 1, profiles: {}},
			'STA-1',
			false,
			deps(),
		),
		undefined,
	);
});

test('resolvePartnerSessionLaunch runs an attach agent as a nested attach in the main root', t => {
	const launch = resolvePartnerSessionLaunch(
		{
			version: 1,
			profiles: {},
			agents: {trotbot: {attach: {socket: 'trotbot', session: 'trotbot'}}},
		},
		'trotbot',
		true,
		deps('ignored'),
	)!;
	t.is(launch.worktreePath, '/repo');
	t.true(launch.command.includes('env -u TMUX tmux -L trotbot attach-session'));
});

test('resolvePartnerSessionLaunch uses the agent profile, then the top-level one', t => {
	const config = {
		version: 1,
		profiles: {},
		agent_profile: 'codex',
		agent_profiles: {codex: {command: 'codex', args: '--yolo'}},
		agents: {
			reviewer: {},
			helper: {agent_profile: 'claude', initialization_command: 'help'},
		},
	};
	const reviewer = resolvePartnerSessionLaunch(
		config,
		'reviewer',
		false,
		deps(),
	)!;
	t.is(reviewer.agentProfile.name, 'codex');
	t.true(reviewer.command.startsWith('codex --yolo'));
	const helper = resolvePartnerSessionLaunch(
		config,
		'helper',
		false,
		deps('id-1'),
	)!;
	t.is(helper.agentProfile.name, 'claude');
	t.true(helper.command.includes('--resume id-1'));
	t.true(helper.command.endsWith("--name helper '/help'"));
});

test('partnerAgentRows gives each agent its status key and emoji fallback', t => {
	t.deepEqual(
		partnerAgentRows(
			{default_emoji: '🍝', agents: {trotbot: {emoji: '🐴'}, scribe: {}}},
			'repo',
			'/repo',
		),
		[
			{
				name: 'trotbot',
				statusKey: 'repo-trotbot',
				worktreePath: '/repo',
				emoji: '🐴',
			},
			{
				name: 'scribe',
				statusKey: 'repo-scribe',
				worktreePath: '/repo',
				emoji: '🍝',
			},
		],
	);
	t.deepEqual(partnerAgentRows(null, 'repo', '/repo'), []);
});

test('a launched partner gets the companion rules when workspace_aware_agents is on', t => {
	const config = (aware: boolean) => ({
		version: 1,
		profiles: {},
		workspace_aware_agents: aware,
		agent_profiles: {codex: {command: 'codex'}},
		agents: {reviewer: {agent_profile: 'codex'}},
	});
	const on = resolvePartnerSessionLaunch(
		config(true),
		'reviewer',
		false,
		deps(),
	)!;
	const off = resolvePartnerSessionLaunch(
		config(false),
		'reviewer',
		false,
		deps(),
	)!;
	t.true(on.command.includes('developer_instructions='));
	t.false(off.command.includes('developer_instructions='));
});

test('validatePartnerAgents takes a one-line description only', t => {
	t.deepEqual(
		validatePartnerAgents({scribe: {description: 'Keeps notes'}}, PROFILES),
		[],
	);
	t.deepEqual(
		validatePartnerAgents({scribe: {description: 'one\ntwo'}}, PROFILES),
		['agents.scribe.description: must be a single line'],
	);
	t.deepEqual(validatePartnerAgents({scribe: {description: 3}}, PROFILES), [
		'agents.scribe.description: must be a string',
	]);
});

test('attachedPartnerSessions lists only the attach partners', t => {
	t.deepEqual(
		[
			...attachedPartnerSessions({
				agents: {
					trotbot: {attach: {socket: 'trotbot', session: 'bot'}},
					reviewer: {agent_profile: 'codex'},
				},
			}),
		],
		[['trotbot', {socket: 'trotbot', session: 'bot'}]],
	);
	t.is(attachedPartnerSessions(null).size, 0);
});

test('describePartners reads status, session and last exchange from each partner own files', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-board-'));
	t.teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const status = path.join(root, 'status');
	const projects = path.join(root, 'projects');
	const mainRoot = '/home/u/repo';
	fs.mkdirSync(status);
	const now = new Date(2026, 10, 9, 12, 0).getTime();
	fs.writeFileSync(
		path.join(status, 'repo-trotbot.json'),
		JSON.stringify({
			status: 'waiting_for_input',
			lastUpdate: now - 3 * 60_000,
			sessionId: 'bot-session',
			cwd: mainRoot,
		}),
	);
	// Another agent in the same folder wrote last; its log must not be read.
	const folder = path.join(projects, '-home-u-repo');
	fs.mkdirSync(folder, {recursive: true});
	const line = (entry: unknown) => JSON.stringify(entry);
	fs.writeFileSync(
		path.join(folder, 'bot-session.jsonl'),
		[
			line({type: 'user', message: {content: 'text the group'}}),
			line({type: 'assistant', message: {content: 'Sent.'}}),
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(folder, 'sous-chef.jsonl'),
		line({type: 'user', message: {content: 'board'}}),
	);

	const config = {
		version: 1,
		profiles: {},
		agent_profile: 'claude',
		agents: {
			trotbot: {
				emoji: '🐴',
				description: 'iMessage bot',
				attach: {socket: 'trotbot', session: 'bot'},
			},
			reviewer: {agent_profile: 'codex'},
		},
	};
	const running = new Set(['trotbot/bot']);
	const partners = describePartners(config, 'repo', {
		innerSocket: 'pappardelle_inner',
		agentSessionName: name => `agent-repo-${name}`,
		sessionExists: (socket, session) => running.has(`${socket}/${session}`),
		now,
		statusDir: status,
		projectsDir: projects,
	});
	t.deepEqual(partners, [
		{
			name: 'trotbot',
			kind: 'attached',
			emoji: '🐴',
			description: 'iMessage bot',
			status: 'waiting_for_input',
			running: true,
			tmux: {socket: 'trotbot', session: 'bot'},
			currentTool: null,
			lastUpdate: now - 3 * 60_000,
			minutesAgo: 3,
			sessionId: 'bot-session',
			lastTurn: {prompt: 'text the group', reply: 'Sent.'},
		},
		{
			name: 'reviewer',
			kind: 'launched',
			agentProfile: 'codex',
			status: 'no_status',
			running: false,
			tmux: {socket: 'pappardelle_inner', session: 'agent-repo-reviewer'},
		},
	]);
});
