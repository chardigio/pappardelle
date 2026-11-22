import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {runOpenSpaceCommand} from './open-space-command.ts';
import {testState} from '../test/helpers/state.ts';

test.serial(
	'an agent that is not confirmed exits 3 and leaves the space registered',
	async t => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-wait-'));
		const {registry} = testState(t).daos;
		t.teardown(() => {
			fs.rmSync(dir, {recursive: true, force: true});
		});
		const idow = path.join(dir, 'idow');
		fs.writeFileSync(idow, '#!/bin/sh\necho "Workspace STE-5 is ready!"\n', {
			mode: 0o755,
		});
		const asked: Array<[string, number]> = [];
		const before = Date.now();
		const status = await runOpenSpaceCommand({
			command: idow,
			prompt: 'STE-5',
			issueKey: null,
			resume: true,
			cwd: dir,
			env: process.env,
			registry,
			async waitForAgent(issueKey, since) {
				asked.push([issueKey, since]);
				return false;
			},
		});
		t.is(status, 3);
		t.deepEqual(registry.openSpaces(), ['STE-5']);
		t.is(asked.length, 1);
		t.is(asked[0]![0], 'STE-5');
		t.true(asked[0]![1] >= before && asked[0]![1] <= Date.now());
	},
);
