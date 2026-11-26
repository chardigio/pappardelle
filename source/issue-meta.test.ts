import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';

test('an issue Pappardelle created is recorded with the time, to the second', async () => {
	const s = testState({clock: () => new Date('2026-01-02T03:04:05.678Z')});
	expect(s.daos.issueMeta.read('STA-1')).toBe(null);
	await s.daos.issueMeta.markCreated('STA-1');
	expect(s.daos.issueMeta.read('STA-1')).toStrictEqual({
		createdByPappardelle: true,
		createdAt: '2026-01-02T03:04:05Z',
	});
	expect(s.daos.issueMeta.read('STA-2')).toBe(null);
});
