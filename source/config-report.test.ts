import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	readReportedConfig,
	reportConfigEvent,
	reportStartedWithInvalidConfig,
	reportWhileInvalid,
} from './config-report.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';

const BROKEN = 'agent_profiles:\n  opus:\n    command: claude\n    model: 7\n';
const BROKEN_ELSEWHERE =
	'agent_profiles:\n  opus:\n    command: claude\n    effort: 7\n';

function project() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-report-'));
	teardown(() => {
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

test('an invalid config raises one state line naming the field', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	readReportedConfig(paths);
	expect(stateLines().length).toBe(1);
	expect(stateLines()[0]!.includes('agent_profiles.opus.model')).toBe(true);
});

test('a config broken another way replaces the state line', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	write(BROKEN_ELSEWHERE);
	readReportedConfig(paths);
	expect(stateLines().length).toBe(1);
	expect(stateLines()[0]!.includes('agent_profiles.opus.effort')).toBe(true);
});

test('the state line comes back after the rail drops it', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	clearRecentErrors();
	readReportedConfig(paths);
	expect(stateLines().length).toBe(1);
});

test('fixing the config clears the state line and what held while it was invalid, not events', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	reportWhileInvalid('Sessions of A-1 not started: the config is invalid');
	reportConfigEvent(
		'Skipped the deinit commands of A-2: the config is invalid',
	);
	write('version: 1\nprofiles: {}\n');
	readReportedConfig(paths);
	expect(messages()).toStrictEqual([
		'Skipped the deinit commands of A-2: the config is invalid',
	]);
});

test('a TUI started on an invalid config asks for a restart once the file loads', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	reportStartedWithInvalidConfig();
	write('version: 1\nprofiles: {}\n');
	readReportedConfig(paths);
	readReportedConfig(paths);
	expect(messages()).toStrictEqual([
		'.pappardelle.yml loads now: restart Pappardelle to turn keybindings, watchlists, auto-remove and rail settings back on',
	]);
});

test('deleting the broken file does not say it loads', () => {
	clearRecentErrors();
	const {paths, write} = project();
	write(BROKEN);
	readReportedConfig(paths);
	reportStartedWithInvalidConfig();
	fs.rmSync(path.join(paths.projectDir, '.pappardelle.yml'));
	readReportedConfig(paths);
	expect(messages().some(message => message.includes('loads now'))).toBe(false);
});
