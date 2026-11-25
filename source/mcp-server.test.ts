import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {
	createMcpServer,
	workspaceInstructions,
	type CliResult,
	type RunCli,
	type WorkspaceAwareness,
} from './mcp-server.ts';
import type {CliCall} from './mcp-tools.ts';

async function connect(
	options: {awareness?: WorkspaceAwareness; runCli?: RunCli} = {},
) {
	const calls: CliCall[] = [];
	const result: CliResult = {code: 0, stdout: 'out\n', stderr: ''};
	const server = createMcpServer({
		awareness: options.awareness ?? {kind: 'on'},
		space: 'STA-1',
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
	expect(calls).toStrictEqual([{args: ['send', 'STA-2'], stdin: "it's"}]);
	expect(text(result)).toBe('out');
	expect(result.isError).toBeFalsy();
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
