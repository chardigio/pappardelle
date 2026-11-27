import {spawnSync} from 'node:child_process';
import {test, expect} from 'bun:test';

const entry = new URL('resume-token.ts', import.meta.url).pathname;

test('an inherited token is kept for the report and reaches nothing Pappardelle starts', () => {
	const script = `const {inheritedResumeToken} = await import(${JSON.stringify(entry)});
const child = (await import('node:child_process')).spawnSync('sh', ['-c', 'printf %s "${'$'}{OSC7577_TOKEN-unset}"'], {encoding: 'utf8'});
const bunChild = Bun.spawnSync(['sh', '-c', 'printf %s "${'$'}{OSC7577_TOKEN-unset}"'], {env: process.env}).stdout.toString();
console.log(JSON.stringify([inheritedResumeToken(), child.stdout, bunChild]));`;
	const result = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {...process.env, OSC7577_TOKEN: 'from-rex'},
	});
	expect(JSON.parse(result.stdout)).toStrictEqual([
		'from-rex',
		'unset',
		'unset',
	]);
});
