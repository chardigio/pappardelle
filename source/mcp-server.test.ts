import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import test from 'ava';
import {
	createMcpServer,
	workspaceInstructions,
	type CliResult,
	type RunCli,
} from './mcp-server.ts';
import type {CliCall} from './mcp-tools.ts';

async function connect(options: {enabled?: boolean; runCli?: RunCli} = {}) {
	const calls: CliCall[] = [];
	const result: CliResult = {code: 0, stdout: 'out\n', stderr: ''};
	const server = createMcpServer({
		enabled: options.enabled ?? true,
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

test('a tool call runs its CLI call and returns the output', async t => {
	const {client, calls} = await connect();
	const result = await client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2', text: "it's"},
	});
	t.deepEqual(calls, [{args: ['send', 'STA-2'], stdin: "it's"}]);
	t.is(text(result), 'out');
	t.falsy(result.isError);
});

test('a command with no output still answers', async t => {
	const {client, result} = await connect();
	result.stdout = '';
	t.is(
		text(
			await client.callTool({name: 'space_highlight', arguments: {key: 'A'}}),
		),
		'Done',
	);
});

test('a failed command is a tool error carrying its output and exit code', async t => {
	const {client, result} = await connect();
	result.code = 3;
	result.stdout = 'Workspace STA-2 is ready!\n';
	result.stderr = 'STA-2 is open, but its agent was not confirmed to start\n';
	const response = await client.callTool({
		name: 'space_open',
		arguments: {input: 'STA-2', wait: true},
	});
	t.true(response.isError);
	t.deepEqual(
		(response as TextResult).content.map(block => block.text),
		[
			'Workspace STA-2 is ready!',
			'STA-2 is open, but its agent was not confirmed to start',
			'exit 3',
		],
	);
});

test('input that fails the schema never reaches the CLI', async t => {
	const {client, calls} = await connect();
	const response = await client.callTool({
		name: 'space_send',
		arguments: {key: 'STA-2'},
	});
	t.true(response.isError);
	t.deepEqual(calls, []);
});

test('cancelling a call aborts the running command', async t => {
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
	await t.throwsAsync(pending);
	await delay(20);
	t.true(aborted);
});

test('outside a Pappardelle repo the server offers nothing', async t => {
	const {client} = await connect({enabled: false});
	t.is(client.getServerCapabilities()?.tools, undefined);
	t.is(client.getInstructions(), undefined);
});

test('inside a repo tools are annotated and instructions are sent', async t => {
	const {client} = await connect();
	const {tools} = await client.listTools();
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	t.true(byName.get('spaces_list')?.annotations?.readOnlyHint);
	t.true(byName.get('space_close')?.annotations?.destructiveHint);
	t.false(byName.get('companion_run')?.annotations?.readOnlyHint);
	t.regex(client.getInstructions() ?? '', /space STA-1 \(repo repo\)/);
});

test('instructions fit before Claude Code truncates them', t => {
	// Measured with Claude Code 2.1.318: text past roughly 3KB gets cut off.
	t.true(workspaceInstructions('A-KEY-THAT-IS-LONG', 'repo').length < 3000);
	t.true(
		workspaceInstructions(undefined, 'repo', {
			sousChef: true,
			sousChefFile: `/${'long-directory/'.repeat(12)}SOUS-CHEF.md`,
		}).length < 3000,
	);
});

test('only a session in a space is told to keep a companion current', t => {
	t.regex(workspaceInstructions('STA-1', 'repo'), /companion_run/);
	t.notRegex(workspaceInstructions(undefined, 'repo'), /companion_run/);
	t.regex(workspaceInstructions(undefined, 'repo'), /isn't in a space/);
});

test('only an opted-in session outside a space is told to coordinate', t => {
	t.notRegex(workspaceInstructions(undefined, 'repo'), /Sous-chef mode/);
	t.regex(
		workspaceInstructions(undefined, 'repo', {sousChef: true}),
		/Sous-chef mode is on/,
	);
	const inSpace = workspaceInstructions('STA-1', 'repo', {sousChef: true});
	t.notRegex(inSpace, /Sous-chef mode/);
	t.regex(inSpace, /SendMessage to `sous-chef`/);
	t.notRegex(workspaceInstructions('STA-1', 'repo'), /sous-chef/);
});

test('the coordinator is pointed at SOUS-CHEF.md only in sous-chef mode', t => {
	const sousChefFile = '/repo/SOUS-CHEF.md';
	t.regex(
		workspaceInstructions(undefined, 'repo', {sousChef: true, sousChefFile}),
		/instructions for the sous-chef are in \/repo\/SOUS-CHEF\.md/,
	);
	t.notRegex(
		workspaceInstructions(undefined, 'repo', {sousChefFile}),
		/SOUS-CHEF\.md/,
	);
	t.notRegex(
		workspaceInstructions(undefined, 'repo', {sousChef: true}),
		/SOUS-CHEF\.md/,
	);
});
