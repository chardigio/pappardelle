import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';

for (const scenario of [
	{title: 'fresh workspace launches Claude once', fresh: true, resume: false},
	{title: 'existing conversation resumes', fresh: false, resume: true},
	{
		title: 'missing conversation falls back to the prompt',
		fresh: false,
		resume: false,
	},
]) {
	test(scenario.title, t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-launch-'));
		t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
		const bin = path.join(root, 'bin');
		fs.mkdirSync(bin);
		const log = path.join(root, 'claude-args');
		// Execute the pane command synchronously, without a real tmux server or
		// interactive shell. The companion is configured as an empty shell.
		fs.writeFileSync(
			path.join(bin, 'tmux'),
			`#!/bin/bash
case "$3" in
    has-session) exit 1 ;;
    new-session)
        if [[ "$*" == *'/bin/sh -c'* ]]; then
            /bin/bash -c "\${!#}"
        fi
        ;;
esac
`,
			{mode: 0o755},
		);
		fs.writeFileSync(
			path.join(bin, 'claude'),
			`#!/bin/bash
printf '%s\\n' "$*" >> "$CLAUDE_TEST_LOG"
if [[ "$*" == *--continue* ]]; then
    exit "$CLAUDE_TEST_RESUME_EXIT"
fi
`,
			{mode: 0o755},
		);
		execFileSync(
			'bash',
			[
				path.resolve(import.meta.dirname, '../scripts/start-claude-session.sh'),
				'--issue-key',
				'TEST-123',
				'--repo-name',
				'test',
				'--worktree',
				root,
				'--companion-command',
				'',
				'--init-cmd',
				'/do',
				'--model',
				'claude-opus-5[1m]',
				'--effort',
				'high',
				...(scenario.fresh ? ['--fresh'] : []),
			],
			{
				stdio: 'pipe',
				env: {
					...process.env,
					HOME: root,
					PATH: `${bin}:${process.env.PATH!}`,
					CLAUDE_TEST_LOG: log,
					CLAUDE_TEST_RESUME_EXIT: scenario.resume ? '0' : '1',
				},
			},
		);
		const base = '--model claude-opus-5[1m] --effort high --name TEST-123';
		const expected = scenario.fresh
			? [`${base} /do TEST-123`]
			: scenario.resume
				? [`${base} --continue /do TEST-123`]
				: [`${base} --continue /do TEST-123`, `${base} /do TEST-123`];
		t.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), expected);
	});
}
