import test from 'ava';
import {checkApproval, placeOf, type ApprovalPolicy} from './approve-policy.ts';

const worktree = '/home/u/.worktrees/repo/STA-1';
const directories = new Set([
	'/',
	'/tmp',
	'/tmp/claude-1000',
	'/tmp/claude-1000/x',
	'/tmp/tmux-1000',
	'/tmp/tmux-1000/pappardelle_inner',
	'/tmp/q-a',
	'/tmp/q-a/s',
	'/home',
	'/home/u',
	'/home/u/.worktrees',
	'/home/u/.worktrees/repo',
	worktree,
	`${worktree}/dist`,
]);
// A symlink in the worktree that points at the home directory.
const links: Record<string, string> = {
	[`${worktree}/h`]: '/home/u',
	// A QA directory holding a link to the user's own tmux sockets.
	'/tmp/q-a/tlink': '/tmp/tmux-1000',
	'/tmp/q-a/tlink/pappardelle_inner': '/tmp/tmux-1000/pappardelle_inner',
};

function realpath(target: string): string {
	if (links[target]) return links[target];
	if (!directories.has(target)) throw new Error('ENOENT');
	return target;
}

const policy: ApprovalPolicy = {
	worktree,
	roots: ['/tmp/'],
	reserved: ['/tmp/tmux-'],
	shared: ['/tmp/claude-1000'],
	scratchpad: 'x',
	defaultBranch: 'trunk',
	realpath,
};
const main: ApprovalPolicy = {...policy, worktree: null};

const approved = (command: string, given = policy) =>
	checkApproval(command, given).kind === 'approve';

test('commands confined to the space pass the rules', t => {
	for (const command of [
		'rm -rf node_modules',
		'rm -rf dist/*',
		'rm -rf /tmp/q-abc /tmp/claude-1000/x/scratchpad/out',
		'rm -f "/tmp/q-abc/s" && ls',
		'dir=$(mktemp -d); rm -rf "$dir"',
		'cd /tmp/claude-1000/x/motion; rm -f frames/*',
		'git push --force origin sd-x',
		'git push -u origin HEAD',
		'git push',
		'git reset --hard',
		'gh pr merge 12 --squash',
		'gh pr create --fill',
		'find dist -name "*.map" -delete',
		'bun --bun ava source/x.test.ts',
		`rm -rf ${worktree}/build`,
	]) {
		t.true(approved(command), `${command}`);
	}
});

test('deletes outside the space hold', t => {
	for (const command of [
		'rm -rf ~/x',
		'rm -rf /tmp',
		'rm -rf /tmp/',
		'rm -rf /tmp/*',
		'rm -rf /tmp/tmux-1000',
		'rm -rf /tmp/tmux-1000/default',
		'rm -rf /tmp/claude-1000',
		'rm -rf h/x',
		'rm -rf h/',
		'cd /etc; rm x',
		'rm -rf ../x',
		'rm -rf /home/u/work',
		`rm -rf ${worktree}`,
		'rm -rf $HOME/x',
		'X=/home/u; rm -rf "$X"',
		'D=/tmp/q-a rm -rf $D',
		'rm -rf /tmp/q-sup/../../home/u/x',
		'find /home/u -delete',
		'find -delete',
		'unlink /home/u/x',
		'S="/tmp/q-a /home"; rm -rf $S',
		'IFS=-; D=/tmp/q-a; rm -rf $D',
	]) {
		t.false(approved(command), `${command}`);
	}
});

test('a symlink is followed for a target that ends in a slash, and not for one that names the link', t => {
	t.false(approved('rm -rf h/'));
	t.true(approved('rm h'));
});

test('agent configuration inside the worktree holds', t => {
	for (const target of [
		'.claude/settings.local.json',
		'.claude/settings.json',
		'.claude',
		'.mcp.json',
		'.codex/config.toml',
		'.git',
		'.git/config',
	]) {
		t.false(approved(`rm -rf ${target}`), `${target}`);
		t.not(placeOf(`${worktree}/${target}`, policy), 'inside', `${target}`);
	}

	t.true(approved('rm -rf .claude/skills/old'));
});

test('a relative target in the main checkout holds, since it is no space of its own', t => {
	t.false(approved('rm -rf node_modules', main));
	t.true(approved('rm -rf /tmp/q-a', main));
});

