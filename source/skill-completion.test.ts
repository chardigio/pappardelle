import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {press} from '../test/helpers/key-press.ts';
import {keysFromStdin} from '../test/helpers/render.ts';
import {
	applySkillCompletion,
	clampSelection,
	createSkillSnapshot,
	discoverSkills,
	reanchorSelection,
	handleSkillListKey,
	handleSkillPickerKey,
	matchSkills,
	skillQuery,
	skillTokenLength,
	SKILL_PICKER_MAX_VISIBLE,
	type SkillEntry,
} from './skill-completion.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

const skillTestDir = () => tempDir('pappardelle-skill-test-');

// ============================================================================
// Test helpers
// ============================================================================

function writeSkill(
	root: string,
	name: string,
	description: string | null,
): void {
	const dir = path.join(root, '.claude', 'skills', name);
	fs.mkdirSync(dir, {recursive: true});
	const frontmatter =
		description === null
			? `---\nname: ${name}\n---\n`
			: `---\nname: ${name}\ndescription: ${description}\n---\n`;
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}\nBody text.\n`);
}

function writeCommand(
	root: string,
	relative: string,
	description: string | null,
): void {
	const file = path.join(root, '.claude', 'commands', `${relative}.md`);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	const frontmatter =
		description === null ? '' : `---\ndescription: ${description}\n---\n`;
	fs.writeFileSync(file, `${frontmatter}Do the thing.\n`);
}

function entry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name,
		description: '',
		source: 'repo',
		kind: 'skill',
		...overrides,
	};
}

// ============================================================================
// skillQuery: when is the completion list open at all?
// ============================================================================

test('skillQuery returns the token after a leading slash', () => {
	expect(skillQuery('/do-pap')).toBe('do-pap');
});

test('skillQuery returns an empty query for a bare slash', () => {
	expect(skillQuery('/')).toBe('');
});

test('skillQuery returns null when the text does not start with a slash', () => {
	expect(skillQuery('fix the login bug')).toBe(null);
	expect(skillQuery('STA-123')).toBe(null);
	expect(skillQuery('')).toBe(null);
});

test('skillQuery returns null once the first token is finished', () => {
	expect(skillQuery('/do-pappardelle make the rail wider')).toBe(null);
	expect(skillQuery('/do-pappardelle ')).toBe(null);
});

test('skillQuery ignores a slash that is not the first character', () => {
	expect(skillQuery(' /do-pap')).toBe(null);
	expect(skillQuery('fix /do-pap')).toBe(null);
});

// ============================================================================
// Backwards compatibility: no slash means byte-identical behavior
// ============================================================================

test('regression: ordinary prompts never open the completion list', () => {
	const prompts = [
		'STA-123',
		'123',
		'https://linear.app/stardust-labs/issue/STA-123/thing',
		'add a button to the settings screen',
		'ios! fix the crash',
		'',
		'   ',
	];
	for (const prompt of prompts) {
		expect(skillQuery(prompt), `prompt: ${prompt}`).toBe(null);
	}
});

// ============================================================================
// matchSkills: ranking
// ============================================================================

test('matchSkills returns every entry for an empty query', () => {
	const entries = [entry('do-stardust'), entry('do-pappardelle')];
	expect(matchSkills(entries, '').map(m => m.name)).toStrictEqual([
		'do-stardust',
		'do-pappardelle',
	]);
});

test('matchSkills ranks prefix matches above substring matches', () => {
	const entries = [entry('run-pappardelle'), entry('pappardelle-init')];
	expect(matchSkills(entries, 'pap').map(m => m.name)).toStrictEqual([
		'pappardelle-init',
		'run-pappardelle',
	]);
});

test('matchSkills is case-insensitive', () => {
	const entries = [entry('do-pappardelle')];
	expect(matchSkills(entries, 'DO-PAP').map(m => m.name)).toStrictEqual([
		'do-pappardelle',
	]);
});

test('matchSkills drops entries that do not match', () => {
	const entries = [entry('do-pappardelle'), entry('publish-hive-beta')];
	expect(matchSkills(entries, 'hive').map(m => m.name)).toStrictEqual([
		'publish-hive-beta',
	]);
});

test('matchSkills ranks repo entries above user entries within a tier', () => {
	const entries = [
		entry('papa-user', {source: 'user'}),
		entry('papa-repo', {source: 'repo'}),
	];
	expect(matchSkills(entries, 'papa').map(m => m.name)).toStrictEqual([
		'papa-repo',
		'papa-user',
	]);
});

test('matchSkills ranks plugin entries below user entries within a tier', () => {
	const entries = [
		entry('papa:plugin', {source: 'plugin'}),
		entry('papa-user', {source: 'user'}),
	];
	expect(matchSkills(entries, 'papa').map(m => m.name)).toStrictEqual([
		'papa-user',
		'papa:plugin',
	]);
});

test('matchSkills does not match against descriptions', () => {
	const entries = [entry('publish-hive-beta', {description: 'pappardelle'})];
	expect(matchSkills(entries, 'pappardelle')).toStrictEqual([]);
});

// ============================================================================
// applySkillCompletion
// ============================================================================

test('applySkillCompletion replaces the token and adds a trailing space', () => {
	expect(applySkillCompletion('do-pappardelle')).toBe('/do-pappardelle ');
});

// ============================================================================
// skillTokenLength: the prompt paints a leading skill name in its own color
// ============================================================================

const PAINT_ENTRIES = [
	entry('do-pappardelle'),
	entry('do-platform'),
	entry('db:reset', {kind: 'command'}),
];

test('skillTokenLength measures a completed name followed by a description', () => {
	expect(
		skillTokenLength('/do-pappardelle fix the picker', PAINT_ENTRIES),
	).toBe('/do-pappardelle'.length);
});

test('skillTokenLength measures a name that is the whole prompt', () => {
	expect(skillTokenLength('/do-platform', PAINT_ENTRIES)).toBe(
		'/do-platform'.length,
	);
});

test('skillTokenLength leaves a half-typed name unpainted', () => {
	expect(skillTokenLength('/do-pap', PAINT_ENTRIES)).toBe(0);
});

test('skillTokenLength leaves a name nobody has installed unpainted', () => {
	expect(skillTokenLength('/not-a-real-skill run it', PAINT_ENTRIES)).toBe(0);
});

test('skillTokenLength paints a nested command in its colon form', () => {
	expect(skillTokenLength('/db:reset now', PAINT_ENTRIES)).toBe(
		'/db:reset'.length,
	);
});

test('skillTokenLength ignores a prompt that does not begin with a slash', () => {
	expect(skillTokenLength('do-pappardelle', PAINT_ENTRIES)).toBe(0);
	expect(skillTokenLength('add a backend endpoint', PAINT_ENTRIES)).toBe(0);
	expect(skillTokenLength('STA-123', PAINT_ENTRIES)).toBe(0);
	expect(skillTokenLength('', PAINT_ENTRIES)).toBe(0);
});

test('skillTokenLength matches the name exactly, not a prefix of it', () => {
	// `/do-plat` is a prefix of an installed name but is not itself installed.
	expect(skillTokenLength('/do-plat form', PAINT_ENTRIES)).toBe(0);
});

// ============================================================================
// handleSkillPickerKey
// ============================================================================

test('handleSkillPickerKey clamps movement at both ends', () => {
	expect(handleSkillPickerKey(press('up'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 0,
	});
	expect(handleSkillPickerKey(press('down'), 2, 3)).toStrictEqual({
		action: 'move',
		index: 2,
	});
	expect(handleSkillPickerKey(press('down'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
});

test('handleSkillPickerKey ignores plain j and k so they stay typable', () => {
	expect(handleSkillPickerKey(press('j'), 1, 3)).toStrictEqual({
		action: 'ignore',
		index: 1,
	});
	expect(handleSkillPickerKey(press('k'), 1, 3)).toStrictEqual({
		action: 'ignore',
		index: 1,
	});
});

test('handleSkillPickerKey reports escape as a close', () => {
	expect(handleSkillPickerKey(press('escape'), 1, 3)).toStrictEqual({
		action: 'close',
		index: 1,
	});
});

test('handleSkillPickerKey accepts on tab, so the prompt never has to leave', () => {
	expect(handleSkillPickerKey(press('tab'), 2, 3)).toStrictEqual({
		action: 'accept',
		index: 2,
	});
});

test('handleSkillPickerKey accepts on Shift+Tab as OpenTUI delivers it', async () => {
	const keys = await keysFromStdin('\x1b[Z');
	expect(keys.map(key => handleSkillPickerKey(key, 2, 3))).toStrictEqual([
		{action: 'accept', index: 2},
	]);
});

test('handleSkillPickerKey ignores tab when the list is empty', () => {
	expect(handleSkillPickerKey(press('tab'), 0, 0)).toStrictEqual({
		action: 'ignore',
		index: 0,
	});
});

// ============================================================================
// handleSkillListKey: the same list, once Enter has handed it the focus
// ============================================================================

test('handleSkillListKey moves on arrows and clamps at both ends', () => {
	expect(handleSkillListKey(press('up'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 0,
	});
	expect(handleSkillListKey(press('down'), 2, 3)).toStrictEqual({
		action: 'move',
		index: 2,
	});
	expect(handleSkillListKey(press('down'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
});

test('handleSkillListKey moves on j and k, which the frozen input no longer needs', () => {
	expect(handleSkillListKey(press('j'), 0, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
	expect(handleSkillListKey(press('k'), 2, 3)).toStrictEqual({
		action: 'move',
		index: 1,
	});
});

test('handleSkillListKey accepts on both enter and tab', () => {
	expect(handleSkillListKey(press('return'), 1, 3)).toStrictEqual({
		action: 'accept',
		index: 1,
	});
	expect(handleSkillListKey(press('tab'), 1, 3)).toStrictEqual({
		action: 'accept',
		index: 1,
	});
});

test('handleSkillListKey ignores an accept for a row that is not there', () => {
	expect(handleSkillListKey(press('return'), 0, 0)).toStrictEqual({
		action: 'ignore',
		index: 0,
	});
});

test('handleSkillListKey hands the focus back on escape', () => {
	expect(handleSkillListKey(press('escape'), 2, 3)).toStrictEqual({
		action: 'back',
		index: 2,
	});
});

test('handleSkillListKey ignores an ordinary letter', () => {
	expect(handleSkillListKey(press('q'), 1, 3)).toStrictEqual({
		action: 'ignore',
		index: 1,
	});
});

// ============================================================================
// discoverSkills
// ============================================================================

test('discoverSkills reads repo skills with their descriptions', async () => {
	const repo = skillTestDir();
	writeSkill(repo, 'do-pappardelle', 'Work through a TODO checklist.');
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found).toStrictEqual([
		{
			name: 'do-pappardelle',
			description: 'Work through a TODO checklist.',
			source: 'repo',
			kind: 'skill',
		},
	]);
});

test('discoverSkills tolerates a skill with no description', async () => {
	const repo = skillTestDir();
	writeSkill(repo, 'bare', null);
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found[0]?.description).toBe('');
});

test('discoverSkills reads commands, including nested ones', async () => {
	const repo = skillTestDir();
	writeCommand(repo, 'deploy', 'Ship it.');
	writeCommand(repo, 'db/reset', 'Reset the database.');
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found.map(f => f.name).sort()).toStrictEqual(['db:reset', 'deploy']);
	expect(found.every(f => f.kind === 'command')).toBe(true);
});

test('discoverSkills includes user skills and marks their source', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	writeSkill(repo, 'repo-skill', 'From the repo.');
	writeSkill(home, 'user-skill', 'From home.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(found.map(f => [f.name, f.source])).toStrictEqual([
		['repo-skill', 'repo'],
		['user-skill', 'user'],
	]);
});

test('discoverSkills lets a repo entry hide a user entry of the same name', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	writeSkill(repo, 'shared', 'Repo version.');
	writeSkill(home, 'shared', 'User version.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(found.length).toBe(1);
	expect(found[0]?.description).toBe('Repo version.');
	expect(found[0]?.source).toBe('repo');
});

test('discoverSkills returns an empty list when nothing is installed', async () => {
	expect(
		await discoverSkills({
			repoRoot: skillTestDir(),
			homeDir: skillTestDir(),
		}),
	).toStrictEqual([]);
});

test('discoverSkills skips a skill directory with no SKILL.md', async () => {
	const repo = skillTestDir();
	fs.mkdirSync(path.join(repo, '.claude', 'skills', 'empty'), {
		recursive: true,
	});
	expect(
		await discoverSkills({
			repoRoot: repo,
			homeDir: skillTestDir(),
		}),
	).toStrictEqual([]);
});

test('discoverSkills sorts entries by name within each source', async () => {
	const repo = skillTestDir();
	writeSkill(repo, 'zebra', 'Z.');
	writeSkill(repo, 'alpha', 'A.');
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found.map(f => f.name)).toStrictEqual(['alpha', 'zebra']);
});

test('discoverSkills reads a description from the top of a long SKILL.md', async () => {
	const repo = skillTestDir();
	writeSkill(repo, 'long', 'Near the top.');
	fs.appendFileSync(
		path.join(repo, '.claude', 'skills', 'long', 'SKILL.md'),
		'x'.repeat(64 * 1024),
	);
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found[0]?.description).toBe('Near the top.');
});

test('discoverSkills reads frontmatter up to 4096 characters, not bytes', async () => {
	const repo = skillTestDir();
	const dir = path.join(repo, '.claude', 'skills', 'cjk');
	fs.mkdirSync(dir, {recursive: true});
	// 1500 three-byte characters push the description past byte 4096 while
	// staying well inside the first 4096 characters.
	fs.writeFileSync(
		path.join(dir, 'SKILL.md'),
		`---\nname: ${'漢'.repeat(1500)}\ndescription: cjk desc\n---\nbody\n`,
	);
	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found[0]?.description).toBe('cjk desc');
});

test('discoverSkills keeps the other scope when one skills path is a file', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	fs.mkdirSync(path.join(repo, '.claude'), {recursive: true});
	fs.writeFileSync(path.join(repo, '.claude', 'skills'), 'not a directory');
	writeCommand(repo, 'deploy', 'Ship it.');
	writeSkill(home, 'user-skill', 'From home.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(found.map(f => [f.name, f.source])).toStrictEqual([
		['deploy', 'repo'],
		['user-skill', 'user'],
	]);
});

test('discoverSkills follows a symlinked command file and directory', async () => {
	const repo = skillTestDir();
	const shared = skillTestDir();
	fs.writeFileSync(
		path.join(shared, 'linked.md'),
		'---\ndescription: Linked.\n---\n',
	);
	fs.mkdirSync(path.join(shared, 'ops'));
	fs.writeFileSync(path.join(shared, 'ops', 'restart.md'), 'Restart.\n');
	const commands = path.join(repo, '.claude', 'commands');
	fs.mkdirSync(commands, {recursive: true});
	fs.symlinkSync(
		path.join(shared, 'linked.md'),
		path.join(commands, 'linked.md'),
	);
	fs.symlinkSync(path.join(shared, 'ops'), path.join(commands, 'ops'));
	fs.symlinkSync(
		path.join(shared, 'missing.md'),
		path.join(commands, 'dangling.md'),
	);

	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found.map(f => [f.name, f.description])).toStrictEqual([
		['linked', 'Linked.'],
		['ops:restart', ''],
	]);
});

test('discoverSkills stops at a command symlink back to an ancestor', async () => {
	const repo = skillTestDir();
	writeCommand(repo, 'loop/inner', null);
	const commands = path.join(repo, '.claude', 'commands');
	fs.symlinkSync(commands, path.join(commands, 'loop', 'back'));

	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found.map(f => f.name)).toStrictEqual(['loop:inner']);
});

test('discoverSkills hides skills and commands marked user-invocable: false', async () => {
	const repo = skillTestDir();
	writeSkill(repo, 'visible', 'Shown.');
	const hidden = path.join(repo, '.claude', 'skills', 'internal');
	fs.mkdirSync(hidden, {recursive: true});
	fs.writeFileSync(
		path.join(hidden, 'SKILL.md'),
		'---\nname: internal\ndescription: Model only.\nuser-invocable: false\n---\n',
	);
	const command = path.join(repo, '.claude', 'commands', 'quiet.md');
	fs.mkdirSync(path.dirname(command), {recursive: true});
	fs.writeFileSync(command, '---\nuser-invocable: false\n---\n');

	const found = await discoverSkills({
		repoRoot: repo,
		homeDir: skillTestDir(),
	});
	expect(found.map(f => f.name)).toStrictEqual(['visible']);
});

type PluginSpec = {
	key: string;
	manifest?: Record<string, unknown>;
	projectPath?: string;
};

function installPlugin(home: string, spec: PluginSpec): string {
	const installPath = skillTestDir();
	if (spec.manifest) {
		fs.mkdirSync(path.join(installPath, '.claude-plugin'));
		fs.writeFileSync(
			path.join(installPath, '.claude-plugin', 'plugin.json'),
			JSON.stringify(spec.manifest),
		);
	}

	const registry = path.join(
		home,
		'.claude',
		'plugins',
		'installed_plugins.json',
	);
	fs.mkdirSync(path.dirname(registry), {recursive: true});
	const current = fs.existsSync(registry)
		? (JSON.parse(fs.readFileSync(registry, 'utf8')) as {
				plugins: Record<string, unknown[]>;
			})
		: {plugins: {}};
	current.plugins[spec.key] = [
		{
			scope: spec.projectPath ? 'project' : 'user',
			installPath,
			...(spec.projectPath ? {projectPath: spec.projectPath} : {}),
		},
	];
	fs.writeFileSync(registry, JSON.stringify({version: 2, ...current}));
	return installPath;
}

function enablePlugins(
	root: string,
	file: string,
	keys: Record<string, boolean>,
) {
	fs.mkdirSync(path.join(root, '.claude'), {recursive: true});
	fs.writeFileSync(
		path.join(root, '.claude', file),
		JSON.stringify({enabledPlugins: keys}),
	);
}

test('discoverSkills lists enabled plugin skills and commands under the plugin name', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	const plugin = installPlugin(home, {
		key: 'tools@market',
		manifest: {name: 'tools'},
	});
	fs.mkdirSync(path.join(plugin, 'skills', 'lint'), {recursive: true});
	fs.writeFileSync(
		path.join(plugin, 'skills', 'lint', 'SKILL.md'),
		'---\ndescription: Lint it.\n---\n',
	);
	fs.mkdirSync(path.join(plugin, 'commands', 'db'), {recursive: true});
	fs.writeFileSync(path.join(plugin, 'commands', 'db', 'reset.md'), 'Reset.\n');
	enablePlugins(home, 'settings.json', {'tools@market': true});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(
		found.map(f => [f.name, f.source, f.kind, f.description]),
	).toStrictEqual([
		['tools:db:reset', 'plugin', 'command', ''],
		['tools:lint', 'plugin', 'skill', 'Lint it.'],
	]);
});

test('discoverSkills follows the skill and command paths a plugin manifest names', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	const plugin = installPlugin(home, {
		key: 'deep@market',
		manifest: {
			name: 'deep',
			skills: ['./skills/engineering/tdd', './bundle/'],
			commands: './extra/run.md',
		},
	});
	for (const dir of ['skills/engineering/tdd', 'bundle/review']) {
		fs.mkdirSync(path.join(plugin, dir), {recursive: true});
		fs.writeFileSync(path.join(plugin, dir, 'SKILL.md'), '---\n---\n');
	}

	fs.mkdirSync(path.join(plugin, 'skills', 'misc', 'unlisted'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(plugin, 'skills', 'misc', 'unlisted', 'SKILL.md'),
		'---\n---\n',
	);
	fs.mkdirSync(path.join(plugin, 'extra'));
	fs.writeFileSync(path.join(plugin, 'extra', 'run.md'), 'Run.\n');
	enablePlugins(home, 'settings.json', {'deep@market': true});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(found.map(f => f.name)).toStrictEqual([
		'deep:review',
		'deep:run',
		'deep:tdd',
	]);
});

test('discoverSkills skips plugins that are disabled, not enabled here, or installed for another project', async () => {
	const repo = skillTestDir();
	const home = skillTestDir();
	const keys = ['off@m', 'repo-off@m', 'other-project@m', 'repo-on@m'];
	for (const key of keys) {
		const plugin = installPlugin(home, {
			key,
			projectPath: key === 'other-project@m' ? skillTestDir() : undefined,
		});
		fs.mkdirSync(path.join(plugin, 'commands'));
		fs.writeFileSync(path.join(plugin, 'commands', 'go.md'), 'Go.\n');
	}

	installPlugin(home, {key: 'never-enabled@m'});
	enablePlugins(home, 'settings.json', {
		'off@m': false,
		'repo-off@m': true,
		'other-project@m': true,
	});
	enablePlugins(repo, 'settings.json', {'repo-on@m': true});
	enablePlugins(repo, 'settings.local.json', {'repo-off@m': false});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	expect(found.map(f => f.name)).toStrictEqual(['repo-on:go']);
});

function gitRepoWithWorktrees(worktreeCount: number) {
	const main = skillTestDir();
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', main, ...args], {stdio: 'pipe'});
	git('init', '-q');
	git(
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'initial',
	);
	const worktrees = Array.from({length: worktreeCount}, (_, index) => {
		const worktree = path.join(skillTestDir(), 'worktree');
		git('worktree', 'add', '-q', '-b', `linked-${index}`, worktree);
		return worktree;
	});
	return {main, worktrees};
}

function installEnabledCommandPlugin(
	home: string,
	key: string,
	projectPath: string,
) {
	const plugin = installPlugin(home, {key, projectPath});
	fs.mkdirSync(path.join(plugin, 'commands'));
	fs.writeFileSync(path.join(plugin, 'commands', 'go.md'), 'Go.\n');
	const settings = path.join(home, '.claude', 'settings.json');
	const enabled = fs.existsSync(settings)
		? (
				JSON.parse(fs.readFileSync(settings, 'utf8')) as {
					enabledPlugins: Record<string, boolean>;
				}
			).enabledPlugins
		: {};
	enablePlugins(home, 'settings.json', {...enabled, [key]: true});
}

test('discoverSkills offers a project plugin in every worktree of the repository it was installed in', async () => {
	const {main, worktrees} = gitRepoWithWorktrees(2);
	const [here, sibling] = worktrees as [string, string];
	const subdirectory = path.join(main, 'packages', 'app');
	fs.mkdirSync(subdirectory, {recursive: true});
	const otherRepo = gitRepoWithWorktrees(0).main;
	const home = skillTestDir();
	installEnabledCommandPlugin(home, 'main@m', main);
	installEnabledCommandPlugin(home, 'sibling@m', sibling);
	installEnabledCommandPlugin(home, 'subdirectory@m', subdirectory);
	installEnabledCommandPlugin(home, 'other-repo@m', otherRepo);
	installEnabledCommandPlugin(
		home,
		'removed@m',
		path.join(main, '.claude', 'worktrees', 'removed'),
	);

	const found = await discoverSkills({repoRoot: here, homeDir: home});
	expect(found.map(f => f.name)).toStrictEqual([
		'main:go',
		'removed:go',
		'sibling:go',
		'subdirectory:go',
	]);
});

test('discoverSkills offers a project plugin installed in a worktree from the main checkout', async () => {
	const {main, worktrees} = gitRepoWithWorktrees(1);
	const home = skillTestDir();
	installEnabledCommandPlugin(home, 'linked@m', worktrees[0]!);

	const found = await discoverSkills({repoRoot: main, homeDir: home});
	expect(found.map(f => f.name)).toStrictEqual(['linked:go']);
});

// ============================================================================
// createSkillSnapshot
// ============================================================================

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return {promise, resolve, reject};
}

const rootsA = {repoRoot: '/repo-a', homeDir: '/home'};
const rootsB = {repoRoot: '/repo-b', homeDir: '/home'};

test('createSkillSnapshot holds nothing until a scan completes', async () => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const refreshed = store.refresh(rootsA);
	expect(store.current(rootsA)).toBe(undefined);
	scan.resolve([entry('alpha')]);
	expect(await refreshed).toStrictEqual([entry('alpha')]);
	expect(store.current(rootsA)).toStrictEqual([entry('alpha')]);
});

test('createSkillSnapshot joins a scan already running for the same roots', async () => {
	const scan = deferred<SkillEntry[]>();
	let calls = 0;
	const store = createSkillSnapshot(async () => {
		calls++;
		return scan.promise;
	});
	const first = store.refresh(rootsA);
	const second = store.refresh(rootsA);
	scan.resolve([entry('alpha')]);
	expect(await Promise.all([first, second])).toStrictEqual([
		[entry('alpha')],
		[entry('alpha')],
	]);
	expect(calls).toBe(1);
	await store.refresh(rootsA);
	expect(calls).toBe(2);
});

test('createSkillSnapshot keeps the previous snapshot when a rescan fails', async () => {
	let next: () => Promise<SkillEntry[]> = async () => [entry('alpha')];
	const store = createSkillSnapshot(async () => next());
	await store.refresh(rootsA);
	next = async () => {
		throw new Error('EACCES');
	};
	expect(await store.refresh(rootsA)).toStrictEqual([entry('alpha')]);
	expect(store.current(rootsA)).toStrictEqual([entry('alpha')]);
});

test('createSkillSnapshot keeps the newer roots when an older scan lands last', async () => {
	const scanA = deferred<SkillEntry[]>();
	const scanB = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async roots =>
		roots === rootsA ? scanA.promise : scanB.promise,
	);
	const refreshA = store.refresh(rootsA);
	const refreshB = store.refresh(rootsB);
	scanB.resolve([entry('from-b')]);
	await refreshB;
	scanA.resolve([entry('from-a')]);
	await refreshA;
	expect(store.current(rootsB)).toStrictEqual([entry('from-b')]);
	expect(store.current(rootsA)).toBe(undefined);
});

test('createSkillSnapshot does not serve a snapshot taken for other roots', async () => {
	const store = createSkillSnapshot(async roots => [entry(roots.repoRoot)]);
	await store.refresh(rootsA);
	expect(store.current(rootsB)).toBe(undefined);
	expect(await store.refresh(rootsB)).toStrictEqual([entry('/repo-b')]);
});

test('SKILL_PICKER_MAX_VISIBLE keeps the box a sane height', () => {
	expect(SKILL_PICKER_MAX_VISIBLE >= 3 && SKILL_PICKER_MAX_VISIBLE <= 8).toBe(
		true,
	);
});

// ============================================================================
// clampSelection: the rendered highlight and the accepted entry must agree
// ============================================================================

test('clampSelection leaves an in-range index alone', () => {
	expect(clampSelection(2, 5)).toBe(2);
});

test('clampSelection falls back to the first row when the list shrinks', () => {
	expect(clampSelection(4, 2)).toBe(0);
});

test('clampSelection treats an index one past the end as out of range', () => {
	expect(clampSelection(2, 2)).toBe(0);
});

test('clampSelection returns zero for an empty list', () => {
	expect(clampSelection(3, 0)).toBe(0);
});

test('clampSelection floors a negative index at zero', () => {
	expect(clampSelection(-1, 5)).toBe(0);
});

test('regression: a narrowed list never strands Enter on a missing entry', () => {
	// Arrow down to row 3, then type until only two entries survive. The
	// rendered highlight and the entry Enter accepts have to be the same row,
	// or Enter silently does nothing.
	const narrowed = [entry('do-pappardelle'), entry('do-personal')];
	const index = clampSelection(3, narrowed.length);
	expect(index).toBe(0);
	expect(narrowed[index]).toBeTruthy();
});

// ============================================================================
// reanchorSelection
// ============================================================================

test('reanchorSelection follows the highlighted skill when a new one sorts ahead', () => {
	const after = [entry('do-alpha'), entry('do-new'), entry('do-plan')];
	expect(reanchorSelection('do-plan', after)).toBe(2);
});

test('reanchorSelection falls back to the top when the highlighted skill is gone', () => {
	expect(reanchorSelection('removed', [entry('a'), entry('b')])).toBe(0);
});

test('reanchorSelection starts at the top when nothing was highlighted', () => {
	expect(reanchorSelection(undefined, [entry('a'), entry('b')])).toBe(0);
});
