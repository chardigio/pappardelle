import test from 'ava';
import {checkApproval} from './approve-policy.ts';

const policy = {scratchRoots: ['/tmp/q-', '/tmp/claude-1000/']};
const allowed = (command: string) => checkApproval(command, policy).allow;

test('cleaning up QA scratch is approved', t => {
	t.true(allowed('rm -rf /tmp/q-abc /tmp/claude-1000/x/scratchpad/out'));
	t.true(allowed('rm -f "/tmp/q-abc/s" && ls'));
	t.true(allowed('dir=$(mktemp -d); rm -rf "$dir"'));
	t.true(allowed('rm -rf /tmp/q-abc/'));
	t.true(allowed('rm -rf "/tmp/q-abc/a b"'));
	t.true(allowed('gh pr view 3 && git log --oneline -3'));
	t.true(allowed('bun --bun ava source/x.test.ts'));
});

test('rm anywhere else needs a person', t => {
	t.false(allowed('rm -rf ~/.pappardelle'));
	t.false(allowed('rm -rf /tmp/q-ok /home/u/work'));
	t.false(allowed('rm -fr src'));
	t.false(allowed('X=/home/u; rm -rf "$X"'));
	t.false(allowed('D=/; rm -rf $D'));
	t.false(allowed('D=/tmp/q-a rm -rf $D'));
	t.false(allowed('rm -rf /tmp/q-sup/../../home/u/x'));
	t.false(allowed('rm -rf $HOME/x'));
	// eslint-disable-next-line no-template-curly-in-string
	t.false(allowed('rm -rf "${HOME}"'));
	t.false(allowed('rm /home/u/x -rf'));
	t.false(allowed('D=$(mktemp -d); D=$HOME; rm -rf "$D"'));
	t.false(allowed('dir=$(mktemp -d); rm -rf "$dir/../x"'));
	t.false(allowed('echo /home/u | xargs rm -rf'));
	t.false(allowed('sudo rm -rf /tmp/q-a'));
	t.false(allowed('sh -c "rm -rf /home/u"'));
	t.false(allowed('find /home/u -delete'));
	t.false(allowed('find /tmp/q-a -exec rm {} +'));
	t.false(allowed('D=$(mktemp -d)/../../home/u; rm -rf $D'));
	t.false(allowed('D="$(mktemp -d; echo $HOME)"; rm -rf $D'));
});

test('publishing anything needs a person', t => {
	for (const command of [
		'git push origin main',
		'gh pr merge 12 --squash',
		'gh pr create --fill',
		'gh pr edit 3 --title x',
		'gh api repos/x/y/pulls/1 -X PATCH',
		'git push --force-with-lease',
		'git -C . push origin main',
		'git -c a=b push',
		'gh release create v1',
		'gh issue close 4',
		'gh api repos/x/y/issues -f title=x',
		'git reset --hard HEAD~1',
		'gh api repos/o/r/issues -XPOST -ftitle=x',
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
	t.false(allowed('tmux -S /tmp/q-a/s kill-server; tmux kill-server'));
	t.false(allowed('tmux kill-session -t agent-repo-STA-1'));
	t.true(allowed('tmux -S /tmp/q-a/s kill-session -t x'));
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
