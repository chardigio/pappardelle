import test from 'ava';
import {
	BACKEND_NAMES,
	backendIsDesktop,
	backendUsesCore,
	herdrAttachCommand,
	parseBackendName,
	selectBackend,
} from './backend.ts';

test('parseBackendName accepts the three backends, case-insensitively', t => {
	t.is(parseBackendName('tmux'), 'tmux');
	t.is(parseBackendName('HERDR'), 'herdr');
	t.is(parseBackendName('  herdr  '), 'herdr');
	t.is(parseBackendName('herdr-app'), 'herdr-app');
	t.is(parseBackendName('Herdr-App'), 'herdr-app');
});

test('parseBackendName understands the names people try', t => {
	t.is(parseBackendName('herdr-core'), 'herdr');
	t.is(parseBackendName('hc'), 'herdr');
	t.is(parseBackendName('herdr-desktop'), 'herdr-app');
	t.is(parseBackendName('desktop'), 'herdr-app');
});

test('parseBackendName rejects anything else', t => {
	t.is(parseBackendName(undefined), null);
	t.is(parseBackendName(''), null);
	t.is(parseBackendName('screen'), null);
	t.is(parseBackendName('zellij'), null);
});

test('BACKEND_NAMES is what a config may say', t => {
	t.deepEqual([...BACKEND_NAMES], ['tmux', 'herdr', 'herdr-app']);
	for (const name of BACKEND_NAMES) {
		t.is(parseBackendName(name), name);
	}
});

test('selectBackend defaults to tmux', t => {
	const selection = selectBackend({env: {}});
	t.is(selection.name, 'tmux');
	t.is(selection.source, 'default');
});

test('selectBackend reads the config when the environment is silent', t => {
	t.is(selectBackend({env: {}, configured: 'herdr'}).name, 'herdr');
	const desktop = selectBackend({env: {}, configured: 'herdr-app'});
	t.is(desktop.name, 'herdr-app');
	t.is(desktop.source, 'config');
});

test('selectBackend lets the environment override the config', t => {
	const selection = selectBackend({
		env: {PAPPARDELLE_BACKEND: 'herdr-app'},
		configured: 'tmux',
	});
	t.is(selection.name, 'herdr-app');
	t.is(selection.source, 'env');
});

test('selectBackend ignores an unknown environment value', t => {
	const selection = selectBackend({
		env: {PAPPARDELLE_BACKEND: 'screen'},
		configured: 'herdr',
	});
	t.is(selection.name, 'herdr');
	t.is(selection.source, 'config');
});

// The two herdr backends share the core: they differ only in who owns panes.
test('backendUsesCore covers both herdr backends and not tmux', t => {
	t.true(backendUsesCore({name: 'herdr', source: 'config'}));
	t.true(backendUsesCore({name: 'herdr-app', source: 'config'}));
	t.false(backendUsesCore({name: 'tmux', source: 'default'}));
});

test('backendIsDesktop is true only for the desktop app', t => {
	t.true(backendIsDesktop({name: 'herdr-app', source: 'config'}));
	t.false(backendIsDesktop({name: 'herdr', source: 'config'}));
	t.false(backendIsDesktop({name: 'tmux', source: 'default'}));
});

test('herdrAttachCommand quotes what a shell would split', t => {
	t.is(herdrAttachCommand('agent-repo-STA-1'), 'hc attach agent-repo-STA-1');
	t.is(
		herdrAttachCommand('agent repo; rm -rf /'),
		`hc attach 'agent repo; rm -rf /'`,
	);
	t.is(herdrAttachCommand(`it's`), `hc attach 'it'\\''s'`);
});
