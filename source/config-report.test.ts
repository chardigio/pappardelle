import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	readReportedConfig,
	reportConfigEvent,
	reportWhileInvalid,
} from './config-report.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';

const BROKEN = 'agent_profiles:\n  opus:\n    command: claude\n    model: 7\n';
const BROKEN_ELSEWHERE =
	'agent_profiles:\n  opus:\n    command: claude\n    effort: 7\n';

function project(t: {teardown: (fn: () => void) => void}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-report-'));
	t.teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const file = path.join(dir, '.pappardelle.yml');
	return {
		paths: {homeConfigDir: path.join(dir, 'home'), projectDir: dir},
		write(content: string) {
			fs.writeFileSync(file, content);
		},
	};
}

const messages = () => getRecentErrors().map(entry => entry.message);
const stateLines = () =>
	messages().filter(message =>
		message.startsWith('.pappardelle.yml is invalid'),
	);

test.serial('an invalid config raises one state line naming the field', t => {
	clearRecentErrors();
	const {paths, write} = project(t);
	write(BROKEN);
	readReportedConfig(paths);
	readReportedConfig(paths);
	t.is(stateLines().length, 1);
	t.true(stateLines()[0]!.includes('agent_profiles.opus.model'));
});

test.serial('a config broken another way replaces the state line', t => {
	clearRecentErrors();
	const {paths, write} = project(t);
	write(BROKEN);
	readReportedConfig(paths);
	write(BROKEN_ELSEWHERE);
	readReportedConfig(paths);
	t.is(stateLines().length, 1);
	t.true(stateLines()[0]!.includes('agent_profiles.opus.effort'));
});

test.serial('the state line comes back after the rail drops it', t => {
	clearRecentErrors();
	const {paths, write} = project(t);
	write(BROKEN);
	readReportedConfig(paths);
	clearRecentErrors();
	readReportedConfig(paths);
	t.is(stateLines().length, 1);
});

test.serial(
	'fixing the config clears the state line and what held while it was invalid, not events',
	t => {
		clearRecentErrors();
		const {paths, write} = project(t);
		write(BROKEN);
		readReportedConfig(paths);
		reportWhileInvalid('Sessions of A-1 not started: the config is invalid');
		reportConfigEvent(
			'Closed A-2 without its deinit commands: the config is invalid',
		);
		write('version: 1\nprofiles: {}\n');
		readReportedConfig(paths);
		t.deepEqual(messages(), [
			'Closed A-2 without its deinit commands: the config is invalid',
		]);
	},
);
