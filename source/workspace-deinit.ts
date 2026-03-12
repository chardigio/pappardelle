// Utility for running pre_workspace_deinit commands before workspace deletion.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import type {CommandConfig, TemplateVars} from './config.ts';
import {expandTemplate} from './config.ts';

export interface DeinitResult {
	success: boolean;
	failedCommand?: string;
}

export interface DeinitContext {
	issueKey?: string;
	repoRoot?: string;
	repoName?: string;
}

function runCommand(
	command: string,
	cwd: string,
): Promise<{exitCode: number | null}> {
	return new Promise(resolve => {
		const child = spawn('bash', ['-c', command], {
			cwd,
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {...process.env},
		});
		child.on('close', code => resolve({exitCode: code}));
		child.on('error', () => resolve({exitCode: 1}));
	});
}

/**
 * Run pre_workspace_deinit commands sequentially.
 * Returns {success: true} if all commands pass (or are skipped via continue_on_error).
 * Returns {success: false, failedCommand} on first hard failure.
 */
export async function runPreWorkspaceDeinit(
	commands: CommandConfig[],
	worktreePath: string,
	context?: DeinitContext,
): Promise<DeinitResult> {
	if (commands.length === 0) {
		return {success: true};
	}

	for (const cmd of commands) {
		const expandedRun = expandVars(cmd.run, worktreePath, context);

		const cwd = fs.existsSync(worktreePath) ? worktreePath : process.cwd();
		const result = await runCommand(expandedRun, cwd);

		if (result.exitCode !== 0) {
			if (cmd.continue_on_error) {
				continue;
			}
			return {success: false, failedCommand: cmd.name};
		}
	}

	return {success: true};
}

/**
 * Expand template variables in a command string.
 * Reuses expandTemplate from config.ts for consistent variable expansion
 * (including env-var fallback for unknown ${...} references).
 */
function expandVars(
	template: string,
	worktreePath: string,
	context?: DeinitContext,
): string {
	const vars: TemplateVars = {
		ISSUE_KEY: context?.issueKey ?? '',
		WORKTREE_PATH: worktreePath,
		REPO_ROOT: context?.repoRoot ?? '',
		REPO_NAME: context?.repoName ?? '',
	};
	if (context?.issueKey) {
		vars['ISSUE_NUMBER'] = context.issueKey.replace(/^[A-Z]+-/, '');
	}
	return expandTemplate(template, vars);
}
