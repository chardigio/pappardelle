import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {test, expect} from 'bun:test';
import {buildResumeReport, verifyResumeReport} from './program-resume.ts';

// The token and time the spec's examples were made with.
const TOKEN = 'dummy-token-replace-me';
const NOW = 1_795_543_200;
const b64 = (value: string) => Buffer.from(value).toString('base64');
const signed = (body: string, token = TOKEN) =>
	`${body}:mac=${createHash('sha256').update(`${body}:${token}`).digest('hex')}`;
const verify = (body: string) => verifyResumeReport(body, TOKEN, NOW);

test('the spec examples verify with their published MACs', () => {
	expect(
		verify(
			'pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b',
		),
	).toStrictEqual({
		type: 'set',
		pid: 74_877,
		time: NOW,
		argv: ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'],
	});
	expect(
		verify(
			'pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93',
		),
	).toStrictEqual({type: 'clear', pid: 74_877, time: NOW});
	expect(
		verify(
			'pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1',
		),
	).toStrictEqual({
		type: 'set',
		pid: 74_877,
		time: NOW,
		argv: ['lazygit'],
		cwd: '/home/user/src/project',
	});
	expect(
		verify(
			'pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65',
		),
	).toStrictEqual({
		type: 'set',
		pid: 90_412,
		time: NOW,
		argv: ['resume-wrap', 'ssh', 'devbox'],
	});
});

test('the spec table of ignored reports', () => {
	const ignored = (body: string) => expect(verify(body).type).toBe('ignored');
	ignored(`pid=74877:time=${NOW}:argv=bnZpbQ==:mac=${'0'.repeat(64)}`);
	ignored(`pid=74877:time=${NOW}:argv=bnZpbQ==`);
	const tail = signed(`pid=74877:time=${NOW}:argv=bnZpbQ==`);
	ignored(
		`${tail.slice(tail.indexOf('mac='))}:${tail.slice(0, tail.indexOf(':mac='))}`,
	);
	ignored(signed('pid=74877:time=1000000000:argv=bnZpbQ=='));
	ignored(signed('pid=74877:argv=bnZpbQ=='));
	ignored('?');
});

test('a report signed with another token, or replayed outside the window, is ignored', () => {
	const body = `pid=1:time=${NOW}:argv=${b64('vim')}`;
	expect(verify(signed(body, 'another-token')).type).toBe('ignored');
	expect(verifyResumeReport(signed(body), TOKEN, NOW + 61).type).toBe(
		'ignored',
	);
	expect(verifyResumeReport(signed(body), TOKEN, NOW - 61).type).toBe(
		'ignored',
	);
	expect(verifyResumeReport(signed(body), TOKEN, NOW + 60).type).toBe('set');
	expect(
		verify(signed(`pid=1:time=${'9'.repeat(20)}:argv=${b64('vim')}`)).type,
	).toBe('ignored');
});

test('the spec table of rejected reports, which name their owner', () => {
	const rejected = (body: string) =>
		expect(verify(signed(body))).toMatchObject({
			type: 'rejected',
			pid: 74_877,
			time: NOW,
		});
	rejected(`pid=74877:time=${NOW}:argv=Li9ydW4uc2g=`);
	rejected(`pid=74877:time=${NOW}:argv=bnZpbQ==:clear=1`);
	rejected(`pid=74877:time=${NOW}:argv=bnZpbQ==:cwd=cHJvamVjdA==`);
	rejected(`pid=74877:time=${NOW}:argv=bnZpbQ==:need=later`);
});