test('a cd that may not run, or a later change of directory, leaves the directory unknown', t => {
	for (const command of [
		'cd /tmp/q-a; cd ~; rm -rf *',
		'cd /tmp/q-a; pushd /home/u; rm -rf *',
		'cd /home/u | cat; rm -rf *',
		'cd /home/u || true; rm -rf *',
		'f() {\ncd /home/u\n}\nrm -rf *',
		'cd /tmp/q-a; source ./env.sh; rm -rf *',
		'D=$(mktemp -d); cd "$D"; rm -f x',
		'cd /tmp/q-a; cd -; rm -rf *',
	]) {
		t.false(approved(command), `${JSON.stringify(command)}`);
	}

	t.true(approved('cd /tmp/q-a | cat; ls'));
	t.true(approved('if [ -d out ]; then rm -rf out; fi'));
});

test('only a variable the shell has set inside the space before the rm counts', t => {
	t.true(approved('D=/tmp/q-a; rm -rf $D'));
	t.true(approved(`D=${worktree}/out; rm -rf "$D"/{a,b}`));
	t.false(approved('rm -rf "$D"; D=$(mktemp -d)'));
	t.false(approved('D=/tmp/q-x; D+=/../../home; rm -rf $D'));
	for (const reset of ['export D=$HOME', 'read D', 'for D in / /home']) {
		t.false(approved(`D=/tmp/q-a; ${reset}; rm -rf $D`), `${reset}`);
	}
});

test('an rm target that brace expansion or a dot glob could turn into another path holds', t => {
	t.false(approved('rm -rf /tmp/q-x/{..,}/{..,}/home'));
	t.false(approved('rm -rf .?/x'));
	t.false(approved('rm -rf /tmp/q-a/.*/x'));
	t.true(approved('rm -rf /tmp/q-a/{x,y,}'));
});

test('deploys, cloud CLIs and publishes are hard stops', t => {
	for (const command of [
		'dokku ps:restart app',
		'ssh dokku@dokku-home apps:list',
		'doctl account get',
		'aws s3 ls',
		'AWS_PROFILE=x aws s3 ls',
		'env FOO=1 gcloud projects list',
		'kubectl get pods',
		'terraform apply',
		'pulumi up',
		'npx wrangler deploy',
		'bunx wrangler@3 publish',
		'pnpm dlx wrangler d1 execute db --remote --command "select 1"',
		'fly deploy',
		'npm publish',
		'cargo publish',
		'docker push x/y',
		'gh release create v1',
		'sudo rm x',
		'echo hi && /usr/local/bin/doctl apps list',
		'(cd x && heroku logs)',
		'echo $(doctl account get)',
	]) {
		t.false(approved(command), `${command}`);
	}

	t.true(approved('terraform plan'));
	t.true(approved('npm install'));
	t.true(approved('wrangler d1 execute db --local --command "select 1"'));
});

test('hard-stop words in a commit message or heredoc are text, not commands', t => {
	t.true(
		approved(
			'git commit -m "$(cat <<EOF\nsudo is mentioned; doctl too\nEOF\n)"',
		),
	);
	t.true(approved('git commit -m "fix; sudo rm -rf / no more"'));
	t.true(approved("echo 'aws s3 ls' > notes.txt"));
});

test('an agent cannot approve its own hold', t => {
	for (const command of [
		'pappardelle holds approve h1',
		'pappardelle answer STA-1 --option 1',
		'pappardelle send STA-1 --keys 1',
		'echo x >> ~/.pappardelle/repos/r/holds/h1.json',
		'cat > $HOME/.pappardelle/state.db',
		'tmux send-keys -t main y Enter',
		'tmux -L pappardelle_inner paste-buffer -t x',
	]) {
		t.false(approved(command), `${command}`);
	}

	t.true(approved('pappardelle send STA-2 "rebase please"'));
	t.true(approved('tmux -S /tmp/q-a/s send-keys -t x y'));
	t.true(approved('qtmux a send-keys -t x y'));
});

test('a push to main or the default branch holds, in any form', t => {
	for (const command of [
		'git push origin main',
		'git push origin HEAD:main',
		'git push origin +main',
		'git push origin refs/heads/main',
		'git push origin HEAD:refs/heads/master',
		'git push origin :main',
		'git push origin --delete main',
		'git push --force origin trunk',
		'git -C . push origin main',
		'git push --mirror',
		'git push --all origin',
	]) {
		t.false(approved(command), `${command}`);
	}

	t.false(approved('git push origin sd-x', main));
});

test('kill-server and typing into tmux are approved only on an isolated QA socket', t => {
	t.true(approved('tmux -S /tmp/q-abc/s kill-server'));
	t.true(approved('X=1 qenv a tmux kill-session -t a'));
	t.false(approved('tmux kill-server'));
	t.false(approved('TMUX_TMPDIR=/tmp/x tmux kill-server'));
	t.false(approved('tmux kill-server # -S /tmp/q-a/s'));
	t.false(approved('tmux -S /tmp/q-a/s -S /tmp/tmux-1000/default kill-server'));
	t.false(approved('tmux -S /tmp/q-a/../../run/tmux-1000/default kill-server'));
	t.false(approved('tmux -S /tmp/q-a/tlink/pappardelle_inner kill-server'));
	t.false(approved('tmux -S /tmp/q-a kill-server'));
});

