import path from 'node:path';
import test from 'ava';
import {installMcpServer, type McpInstallDeps} from './mcp-install.ts';
import {AUTO_APPROVED_TOOLS} from './mcp-tools.ts';

const HOME = '/home/u';
const CODEX = path.join(HOME, '.codex', 'config.toml');
const AGY = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');

function fixture(
	options: {
		missing?: string[];
		failing?: string[];
		files?: Record<string, string>;
	} = {},
) {
	const files = new Map(Object.entries(options.files ?? {}));
	const calls: Array<[string, string[]]> = [];
	const printed: string[] = [];
	const deps: McpInstallDeps = {
		home: HOME,
		codexHome: path.join(HOME, '.codex'),
		serverCommand: '/shim/pappardelle',
		run(command, args) {
			calls.push([command, args]);
			if (options.missing?.includes(command)) {
				return {
					status: null,
					error: Object.assign(new Error('nope'), {code: 'ENOENT'}),
				};
			}

			return {status: options.failing?.includes(command) ? 1 : 0};
		},
		readFile: file => files.get(file),
		writeFile(file, content) {
			files.set(file, content);
		},
		print(line) {
			printed.push(line);
		},
	};
	return {deps, calls, files, printed};
}

test('each agent gets the server through its own mcp add', t => {
	const f = fixture();
	t.is(installMcpServer(f.deps), 0);
	const server = ['/shim/pappardelle', 'mcp'];
	t.deepEqual(f.calls, [
		['codex', ['mcp', 'add', 'pappardelle', '--', ...server]],
		['opencode', ['mcp', 'add', '--global', 'pappardelle', '--', ...server]],
		['agy', ['mcp', 'add', 'pappardelle', ...server]],
		[
			'pi',
			['mcp', 'add', 'pappardelle', '--exposure', 'direct', '--', ...server],
		],
	]);
});

test('an agent that is not installed is skipped and touches nothing', t => {
	const f = fixture({missing: ['codex', 'agy']});
	t.is(installMcpServer(f.deps), 0);
	t.false(f.files.has(CODEX));
	t.false(f.files.has(AGY));
	t.false(f.printed.some(line => /codex|agy/.test(line)));
});

test('a failed mcp add is reported, nothing is approved, and the rest still run', t => {
	const f = fixture({failing: ['codex']});
	t.is(installMcpServer(f.deps), 1);
	t.false(f.files.has(CODEX));
	t.true(
		f.printed.some(
			line => line.startsWith('Could not add') && line.includes('codex'),
		),
	);
	t.is(f.calls.length, 4);
});

test('Codex approves each auto-approved tool and keeps the rest of its config', t => {
	const f = fixture({files: {[CODEX]: '# mine\nmodel = "x"\n'}});
	installMcpServer(f.deps);
	const config = f.files.get(CODEX)!;
	t.true(config.startsWith('# mine\nmodel = "x"\n'));
	for (const tool of AUTO_APPROVED_TOOLS) {
		t.true(
			config.includes(
				`[mcp_servers.pappardelle.tools.${tool}]\napproval_mode = "approve"\n`,
			),
		);
	}

	t.false(config.includes('tools.space_close'));
});

test('running it again adds no duplicate Codex tables or agy rules', t => {
	const f = fixture();
	installMcpServer(f.deps);
	const codex = f.files.get(CODEX);
	const agy = f.files.get(AGY);
	installMcpServer(f.deps);
	t.is(f.files.get(CODEX), codex);
	t.is(f.files.get(AGY), agy);
});

test('agy allows each auto-approved tool and keeps existing settings and rules', t => {
	const f = fixture({
		files: {
			[AGY]: JSON.stringify({
				toolPermission: 'ask',
				permissions: {allow: ['shell(ls)'], deny: ['mcp(x/*)']},
			}),
		},
	});
	installMcpServer(f.deps);
	const settings = JSON.parse(f.files.get(AGY)!) as {
		toolPermission: string;
		permissions: {allow: string[]; deny: string[]};
	};
	t.is(settings.toolPermission, 'ask');
	t.deepEqual(settings.permissions.deny, ['mcp(x/*)']);
	t.deepEqual(settings.permissions.allow, [
		'shell(ls)',
		...AUTO_APPROVED_TOOLS.map(tool => `mcp(pappardelle/${tool})`),
	]);
});

test('agy settings that do not parse are left alone', t => {
	const f = fixture({files: {[AGY]: '{ nope'}});
	installMcpServer(f.deps);
	t.is(f.files.get(AGY), '{ nope');
	t.true(f.printed.some(line => line.includes('Could not parse')));
});
