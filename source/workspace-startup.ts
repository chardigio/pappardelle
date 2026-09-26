import {spawn, type SpawnOptions} from 'node:child_process';

export interface WorkspaceSetupResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export async function runWorkspaceSetup(
	command: string,
	args: string[],
	options: SpawnOptions,
): Promise<WorkspaceSetupResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			...options,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf-8').on('data', (data: string) => {
			stdout += data;
		});
		child.stderr?.setEncoding('utf-8').on('data', (data: string) => {
			stderr += data;
		});
		child.once('error', reject);
		child.once('close', (code, signal) => {
			resolve({code, signal, stdout, stderr});
		});
	});
}
