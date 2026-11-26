import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {
	callerIsAgy,
	createMcpServer,
	workspaceInstructions,
	type CliResult,
	type RunCli,
	type WorkspaceAwareness,
} from './mcp-server.ts';
import type {PappardelleConfig} from './config.ts';
import type {CliCall} from './mcp-tools.ts';

async function connect(
	options: {
		awareness?: WorkspaceAwareness;
		space?: string;
		sender?: string;
		sousChef?: boolean;
		agy?: boolean;
		runCli?: RunCli;
	} = {},
) {
	const calls: CliCall[] = [];
	const result: CliResult = {code: 0, stdout: 'out\n', stderr: ''};
	const server = createMcpServer({
		awareness: options.awareness ?? {kind: 'on'},
		space: 'space' in options ? options.space : 'STA-1',
		...(options.sender !== undefined ? {sender: options.sender} : {}),
		...(options.sousChef !== undefined ? {sousChef: options.sousChef} : {}),
		...(options.agy !== undefined ? {agy: options.agy} : {}),
		repoName: 'repo',
		runCli:
			options.runCli ??
			(async call => {
				calls.push(call);
				return result;
			}),
	});
	const client = new Client({name: 'test', version: '1'});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	return {client, calls, result};
}

type TextResult = {
	isError?: boolean;
	content: Array<{type: string; text: string}>;
};

const text = (result: unknown) => (result as TextResult).content[0]!.text;

test('a tool call runs its CLI call and returns the output', async () => {
	const {client, calls} = await connect();
	const result = await client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2', text: "it's"},
	});
	expect(calls).toStrictEqual([
		{args: ['send', 'STA-2'], stdin: "[from STA-1] it's"},
	]);
	expect(text(result)).toBe('out');
	expect(result.isError).toBeFalsy();
});

test('space_send prepends [from main] only when sender is main, and leaves unknown callers bare even with sousChef configured', async () => {
	const main = await connect({
		space: undefined,
		sender: 'main',
		sousChef: true,
	});
	await main.client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2', text: 'status?'},
	});
	expect(main.calls).toStrictEqual([
		{args: ['send', 'STA-2'], stdin: '[from main] status?'},
	]);

	const strayWithSousChef = await connect({space: undefined, sousChef: true});
	await strayWithSousChef.client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2', text: 'status?'},
	});
	expect(strayWithSousChef.calls).toStrictEqual([
		{args: ['send', 'STA-2'], stdin: 'status?'},
	]);

	const external = await connect({space: undefined, sousChef: false});
	await external.client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2', text: 'status?'},
	});
	expect(external.calls).toStrictEqual([
		{args: ['send', 'STA-2'], stdin: 'status?'},
	]);
});

test('agy workspace instructions teach space_send instead of SendMessage', () => {
	const worker = workspaceInstructions('STA-1', 'repo', {
		sousChef: true,
		agy: true,
	});
	expect(worker).toMatch(/space_send/);
	expect(worker).toMatch(/never use SendMessage/);
	expect(worker).not.toMatch(/SendMessage to `sous-chef`/);
});

test('callerIsAgy checks the resolved profile instead of AGY_CLI_OSC7501', async () => {
	const state = testState();
	await state.daos.spaceState.write('STA-1', {
		agentProfile: {name: 'claude', isClaude: true},
	});
	await state.daos.spaceState.write('STA-2', {
		agentProfile: {name: 'agy', isClaude: false},
	});
	const config = {
		version: 1,
		agent_profile: 'claude',
		agent_profiles: {
			claude: {command: 'claude'},
			agy: {command: 'env FOO=1 agy'},
		},
	} as unknown as PappardelleConfig;

	expect(
		callerIsAgy({
			caller: {kind: 'env', key: 'STA-1'},
			config,
			spaceState: state.daos.spaceState,
		}),
	).toBe(false);
	expect(
		callerIsAgy({
			caller: {kind: 'env', key: 'STA-2'},
			config,
			spaceState: state.daos.spaceState,
		}),
	).toBe(true);
	expect(
		callerIsAgy({
			caller: {kind: 'none'},
			config,
			spaceState: state.daos.spaceState,
		}),
	).toBe(false);

	// Even if AGY_CLI_OSC7501=on is set in env (as on every agent session), a
	// Claude caller gets agy=false so SendMessage instructions stay intact.
	const claudeInstructions = workspaceInstructions('STA-1', 'repo', {
		sousChef: true,
		agy: callerIsAgy({
			caller: {kind: 'env', key: 'STA-1'},
			config,
			spaceState: state.daos.spaceState,
		}),
	});
	expect(claudeInstructions).toMatch(/SendMessage to `sous-chef`/);
});

test('a command with no output still answers', async () => {
	const {client, result} = await connect();
	result.stdout = '';
	expect(
		text(
			await client.callTool({name: 'space_highlight', arguments: {key: 'A'}}),
		),
	).toBe('Done');
});

