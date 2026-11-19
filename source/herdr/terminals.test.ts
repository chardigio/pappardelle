import test from 'ava';
import {
	SESSION_LABEL,
	envArgsToMap,
	terminalLabels,
	terminalName,
} from './terminals.ts';

// herdr refuses a name that is not 1-32 of [a-z0-9-_.], or that looks like a
// terminal address (`t7`). These are the shapes Pappardelle actually meets.
const LEGAL_NAME = /^[a-z0-9-_.]{1,32}$/;

test('terminalName makes a legal name out of a session name', t => {
	const name = terminalName('agent-pappa-chex-STA-313');
	t.regex(name, LEGAL_NAME);
	t.true(name.startsWith('agent-pappa-chex-sta-313'));
});

test('terminalName never returns something herdr reads as an address', t => {
	// A session name of exactly `t7` would otherwise be refused as an address.
	t.not(terminalName('t7'), 't7');
	t.regex(terminalName('t7'), LEGAL_NAME);
	t.notRegex(terminalName('t7'), /^t\d+$/);
});

test('terminalName is stable for one session name', t => {
	t.is(
		terminalName('companion-repo-STA-1'),
		terminalName('companion-repo-STA-1'),
	);
});

test('terminalName tells apart names that fold to the same slug', t => {
	const dotted = terminalName('agent-repo-a.b');
	const dashed = terminalName('agent-repo-a-b');
	t.not(dotted, dashed);
	t.regex(dotted, LEGAL_NAME);
	t.regex(dashed, LEGAL_NAME);
});

test('terminalName fits the 32-character ceiling', t => {
	const name = terminalName(
		'agent-a-really-long-repository-name-here-STA-12345',
	);
	t.true(name.length <= 32, `got ${name.length}: ${name}`);
	t.regex(name, LEGAL_NAME);
});

test('terminalName copes with a name that folds to nothing', t => {
	const name = terminalName('!!!');
	t.regex(name, LEGAL_NAME);
	t.true(name.length > 0);
});

test('terminalName drops characters hc would reject', t => {
	const name = terminalName('agent-repo-STA_313:x/y');
	t.regex(name, LEGAL_NAME);
});

test('terminalLabels carries the session, kind and repo', t => {
	const labels = terminalLabels('agent-repo-STA-1', 'companion', 'repo');
	t.is(labels[SESSION_LABEL], 'agent-repo-STA-1');
	t.is(labels['pappardelle.kind'], 'companion');
	t.is(labels['pappardelle.repo'], 'repo');
});

test('envArgsToMap folds tmux -e pairs into a map', t => {
	t.deepEqual(envArgsToMap(['-e', 'A=1', '-e', 'B=2']), {A: '1', B: '2'});
});

test('envArgsToMap keeps an equals sign inside a value', t => {
	t.deepEqual(envArgsToMap(['-e', 'OPTS=a=b=c']), {OPTS: 'a=b=c'});
});

test('envArgsToMap ignores anything that is not a -e pair', t => {
	t.deepEqual(envArgsToMap([]), {});
	t.deepEqual(envArgsToMap(['-d', '-s', 'name']), {});
	// An empty name would be meaningless in the environment.
	t.deepEqual(envArgsToMap(['-e', '=value']), {});
});
