// Aerospace CLI utilities
import {exec, execSync} from 'node:child_process';
import {promisify} from 'node:util';
import type {AerospaceWorkspace, AerospaceWindow} from './types.js';

const execAsync = promisify(exec);

export async function listWorkspaces(): Promise<string[]> {
	try {
		const {stdout} = await execAsync('aerospace list-workspaces --all --json 2>/dev/null', {
			encoding: 'utf-8',
			timeout: 5000,
		});
		const workspaces: AerospaceWorkspace[] = JSON.parse(stdout);
		return workspaces.map((w) => w.workspace);
	} catch {
		return [];
	}
}

export async function listWindowsInWorkspace(workspaceName: string): Promise<AerospaceWindow[]> {
	try {
		const {stdout} = await execAsync(
			`aerospace list-windows --workspace "${workspaceName}" --json 2>/dev/null`,
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		return JSON.parse(stdout) as AerospaceWindow[];
	} catch {
		return [];
	}
}

// Keep these sync since they're used for immediate user actions
export function switchToWorkspace(workspaceName: string): boolean {
	try {
		execSync(`aerospace workspace "${workspaceName}" 2>/dev/null`, {
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}

export function getFocusedWorkspace(): string | null {
	try {
		const output = execSync('aerospace list-workspaces --focused 2>/dev/null', {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return output.trim();
	} catch {
		return null;
	}
}

export async function getVisibleWorkspaces(): Promise<string[]> {
	try {
		const {stdout} = await execAsync(
			'aerospace list-workspaces --monitor all --visible --json 2>/dev/null',
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		const workspaces: AerospaceWorkspace[] = JSON.parse(stdout);
		return workspaces.map((w) => w.workspace);
	} catch {
		return [];
	}
}

// Check if workspace name looks like a Linear issue
export function isLinearIssueWorkspace(workspaceName: string): boolean {
	// Match patterns like STA-123, ENG-456, etc.
	return /^[A-Z]+-\d+$/.test(workspaceName);
}
