import test from 'ava';
import {checkApproval} from './approve-policy.ts';

const policy = {scratchRoots: ['/tmp/q-', '/tmp/claude-1000/']};
const allowed = (command: string) => checkApproval(command, policy).allow;

test('cleaning up QA scratch is approved', t => {
	t.true(allowed('rm -rf /tmp/q-abc /tmp/claude-1000/x/scratchpad/out'));
	t.true(allowed('rm -f "/tmp/q-abc/s" && ls'));
	t.true(allowed('dir=$(mktemp -d); rm -rf "$dir"'));
	t.true(allowed('bun --bun ava source/x.test.ts'));
});

test('rm anywhere else needs a person', t => {
	t.false(allowed('rm -rf ~/.pappardelle'));
	t.false(allowed('rm -rf /tmp/q-ok /home/u/work'));
	t.false(allowed('rm -fr src'));
	t.false(allowed('X=/home/u; rm -rf "$X"'));
	t.false(allowed('D=/; rm -rf $D'));
});

test('publishing anything needs a person', t => {
	for (const command of [
		'git push origin main',
		'gh pr merge 12 --squash',
		'gh pr create --fill',
		'gh pr edit 3 --title x',
		'gh api repos/x/y/pulls/1 -X PATCH',
		'git push --force-with-lease',
		'git reset --hard HEAD~1',
	]) {
		t.false(allowed(command), `${command}`);
	}
});

test('kill-server is approved only on an isolated QA socket', t => {
	t.true(allowed('tmux -S /tmp/q-abc/s kill-server'));
	t.true(allowed('qkill abc'));
	t.false(allowed('tmux kill-server'));
	t.false(allowed('TMUX_TMPDIR=/tmp/x tmux kill-server'));
	t.false(allowed('tmux -L pappardelle_inner kill-server'));
});

test('a refusal says why', t => {
	t.deepEqual(checkApproval('git push', policy), {
		allow: false,
		reason: 'git push',
	});
	t.deepEqual(checkApproval('rm -rf /etc/x', policy), {
		allow: false,
		reason: 'rm outside QA scratch: /etc/x',
	});
});