test('reports that pass the mac and time but break the grammar are rejected', () => {
	const rejected = (body: string) =>
		expect(verify(signed(body)).type).toBe('rejected');
	const head = `pid=74877:time=${NOW}`;
	rejected(head);
	rejected(`${head}:argv=`);
	rejected(`${head}:argv=${b64('vim')}:argv=${b64('vi')}`);
	rejected(`${head}:argv=${b64('vim')}:bad`);
	rejected(`${head}:argv=${b64('vim')}:Key=x`);
	rejected(`${head}:argv=bnZpbQ=`);
	rejected(`${head}:argv=${b64('vim')},${b64('a\nb')}`);
	rejected(`${head}:argv=${b64('vim')},${b64('a\u0085b')}`);
	rejected(`${head}:argv=${Buffer.from([0xff]).toString('base64')}`);
	rejected(`${head}:argv=${b64('-vim')}`);
	rejected(`${head}:argv=${b64('bin/vim')}`);
	rejected(`${head}:clear=2`);
	rejected(`${head}:argv=${b64('vim')}:need=Argv`);
});

test('a first element with = anywhere is rejected, since env would read it as an assignment', () => {
	const head = `pid=74877:time=${NOW}`;
	expect(
		verify(signed(`${head}:argv=${b64('FOO=bar')},${b64('sh')}`)).type,
	).toBe('rejected');
	expect(
		verify(signed(`${head}:argv=${b64('/tmp/x=y')},${b64('sh')}`)).type,
	).toBe('rejected');
	expect(
		verify(signed(`${head}:argv=${b64('/bin/echo')},${b64('a=b')}`)).type,
	).toBe('set');
});

test('a pid that is missing or too large leaves the rejection with no owner', () => {
	expect(verify(signed(`time=${NOW}:argv=${b64('vim')}`))).toStrictEqual({
		type: 'rejected',
		reason: 'pid',
		time: NOW,
	});
	expect(
		verify(signed(`pid=${'9'.repeat(12)}:time=${NOW}:argv=${b64('vim')}`)),
	).toStrictEqual({
		type: 'rejected',
		reason: 'pid',
		time: NOW,
	});
});

test('unknown keys are ignored unless need names them, and need may name implemented keys', () => {
	expect(
		verify(signed(`pid=7:time=${NOW}:argv=${b64('vim')}:later=x`)).type,
	).toBe('set');
	expect(
		verify(signed(`pid=7:time=${NOW}:argv=${b64('vim')}:need=argv,cwd`)).type,
	).toBe('set');
	expect(
		verify(signed(`pid=7:time=${NOW}:argv=${b64('vim')},,${b64('x')}`)),
	).toMatchObject({
		argv: ['vim', '', 'x'],
	});
	expect(verify(signed(`pid=7:time=${NOW}:argv=bnZpbQ,YQ`))).toMatchObject({
		argv: ['nvim', 'a'],
	});
});

test('buildResumeReport makes a sequence that verifies', () => {
	const sequence = buildResumeReport(
		{
			pid: 42,
			time: NOW,
			argv: ['/usr/bin/pappardelle', 'a b', ''],
			cwd: '/tmp/x y',
		},
		TOKEN,
	);
	expect(sequence.startsWith('\u001B]7577;')).toBe(true);
	expect(sequence.endsWith('\u001B\\')).toBe(true);
	expect(verify(sequence.slice(7, -2))).toStrictEqual({
		type: 'set',
		pid: 42,
		time: NOW,
		argv: ['/usr/bin/pappardelle', 'a b', ''],
		cwd: '/tmp/x y',
	});
	expect(
		verify(
			buildResumeReport({pid: 42, time: NOW, clear: true}, TOKEN).slice(7, -2),
		),
	).toStrictEqual({
		type: 'clear',
		pid: 42,
		time: NOW,
	});
});

test('a report rejected for its grammar still names its owner, and a second mac is a repeat', () => {
	const head = `pid=74877:time=${NOW}`;
	for (const body of [
		`${head}:argv=${b64('vim')}:Foo=1`,
		`${head}:argv=${b64('vim')}:argv=${b64('vi')}`,
		`${head}:time=${NOW}:argv=${b64('vim')}`,
		`${head}:argv=!!!`,
		`${head}:argv=${b64('vim')}:mac=${'a'.repeat(64)}`,
	])
		expect(verify(signed(body))).toMatchObject({type: 'rejected', pid: 74_877});
});
