import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	applySkillCompletion,
	clampSelection,
	discoverSkills,
	handleSkillListKey,
	handleSkillPickerKey,
	matchSkills,
	skillQuery,
	skillTokenLength,
	SKILL_PICKER_MAX_VISIBLE,
	type SkillEntry,
} from './skill-completion.ts';

// ============================================================================
// Test helpers
// ============================================================================

let tmpCounter = 0;

function makeTmpDir(): string {
	return fs.mkdtempSync(
		path.join(
			os.tmpdir(),
			`pappardelle-skill-test-${process.pid}-${tmpCounter++}-`,
		),
	);
}

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

test('skillQuery returns the token after a leading slash', t => {
	t.is(skillQuery('/do-pap'), 'do-pap');
});

test('skillQuery returns an empty query for a bare slash', t => {
	t.is(skillQuery('/'), '');
});

test('skillQuery returns null when the text does not start with a slash', t => {
	t.is(skillQuery('fix the login bug'), null);
	t.is(skillQuery('STA-123'), null);
	t.is(skillQuery(''), null);
});

test('skillQuery returns null once the first token is finished', t => {
	t.is(skillQuery('/do-pappardelle make the rail wider'), null);
	t.is(skillQuery('/do-pappardelle '), null);
});

test('skillQuery ignores a slash that is not the first character', t => {
	t.is(skillQuery(' /do-pap'), null);
	t.is(skillQuery('fix /do-pap'), null);
});

// ============================================================================
// Backwards compatibility: no slash means byte-identical behavior
// ============================================================================

test('regression: ordinary prompts never open the completion list', t => {
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
		t.is(skillQuery(prompt), null, `prompt: ${prompt}`);
	}
});

// ============================================================================
// matchSkills: ranking
// ============================================================================

test('matchSkills returns every entry for an empty query', t => {
	const entries = [entry('do-stardust'), entry('do-pappardelle')];
	t.deepEqual(
		matchSkills(entries, '').map(m => m.name),
		['do-stardust', 'do-pappardelle'],
	);
});

test('matchSkills ranks prefix matches above substring matches', t => {
	const entries = [entry('run-pappardelle'), entry('pappardelle-init')];
	t.deepEqual(
		matchSkills(entries, 'pap').map(m => m.name),
		['pappardelle-init', 'run-pappardelle'],
	);
});

test('matchSkills is case-insensitive', t => {
	const entries = [entry('do-pappardelle')];
	t.deepEqual(
		matchSkills(entries, 'DO-PAP').map(m => m.name),
		['do-pappardelle'],
	);
});

test('matchSkills drops entries that do not match', t => {
	const entries = [entry('do-pappardelle'), entry('publish-hive-beta')];
	t.deepEqual(
		matchSkills(entries, 'hive').map(m => m.name),
		['publish-hive-beta'],
	);
});

test('matchSkills ranks repo entries above user entries within a tier', t => {
	const entries = [
		entry('papa-user', {source: 'user'}),
		entry('papa-repo', {source: 'repo'}),
	];
	t.deepEqual(
		matchSkills(entries, 'papa').map(m => m.name),
		['papa-repo', 'papa-user'],
	);
});

test('matchSkills does not match against descriptions', t => {
	const entries = [entry('publish-hive-beta', {description: 'pappardelle'})];
	t.deepEqual(matchSkills(entries, 'pappardelle'), []);
});

// ============================================================================
// applySkillCompletion
// ============================================================================

test('applySkillCompletion replaces the token and adds a trailing space', t => {
	t.is(applySkillCompletion('do-pappardelle'), '/do-pappardelle ');
});

// ============================================================================
// skillTokenLength: the prompt paints a leading skill name in its own color
// ============================================================================

const PAINT_ENTRIES = [
	entry('do-pappardelle'),
	entry('do-platform'),
	entry('db:reset', {kind: 'command'}),
];

test('skillTokenLength measures a completed name followed by a description', t => {
	t.is(
		skillTokenLength('/do-pappardelle fix the picker', PAINT_ENTRIES),
		'/do-pappardelle'.length,
	);
});

