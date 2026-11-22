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
	t.false(allowed('D=$(mktemp)/../../home; rm -rf $D'));
	t.false(allowed('D="$(mktemp -d; echo $HOME)"; rm -rf $D'));
});

test('only a variable the shell has set to scratch before the rm counts', t => {
	t.true(allowed('D=/tmp/q-a; rm -rf $D'));
	t.true(allowed('cd /tmp && D=$(mktemp -d) E=/tmp/q-b && rm -rf $D $E'));
	t.false(allowed('rm -rf "$D"; D=$(mktemp -d)'));
	t.false(allowed('echo D=/tmp/q-x; rm -rf $D'));
	t.false(allowed('D=/tmp/q-x echo hi; rm -rf $D'));
	t.false(allowed('D=/tmp/q-x; D+=/../../home; rm -rf $D'));
});

test('a builtin that sets the variable elsewhere means it is not scratch', t => {
	for (const reset of [
		'export D=$HOME',
		'declare D=/',
		'local D+=/../..',
		'readonly D=/home/u',
		'typeset D=/',
		'read D',
		'read -r X D',
		'mapfile D',
		'printf -v D %s /',
		'for D in / /home',
	]) {
		t.false(allowed(`D=/tmp/q-a; ${reset}; rm -rf $D`), `${reset}`);
	}
});

test('a reassignment after the rm that a loop or function runs first is not scratch', t => {
	t.false(allowed('D=/tmp/q-a\nwhile :\ndo\nrm -rf $D\nD=$HOME\ndone'));
	t.false(allowed('D=/tmp/q-a; f() { rm -rf $D; }; read D; f'));
});

test('an rm target that brace expansion turns into another path needs a person', t => {
	t.false(allowed('rm -rf /tmp/q-x/{..,}/{..,}/home'));
	t.false(allowed('rm -rf /tmp/q-x/{.,.}{.,}/home'));
	t.false(allowed('dir=$(mktemp -d); rm -rf $dir/{..,}/home'));
});

test('a brace list under QA scratch is approved when every path it makes is scratch', t => {
	t.true(allowed('S=/tmp/claude-1000/x/scratchpad; rm -rf "$S"/{base,A,D1}'));
	t.true(allowed('rm -rf /tmp/q-a/{x,y,}'));
	t.false(allowed('rm -rf {/tmp/q-a,/home/u}'));
	t.false(allowed('rm -rf /tmp/q-a/{x,$HOME}'));
	t.false(allowed('rm -rf /tmp/q-a/{x,`pwd`}'));
	t.false(allowed('rm -rf /tmp/q-a/{x,{y,..}}/../home'));
});

test('a glob that names a leading dot can climb, so it needs a person', t => {
	t.true(allowed('rm -rf /tmp/q-a/*.png /tmp/q-a/.cache'));
	t.false(allowed('rm -rf /tmp/q-a/.?/.?/home'));
	t.false(allowed('rm -rf /tmp/q-a/.*/x'));
	t.false(allowed('D=/tmp/q-a/.?/.?/home; rm -rf $D'));
});

test('an rm after -- reads every word as a target', t => {
	t.false(allowed('rm -rf -- -x/../../home'));
	t.true(allowed('rm -rf -- /tmp/q-a/-x'));
});

test('a scratch variable that word splitting can turn into more targets needs a person', t => {
	t.false(allowed('S="/tmp/q-a /home"; rm -rf $S'));
	t.false(allowed('IFS=-; D=/tmp/q-a; rm -rf $D'));
});

test('a relative rm target is approved after a cd into QA scratch that always runs', t => {
	t.true(allowed('cd /tmp/q-a/motion; mkdir -p frames; rm -f frames/*'));
	t.true(allowed('S=/tmp/q-a && cd "$S/t" && rm -rf out'));
	t.false(allowed('rm -f frames/*'));
	t.false(allowed('cd /home/u; rm -rf *'));
	t.false(allowed('cd /tmp/q-a; rm -rf ../x'));
	t.false(allowed('cd /tmp/q-a; rm -rf .?/x'));
	t.false(allowed('cd /tmp/q-a/{x,y}; rm -rf *'));
});

test('a cd that may not run, or a later change of directory, leaves a relative rm to a person', t => {
	for (const command of [
		'cd /tmp/q-a; cd ~; rm -rf *',
		'cd /tmp/q-a; pushd /home/u; rm -rf *',
		'cd /tmp/q-a | cat; rm -rf *',
		'cd /tmp/q-a || true; rm -rf *',
		'false && cd /tmp/q-a; rm -rf *',
		'X=$(false) && cd /tmp/q-a; rm -rf *',
		// A failed mktemp leaves D empty, and cd "" stays where it is.
		'D=$(mktemp -d); cd "$D"; rm -f x',
		'f() {\ncd /tmp/q-a\n}\nrm -rf *',
		'if false\nthen\ncd /tmp/q-a\nfi\nrm -rf *',
		'cat <<EOF\ncd /tmp/q-a\nEOF\nrm -rf *',
		'x=$(\ncd /tmp/q-a\n)\nrm -rf *',
		'cd /tmp/q-a; source ./env.sh; rm -rf *',
		// A wrapped `echo xcd /tmp/q-a` on screen.
		'echo x\ncd /tmp/q-a; rm -rf *',
		'D=/tmp/q-a; cd "$D"; read D; rm -rf *',
	]) {
		t.false(allowed(command), `${JSON.stringify(command)}`);
	}
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

test('kill-server counts as isolated only when the wrapper or socket is what runs it', t => {
	t.true(allowed('qtmux kill-server'));
	t.true(allowed('X=1 qenv tmux kill-session -t a'));
	t.false(allowed('tmux kill-server # qtmux cleanup'));
	t.false(allowed('tmux kill-server qenv'));
	t.false(allowed('tmux kill-server # -S /tmp/q-a/s'));
	t.false(allowed('tmux -S /tmp/q-a/s -S /tmp/tmux-1000/default kill-server'));
	t.false(allowed('tmux -S /tmp/q-a/../../run/tmux-1000/default kill-server'));
});

test('a prompt whose command reads as empty needs a person', t => {
	t.false(allowed(''));
	t.false(allowed(' \n '));
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
