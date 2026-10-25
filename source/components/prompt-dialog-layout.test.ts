import test from 'ava';
import {
	listRows,
	promptDialogLayout,
	promptDialogRows,
	READY_MAX_VISIBLE,
} from './prompt-dialog-layout.ts';

const busy = {
	readyCount: 12,
	isReadyLoading: false,
	hasError: false,
	pickerCount: 6,
};

test('a list longer than its window reserves both "more" rows', t => {
	t.is(listRows(3, 8), 3);
	t.is(listRows(8, 8), 8);
	t.is(listRows(9, 8), 10);
});

test('nothing is given up without a height or when the dialog fits', t => {
	const full = {
		showInstructions: true,
		paddingY: 1,
		readyMaxVisible: READY_MAX_VISIBLE,
		pickerMaxVisible: 4,
	};
	t.deepEqual(promptDialogLayout(undefined, 4, busy), full);
	t.deepEqual(promptDialogLayout(60, 4, busy), full);
});

test('an 80x24 pane fits a full ready list and profile list', t => {
	// 24 rows less the header and status line.
	const layout = promptDialogLayout(22, 4, busy);
	t.true(promptDialogRows(layout, busy) <= 22);
	t.false(layout.showInstructions);
	t.true(layout.readyMaxVisible >= 2);
	t.true(layout.pickerMaxVisible >= 2);
});

test('the instructions go before any list row does', t => {
	const full = promptDialogLayout(undefined, 4, busy);
	const layout = promptDialogLayout(promptDialogRows(full, busy) - 1, 4, busy);
	t.false(layout.showInstructions);
	t.is(layout.paddingY, 1);
	t.is(layout.readyMaxVisible, READY_MAX_VISIBLE);
	t.is(layout.pickerMaxVisible, 4);
});

test('the ready list shrinks before the picker', t => {
	const layout = promptDialogLayout(21, 4, busy);
	t.true(layout.readyMaxVisible < READY_MAX_VISIBLE);
	t.is(layout.pickerMaxVisible, 4);
	t.true(promptDialogRows(layout, busy) <= 21);
});

test('each list keeps two rows however short the pane is', t => {
	const layout = promptDialogLayout(5, 4, busy);
	t.is(layout.readyMaxVisible, 2);
	t.is(layout.pickerMaxVisible, 2);
});

test('the search row adds one row to the picker', t => {
	const layout = promptDialogLayout(undefined, 4, busy);
	t.is(
		promptDialogRows(layout, {...busy, isSearching: true}),
		promptDialogRows(layout, busy) + 1,
	);
});

test('an empty search result still keeps one row for its message', t => {
	const layout = promptDialogLayout(undefined, 4, busy);
	t.is(
		promptDialogRows(layout, {...busy, pickerCount: 0, isSearching: true}),
		promptDialogRows(layout, {...busy, pickerCount: 1}) + 1,
	);
});