test('a failed command is a tool error carrying its output and exit code', async () => {
	const {client, result} = await connect();
	result.code = 3;
	result.stdout = 'Workspace STA-2 is ready!\n';
	result.stderr = 'STA-2 is open, but its agent was not confirmed to start\n';
	const response = await client.callTool({
		name: 'space_open',
		arguments: {input: 'STA-2', wait: true},
	});
	expect(response.isError).toBe(true);
	expect(
		(response as TextResult).content.map(block => block.text),
	).toStrictEqual([
		'Workspace STA-2 is ready!',
		'STA-2 is open, but its agent was not confirmed to start',
		'exit 3',
	]);
});

test('input that fails the schema never reaches the CLI', async () => {
	const {client, calls} = await connect();
	const response = await client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2'},
	});
	expect(response.isError).toBe(true);
	expect(calls).toStrictEqual([]);
});

test('cancelling a call aborts the running command', async () => {
	let aborted = false;
	const {client} = await connect({
		runCli: async (_call, signal) =>
			new Promise(resolve => {
				signal.addEventListener('abort', () => {
					aborted = true;
					resolve({code: null, stdout: '', stderr: 'aborted'});
				});
			}),
	});
	const controller = new AbortController();
	const pending = client.callTool(
		{name: 'tui_restart', arguments: {}},
		undefined,
		{signal: controller.signal},
	);
	await delay(20);
	controller.abort();
	await rejectionOf(pending);
	await delay(20);
	expect(aborted).toBe(true);
});

test('outside a Pappardelle repo the server offers nothing', async () => {
	const {client} = await connect({awareness: {kind: 'off'}});
	expect(client.getServerCapabilities()?.tools).toBe(undefined);
	expect(client.getInstructions()).toBe(undefined);
});

test('an invalid config turns the tools off and the instructions say why', async () => {
	const {client} = await connect({
		awareness: {
			kind: 'invalid-config',
			errors: ['agent_profiles.opus.model: must be a string'],
		},
	});
	expect(client.getServerCapabilities()?.tools).toBe(undefined);
	const instructions = client.getInstructions() ?? '';
	expect(
		instructions.includes('agent_profiles.opus.model: must be a string'),
	).toBe(true);
	expect(instructions.includes('restart this session')).toBe(true);
});

test('inside a repo tools are annotated and instructions are sent', async () => {
	const {client} = await connect();
	const {tools} = await client.listTools();
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	expect(byName.get('spaces_list')?.annotations?.readOnlyHint).toBe(true);
	expect(byName.get('space_close')?.annotations?.destructiveHint).toBe(true);
	expect(byName.get('companion_run')?.annotations?.readOnlyHint).toBe(false);
	expect(client.getInstructions() ?? '').toMatch(/space STA-1 \(repo repo\)/);
});

test('instructions fit before Claude Code truncates them', () => {
	// Measured with Claude Code 2.1.318: text past roughly 3KB gets cut off.
	expect(
		workspaceInstructions('A-KEY-THAT-IS-LONG', 'repo').length < 3000,
	).toBe(true);
	expect(
		workspaceInstructions(undefined, 'repo', {
			sousChef: true,
			sousChefFile: `/${'long-directory/'.repeat(12)}SOUS-CHEF.md`,
		}).length < 3000,
	).toBe(true);
});

test('only a session in a space is told to keep a companion current', () => {
	expect(workspaceInstructions('STA-1', 'repo')).toMatch(/companion_run/);
	expect(workspaceInstructions(undefined, 'repo')).not.toMatch(/companion_run/);
	expect(workspaceInstructions(undefined, 'repo')).toMatch(/isn't in a space/);
});

test('only an opted-in session outside a space is told to coordinate', () => {
	expect(workspaceInstructions(undefined, 'repo')).not.toMatch(
		/Sous-chef mode/,
	);
	expect(workspaceInstructions(undefined, 'repo', {sousChef: true})).toMatch(
		/Sous-chef mode is on/,
	);
	const inSpace = workspaceInstructions('STA-1', 'repo', {sousChef: true});
	expect(inSpace).not.toMatch(/Sous-chef mode/);
	expect(inSpace).toMatch(/SendMessage to `sous-chef`/);
	expect(workspaceInstructions('STA-1', 'repo')).not.toMatch(/sous-chef/);
});

test('the coordinator is pointed at SOUS-CHEF.md only in sous-chef mode', () => {
	const sousChefFile = '/repo/SOUS-CHEF.md';
	expect(
		workspaceInstructions(undefined, 'repo', {sousChef: true, sousChefFile}),
	).toMatch(/instructions for the sous-chef are in \/repo\/SOUS-CHEF\.md/);
	expect(workspaceInstructions(undefined, 'repo', {sousChefFile})).not.toMatch(
		/SOUS-CHEF\.md/,
	);
	expect(
		workspaceInstructions(undefined, 'repo', {sousChef: true}),
	).not.toMatch(/SOUS-CHEF\.md/);
});