test('skillTokenLength measures a name that is the whole prompt', t => {
	t.is(skillTokenLength('/do-platform', PAINT_ENTRIES), '/do-platform'.length);
});

test('skillTokenLength leaves a half-typed name unpainted', t => {
	t.is(skillTokenLength('/do-pap', PAINT_ENTRIES), 0);
});

test('skillTokenLength leaves a name nobody has installed unpainted', t => {
	t.is(skillTokenLength('/not-a-real-skill run it', PAINT_ENTRIES), 0);
});

test('skillTokenLength paints a nested command in its colon form', t => {
	t.is(skillTokenLength('/db:reset now', PAINT_ENTRIES), '/db:reset'.length);
});

test('skillTokenLength ignores a prompt that does not begin with a slash', t => {
	t.is(skillTokenLength('do-pappardelle', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('add a backend endpoint', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('STA-123', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('', PAINT_ENTRIES), 0);
});

test('skillTokenLength matches the name exactly, not a prefix of it', t => {
	// `/do-plat` is a prefix of an installed name but is not itself installed.
	t.is(skillTokenLength('/do-plat form', PAINT_ENTRIES), 0);
});

// ============================================================================
// handleSkillPickerKey
// ============================================================================

test('handleSkillPickerKey clamps movement at both ends', t => {
	t.deepEqual(handleSkillPickerKey({upArrow: true}, 0, 3), {
		action: 'move',
		index: 0,
	});
	t.deepEqual(handleSkillPickerKey({downArrow: true}, 2, 3), {
		action: 'move',
		index: 2,
	});
	t.deepEqual(handleSkillPickerKey({downArrow: true}, 0, 3), {
		action: 'move',
		index: 1,
	});
});

test('handleSkillPickerKey ignores plain j and k so they stay typable', t => {
	t.deepEqual(handleSkillPickerKey({}, 1, 3), {action: 'ignore', index: 1});
});

test('handleSkillPickerKey reports escape as a close', t => {
	t.deepEqual(handleSkillPickerKey({escape: true}, 1, 3), {
		action: 'close',
		index: 1,
	});
});

test('handleSkillPickerKey accepts on tab, so the prompt never has to leave', t => {
	t.deepEqual(handleSkillPickerKey({tab: true}, 2, 3), {
		action: 'accept',
		index: 2,
	});
});

test('handleSkillPickerKey ignores tab when the list is empty', t => {
	t.deepEqual(handleSkillPickerKey({tab: true}, 0, 0), {
		action: 'ignore',
		index: 0,
	});
});

// ============================================================================
// handleSkillListKey: the same list, once Enter has handed it the focus
// ============================================================================

test('handleSkillListKey moves on arrows and clamps at both ends', t => {
	t.deepEqual(handleSkillListKey('', {upArrow: true}, 0, 3), {
		action: 'move',
		index: 0,
	});
	t.deepEqual(handleSkillListKey('', {downArrow: true}, 2, 3), {
		action: 'move',
		index: 2,
	});
	t.deepEqual(handleSkillListKey('', {downArrow: true}, 0, 3), {
		action: 'move',
		index: 1,
	});
});

test('handleSkillListKey moves on j and k, which the frozen input no longer needs', t => {
	t.deepEqual(handleSkillListKey('j', {}, 0, 3), {action: 'move', index: 1});
	t.deepEqual(handleSkillListKey('k', {}, 2, 3), {action: 'move', index: 1});
});

test('handleSkillListKey accepts on both enter and tab', t => {
	t.deepEqual(handleSkillListKey('', {return: true}, 1, 3), {
		action: 'accept',
		index: 1,
	});
	t.deepEqual(handleSkillListKey('', {tab: true}, 1, 3), {
		action: 'accept',
		index: 1,
	});
});

test('handleSkillListKey ignores an accept for a row that is not there', t => {
	t.deepEqual(handleSkillListKey('', {return: true}, 0, 0), {
		action: 'ignore',
		index: 0,
	});
});

test('handleSkillListKey hands the focus back on escape', t => {
	t.deepEqual(handleSkillListKey('', {escape: true}, 2, 3), {
		action: 'back',
		index: 2,
	});
});

test('handleSkillListKey ignores an ordinary letter', t => {
	t.deepEqual(handleSkillListKey('q', {}, 1, 3), {action: 'ignore', index: 1});
});

// ============================================================================
// discoverSkills
// ============================================================================

test('discoverSkills reads repo skills with their descriptions', t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'do-pappardelle', 'Work through a TODO checklist.');
	const found = discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(found, [
		{
			name: 'do-pappardelle',
			description: 'Work through a TODO checklist.',
			source: 'repo',
			kind: 'skill',
		},
	]);
});

test('discoverSkills tolerates a skill with no description', t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'bare', null);
	const found = discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.is(found[0]?.description, '');
});

