import path from 'node:path';
import {test, expect} from 'bun:test';
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

test('each agent gets the server through its own mcp add', () => {
	const f = fixture();
	expect(installMcpServer(f.deps)).toBe(0);
	const server = ['/shim/pappardelle', 'mcp'];
	expect(f.calls).toStrictEqual([
		['codex', ['mcp', 'add', 'pappardelle', '--', ...server]],
		['opencode', ['mcp', 'add', '--global', 'pappardelle', '--', ...server]],
		['agy', ['mcp', 'add', 'pappardelle', ...server]],
		[
			'pi',
			['mcp', 'add', 'pappardelle', '--exposure', 'direct', '--', ...server],
		],
	]);
});

test('an agent that is not installed is skipped and touches nothing', () => {
	const f = fixture({missing: ['codex', 'agy']});
	expect(installMcpServer(f.deps)).toBe(0);
	expect(f.files.has(CODEX)).toBe(false);
	expect(f.files.has(AGY)).toBe(false);
	expect(f.printed.some(line => /codex|agy/.test(line))).toBe(false);
});

test('a failed mcp add is reported, nothing is approved, and the rest still run', () => {
	const f = fixture({failing: ['codex']});
	expect(installMcpServer(f.deps)).toBe(1);
	expect(f.files.has(CODEX)).toBe(false);
	expect(
		f.printed.some(
			line => line.startsWith('Could not add') && line.includes('codex'),
		),
	).toBe(true);
	expect(f.calls.length).toBe(4);
});

test('Codex approves each auto-approved tool and keeps the rest of its config', () => {
	const f = fixture({files: {[CODEX]: '# mine\nmodel = "x"\n'}});
	installMcpServer(f.deps);
	const config = f.files.get(CODEX)!;
	expect(config.startsWith('# mine\nmodel = "x"\n')).toBe(true);
	for (const tool of AUTO_APPROVED_TOOLS) {
		expect(
			config.includes(
				`[mcp_servers.pappardelle.tools.${tool}]\napproval_mode = "approve"\n`,
			),
		).toBe(true);
	}

	expect(config.includes('tools.space_close')).toBe(false);
});

test('running it again adds no duplicate Codex tables or agy rules', () => {
	const f = fixture();
	installMcpServer(f.deps);
	const codex = f.files.get(CODEX);
	const agy = f.files.get(AGY);
	installMcpServer(f.deps);
	expect(f.files.get(CODEX)).toBe(codex);
	expect(f.files.get(AGY)).toBe(agy);
});

test('a Codex table the user spelled another way is not added again', () => {
	const mine =
		'[ mcp_servers.pappardelle.tools.companion_run ]\napproval_mode = "prompt"\n' +
		'[mcp_servers."pappardelle".tools."space_send"]\napproval_mode = "prompt"\n';
	const f = fixture({files: {[CODEX]: mine}});
	installMcpServer(f.deps);
	const config = f.files.get(CODEX)!;
	expect(config.includes('[mcp_servers.pappardelle.tools.companion_run]')).toBe(
		false,
	);
	expect(config.includes('[mcp_servers.pappardelle.tools.space_send]')).toBe(
		false,
	);
	expect(config.includes('[mcp_servers.pappardelle.tools.space_screen]')).toBe(
		true,
	);
});

test('Codex config that does not parse is left alone', () => {
	const f = fixture({files: {[CODEX]: '[nope'}});
	installMcpServer(f.deps);
	expect(f.files.get(CODEX)).toBe('[nope');
	expect(
		f.printed.some(
			line => line.includes('Could not parse') && line.includes(CODEX),
		),
	).toBe(true);
});

test('agy allows each auto-approved tool and keeps existing settings and rules', () => {
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
	expect(settings.toolPermission).toBe('ask');
	expect(settings.permissions.deny).toStrictEqual(['mcp(x/*)']);
	expect(settings.permissions.allow).toStrictEqual([
		'shell(ls)',
		...AUTO_APPROVED_TOOLS.map(tool => `mcp(pappardelle/${tool})`),
	]);
});

test('agy settings that do not parse are left alone', () => {
	const f = fixture({files: {[AGY]: '{ nope'}});
	installMcpServer(f.deps);
	expect(f.files.get(AGY)).toBe('{ nope');
	expect(f.printed.some(line => line.includes('Could not parse'))).toBe(true);
});
