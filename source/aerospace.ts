// Aerospace CLI utilities
import {exec, execSync} from 'node:child_process';
import {promisify} from 'node:util';
import type {AerospaceWorkspace, AerospaceWindow} from './types.js';
import {createLogger} from './logger.js';

const execAsync = promisify(exec);
const log = createLogger('aerospace');

export async function listWorkspaces(): Promise<string[]> {
	try {
		const {stdout} = await execAsync(
			'aerospace list-workspaces --all --json 2>/dev/null',
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		const workspaces: AerospaceWorkspace[] = JSON.parse(stdout);
		log.debug(`Found ${workspaces.length} workspaces`);
		return workspaces.map(w => w.workspace);
	} catch (err) {
		log.error(
			'Failed to list workspaces',
			err instanceof Error ? err : undefined,
		);
		return [];
	}
}

export async function listWindowsInWorkspace(
	workspaceName: string,
): Promise<AerospaceWindow[]> {
	try {
		const {stdout} = await execAsync(
			`aerospace list-windows --workspace "${workspaceName}" --json 2>/dev/null`,
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		const windows = JSON.parse(stdout) as AerospaceWindow[];
		log.debug(`Found ${windows.length} windows in workspace ${workspaceName}`);
		return windows;
	} catch (err) {
		log.warn(
			`Failed to list windows in workspace ${workspaceName}`,
			err instanceof Error ? err : undefined,
		);
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
		log.info(`Switched to workspace ${workspaceName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to switch to workspace ${workspaceName}`,
			err instanceof Error ? err : undefined,
		);
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
	} catch (err) {
		log.warn(
			'Failed to get focused workspace',
			err instanceof Error ? err : undefined,
		);
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
		return workspaces.map(w => w.workspace);
	} catch (err) {
		log.warn(
			'Failed to get visible workspaces',
			err instanceof Error ? err : undefined,
		);
		return [];
	}
}

// Check if workspace name looks like a Linear issue
export function isLinearIssueWorkspace(workspaceName: string): boolean {
	// Match patterns like STA-123, ENG-456, etc.
	return /^[A-Z]+-\d+$/.test(workspaceName);
}

/**
 * Close all windows in a workspace
 * Returns true if all windows were successfully closed
 */
export async function closeWorkspace(workspaceName: string): Promise<boolean> {
	try {
		// Get all windows in the workspace
		const windows = await listWindowsInWorkspace(workspaceName);

		if (windows.length === 0) {
			log.debug(`No windows in workspace ${workspaceName}`);
			return true;
		}

		// Close each window
		for (const window of windows) {
			try {
				execSync(
					`aerospace close --window-id "${window['window-id']}" 2>/dev/null`,
					{
						timeout: 5000,
						stdio: ['pipe', 'pipe', 'pipe'],
					},
				);
			} catch {
				// Window might have already closed, just log and continue
				log.debug(`Could not close window ${window['window-id']}`);
			}
		}

		log.info(
			`Closed ${windows.length} window(s) in workspace ${workspaceName}`,
		);
		return true;
	} catch (err) {
		log.error(
			`Failed to close workspace ${workspaceName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}
