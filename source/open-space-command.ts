import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
	buildNewSessionArgs,
	extractIssueKeyFromIdowOutput,
} from './session-routing.ts';
import {addSpace} from './space-registry.ts';

export interface OpenSpaceCommandOptions {
	command: string;
	prompt: string;
	issueKey: string | null;
	resume?: boolean;
	profileName?: string;
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
	let child: ChildProcess | undefined;
	let exited: ReturnType<typeof once> | undefined;
	let terminationSignal: NodeJS.Signals | undefined;
	const stopChild = (signal: NodeJS.Signals = 'SIGTERM') => {
		if (!child?.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	const handleOutputError = () => stopChild();
	const handleTermination = (signal: NodeJS.Signals) => {
		terminationSignal = signal;
		stopChild(signal);
	};
	process.stdout.on('error', handleOutputError);
	process.on('SIGINT', handleTermination);
	process.on('SIGTERM', handleTermination);
	process.on('SIGHUP', handleTermination);
	try {
		child = spawn(
			options.command,
			[
				...(options.resume ? ['--resume'] : []),
				...buildNewSessionArgs(options.prompt, {
					profileName: options.profileName,
					inputIsIssueKey: false,
				}),
			],
			{
				cwd: options.cwd,
				env: options.env,
				// Setup commands must stop with idow when forwarding its output fails.
				detached: true,
				stdio: ['inherit', 'pipe', 'inherit'],
			},
		);
		exited = once(child, 'exit');
		const [exit] = await Promise.all([
			exited,
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
		// The startup banner may still be buffered even when idow produced no output.
		await writeOutput(process.stdout, '');
	} catch (error) {
		stopChild();
		await exited?.catch(() => {});
		await writeOutput(
			process.stderr,
			`Failed to run idow: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		if (!process.stdout.errored)
			await writeOutput(process.stdout, '').catch(() => {});
		return 1;
	} finally {
		process.stdout.off('error', handleOutputError);
		process.off('SIGINT', handleTermination);
		process.off('SIGTERM', handleTermination);
		process.off('SIGHUP', handleTermination);
		if (terminationSignal) process.kill(process.pid, terminationSignal);
	}

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