test('qkill holds, since it globs for sockets and could follow a link to the user’s server', t => {
	t.false(approved('qkill abc'));
	t.false(
		approved(
			'qkill() { for s in /tmp/q-$1/s /tmp/q-$1/*/*; do [ -S "$s" ] && env -u TMUX tmux -S "$s" kill-server; done; }; grep -c x a.txt',
		),
	);
});

test('a prompt whose command reads as empty holds', t => {
	t.false(approved(''));
	t.false(approved(' \n '));
});

test('a hold says why', t => {
	t.deepEqual(checkApproval('git push origin main', policy), {
		kind: 'hold',
		reason: 'a push to main',
	});
	t.deepEqual(checkApproval('rm -rf /etc/x', policy), {
		kind: 'hold',
		reason: 'rm: /etc/x is outside the space',
	});
	t.deepEqual(checkApproval('doctl account get', policy), {
		kind: 'hold',
		reason: 'doctl deploys or reaches a cloud account',
	});
});

// Each of these reached the model check before; found by adversarial QA.
test('evasions of the delete, hard-stop and push rules hold', t => {
	for (const command of [
		'rm -rf /tmp/claude-1000/*',
		'rm -rf /tmp/claude-1000/-home*',
		'rm -rf /tmp/claude-1000/other-space/scratchpad',
		"bash -c 'doctl apps list'",
		"sh -c 'rm -rf /home/u/x'",
		"zsh -lc 'npm publish'",
		'git push --repo=origin HEAD:trunk',
		'git stash clear',
		'git -C sub stash pop',
		'git worktree remove ../other',
		'find h/. -delete',
		'find -L dist -delete',
		'find -P /home/x -delete',
		'find dist -follow -delete',
		'rm -rf $(echo /home/x)',
		'rm -rf `echo /home/x`',
		'CDPATH=/home/x; cd .config && rm -rf *',
		'D=/tmp/q-a; unset D; rm -rf $D/home/x',
		'f() { local D; rm -rf $D/home/x; }; D=/tmp/q-a; f',
		"D=/tmp/q-a; eval 'D'=/home/x; rm -rf $D",
		'D=/tmp/q-a; . ./setd.sh; rm -rf $D',
		'\\rm -rf /home/x',
		"r''m -rf /home/x",
		'env -u X rm -rf /home/x',
		'env -C /home rm -rf x',
		'nice -n 10 rm -rf /home/x',
		'timeout 5 rm -rf /home/x',
		'stdbuf -o0 rm -rf /home/x',
		'busybox rm -rf /home/x',
		'eval rm -rf /home/x',
		'env -u X doctl apps list',
		'nice -n 5 doctl apps list',
		'echo a | xargs doctl',
		'eval "doctl apps list"',
		'd"o"ctl apps list',
		'\\doctl apps list',
		// eslint-disable-next-line no-template-curly-in-string
		'doctl${IFS}account get',
		'x=doctl; $x account get',
		'timeout 30 doctl apps list',
		'exec -a foo doctl apps list',
		'yarn wrangler deploy',
		'pnpm wrangler deploy',
		'npm --registry x publish',
		'yarn npm publish',
		'docker image push x/y',
		'docker buildx build --push .',
		'aws-vault exec p -- aws s3 ls',
		'pkexec id',
		'su -c id',
		'B=main; git push origin $B',
		"git push origin ma''in",
		'git push origin HEAD:heads/main',
		'git push origin {HEAD:sd-y,HEAD:main}',
		'git push origin $(git rev-parse HEAD):main',
		'git -c push.default=upstream push',
		'git config remote.origin.push HEAD:main && git push',
		'pappardelle send STA-1 --keys=1',
		'echo x > "$HOME"/.pappardelle/x',
		'echo x > ~/./.pappardelle/x',
		'cd ~ && echo > .pappardelle/x',
		'tmux send-k -t main y',
		'tmux kill-ses -t x',
		'tmux kill-window -t x',
		'tmux run "tmux send-keys -t main y"',
		'qenv x env TMUX_TMPDIR=/tmp tmux kill-server',
		'qtmux x -S /tmp/tmux-1000/default kill-server',
		"echo '{}' > .claude/settings.local.json",
		'echo x | tee -a .mcp.json',
		'P=.pappardelle; echo x > ~/$P/x',
		'find -- h/. -delete',
		'find $(echo /home/x) -delete',
		'find -files0-from list -delete',
		'D=/tmp/q-a; D=; rm -rf $D/home/x',
		'D=/tmp/q-a; export D=; rm -rf $D/home/x',
		'/usr/bin/env rm -rf /home/x',
		"env -S 'doctl apps list'",
		'/usr/bin/env doctl apps list',
		'timeout -s 9 5 rm -rf /home/x',
		'flock l doctl apps list',
		'chrt -f 1 doctl apps list',
		'parallel doctl ::: x',
		'coproc doctl apps list',
		'pnpm --filter x exec wrangler deploy',
		'bun run wrangler deploy',
		'buildah push x',
		'skopeo copy a b',
		'gh release upload v1 x.zip',
		'flyctl secrets set A=b',
		'netlify env:set A b',
		'scp x dokku@h:',
		'git push origin :',
		'git push origin +:',
		'git -C /home/u/main push origin HEAD',
		'git --git-dir=/home/u/main/.git push',
		'cd /home/u/main && git push origin HEAD',
		"tmux -S /tmp/q-x/s run 'tmux -S /tmp/tmux-1000/default kill-server'",
		"tmux pipe-pane -I -t main 'echo y'",
		"tmux display-popup -E 'tmux send-keys y'",
		'tmux source-file x.conf',
		"qenv x bash -c 'tmux -S /tmp/tmux-1000/default kill-server'",
		'qenv x env -u TMUX_TMPDIR tmux kill-server',
		'cp x .mcp.json',
		'mv x .claude/settings.local.json',
		"sed -i 's/a/b/' .claude/settings.local.json",
		'ln -sf /x .claude/settings.local.json',
		'dd if=x of=.mcp.json',
		'echo >| .mcp.json',
		'cd .claude && echo > settings.local.json',
		'echo > .claude//settings.local.json',
		'echo > .Claude/settings.json',
		'qenv x/.. tmux kill-server',
		'qenv "x/.." tmux kill-server',
		'rm -rf */x',
		'rm -rf */',
		'rm -rf ./*/x',
		'rm -rf ?/x',
		'ln -s .claude c2 && echo > c2/settings.json',
		'GIT_DIR=/x/.git git push origin HEAD',
		'export GIT_DIR=/x/.git; git push origin HEAD',
		'echo > ~/.pap*/x',
		'ls ~/.[p]appardelle',
		'cat $HOME/.pappardell?/x',
		'cd ~/.pap* && echo > repos/r/holds/h1.json',
		'echo > ~/.pappar{delle,}/x',
		'echo > ~/.pappar\\delle/x',
		'echo > ~/.papp"ardelle"/x',
		'D=/tmp/q-a; D[0]=; rm -rf $D/home/x',
		"env --split-string='rm -rf /home/x'",
		'env -S"rm -rf /home/x"',
		'npx rimraf /home/x',
		'trash /home/x',
		'gio trash /home/x',
		'sudoedit /etc/hosts',
		'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x',
		'gh repo sync --branch main',
		'git checkout x -- .claude/settings.local.json',
		'git restore --source=x .mcp.json',
		'echo x | sponge .mcp.json',
		"sed --in-place 's/a/b/' .claude/settings.local.json",
		'rsync x .mcp.json',
		'tmux unlink-window -k -t x',
	]) {
		t.false(approved(command), `${JSON.stringify(command)}`);
	}
});