test('discoverSkills reads commands, including nested ones', t => {
	const repo = makeTmpDir();
	writeCommand(repo, 'deploy', 'Ship it.');
	writeCommand(repo, 'db/reset', 'Reset the database.');
	const found = discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(found.map(f => f.name).sort(), ['db:reset', 'deploy']);
	t.true(found.every(f => f.kind === 'command'));
});

test('discoverSkills includes user skills and marks their source', t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	writeSkill(repo, 'repo-skill', 'From the repo.');
	writeSkill(home, 'user-skill', 'From home.');
	const found = discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => [f.name, f.source]),
		[
			['repo-skill', 'repo'],
			['user-skill', 'user'],
		],
	);
});

test('discoverSkills lets a repo entry hide a user entry of the same name', t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	writeSkill(repo, 'shared', 'Repo version.');
	writeSkill(home, 'shared', 'User version.');
	const found = discoverSkills({repoRoot: repo, homeDir: home});
	t.is(found.length, 1);
	t.is(found[0]?.description, 'Repo version.');
	t.is(found[0]?.source, 'repo');
});

test('discoverSkills returns an empty list when nothing is installed', t => {
	t.deepEqual(
		discoverSkills({repoRoot: makeTmpDir(), homeDir: makeTmpDir()}),
		[],
	);
});

test('discoverSkills skips a skill directory with no SKILL.md', t => {
	const repo = makeTmpDir();
	fs.mkdirSync(path.join(repo, '.claude', 'skills', 'empty'), {
		recursive: true,
	});
	t.deepEqual(discoverSkills({repoRoot: repo, homeDir: makeTmpDir()}), []);
});

test('discoverSkills sorts entries by name within each source', t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'zebra', 'Z.');
	writeSkill(repo, 'alpha', 'A.');
	t.deepEqual(
		discoverSkills({repoRoot: repo, homeDir: makeTmpDir()}).map(f => f.name),
		['alpha', 'zebra'],
	);
});

test('SKILL_PICKER_MAX_VISIBLE keeps the box a sane height', t => {
	t.true(SKILL_PICKER_MAX_VISIBLE >= 3 && SKILL_PICKER_MAX_VISIBLE <= 8);
});

// ============================================================================
// clampSelection: the rendered highlight and the accepted entry must agree
// ============================================================================

test('clampSelection leaves an in-range index alone', t => {
	t.is(clampSelection(2, 5), 2);
});

test('clampSelection falls back to the first row when the list shrinks', t => {
	t.is(clampSelection(4, 2), 0);
});

test('clampSelection treats an index one past the end as out of range', t => {
	t.is(clampSelection(2, 2), 0);
});

test('clampSelection returns zero for an empty list', t => {
	t.is(clampSelection(3, 0), 0);
});

test('clampSelection floors a negative index at zero', t => {
	t.is(clampSelection(-1, 5), 0);
});

test('regression: a narrowed list never strands Enter on a missing entry', t => {
	// Arrow down to row 3, then type until only two entries survive. The
	// rendered highlight and the entry Enter accepts have to be the same row,
	// or Enter silently does nothing.
	const narrowed = [entry('do-pappardelle'), entry('do-personal')];
	const index = clampSelection(3, narrowed.length);
	t.is(index, 0);
	t.truthy(narrowed[index]);
});
