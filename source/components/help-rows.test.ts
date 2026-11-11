import test from 'ava';
import {buildHelpRows} from './help-rows.ts';

test('the group collapse keys show only on a grouped rail', t => {
	const keys = (grouped: boolean) =>
		buildHelpRows([], grouped).fixed.map(row => row.key);
	t.false(keys(false).includes('z'));
	t.true(keys(true).includes('z'));
	t.true(keys(true).includes('Enter / Space'));
});

test('a custom binding on z hides the built-in group toggle from help', t => {
	const keys = new Set(
		buildHelpRows([{key: 'z', name: 'Zap', run: 'true'}], true).fixed.map(
			row => row.key,
		),
	);
	t.false(keys.has('z'));
	t.true(keys.has('Enter / Space'));
});
