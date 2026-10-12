import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {extractIssueKeyFromIdowOutput} from './session-routing.ts';
import {addSpace} from './space-registry.ts';

export interface OpenSpaceCommandOptions {
	command: string;
	prompt: string;
	issueKey: string | null;
	resume?: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

async function writeOutput(
	stream: NodeJS.WritableStream,
	text: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(text, error => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export async function runOpenSpaceCommand(
	options: OpenSpaceCommandOptions,
): Promise<number> {
	let stdout = '';
	let code: number | null;
	let signal: NodeJS.Signals | null;
	try {
		const child = spawn(
			options.command,
			[...(options.resume ? ['--resume'] : []), options.prompt],
			{
				cwd: options.cwd,
				env: options.env,
				stdio: ['inherit', 'pipe', 'inherit'],
			},
		);
		const [exit] = await Promise.all([
			once(child, 'close'),
			pipeline(
				child.stdout!.setEncoding('utf8'),
				new Writable({
					decodeStrings: false,
					write(chunk: string, _encoding, callback) {
						stdout += chunk;
						process.stdout.write(chunk, callback);
					},
				}),
			),
		]);
		[code, signal] = exit as [number | null, NodeJS.Signals | null];
	} catch (error) {
		await writeOutput(
			process.stderr,
			`Failed to run idow: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		await writeOutput(process.stdout, '');
		return 1;
	}

	// The startup banner may still be buffered even when idow produced no output.
	await writeOutput(process.stdout, '');
	if (code !== 0) {
		if (signal)
			await writeOutput(process.stderr, `idow terminated by ${signal}\n`);
		return code ?? 1;
	}

	const issueKey = options.issueKey ?? extractIssueKeyFromIdowOutput(stdout);
	if (!issueKey) {
		await writeOutput(
			process.stderr,
			'Workspace setup completed, but could not register the space: no issue key found in idow output\n',
		);
		return 1;
	}

	try {
		await addSpace(issueKey);
		return 0;
	} catch (error) {
		await writeOutput(
			process.stderr,
			`Workspace setup completed, but could not register ${issueKey}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