test('the fixes for those evasions leave everyday commands alone', t => {
	for (const command of [
		'rm -f .git/index.lock',
		'ls .env*',
		'git stash push -m wip',
		'git worktree list',
		"bash -c 'rm -rf dist'",
		'rm -f .git/refs/heads/x.lock',
		'rm -f .git/worktrees/x/index.lock',
		'cat .mcp.json',
		'cp .mcp.json /tmp/q-a/mcp.json',
		'echo x > out.txt 2>/dev/null',
		'cd sub && git push origin HEAD',
		'git -C sub push origin sd-x',
		'git -C . push origin HEAD',
		`git -C ${worktree} push origin sd-x`,
		'mkdir -p /tmp/q-x && cd /tmp/q-x && rm -rf *',
		'echo x > .mcp.json.example',
		'command -v rm',
		'npx rimraf dist',
		'rm -rf dist/*',
		'cat .pappardelle.yml',
		'npm run publish-docs',
		'yarn test',
		'docker build -t x .',
		'timeout 60 bun test',
		'git push --force-with-lease origin sd-x',
		'tmux -S /tmp/q-a/s send-keys -t x y',
		'qenv x tmux -L pappardelle_inner kill-server',
		'cd /tmp/q-a && rm -rf out',
	]) {
		t.true(approved(command), `${JSON.stringify(command)}`);
	}
});
