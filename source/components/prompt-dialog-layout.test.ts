import {test, expect} from 'bun:test';
import {
	listRows,
	promptDialogLayout,
	promptDialogRows,
	READY_MAX_VISIBLE,
	type PromptDialogLayout,
} from './prompt-dialog-layout.ts';

const busy = {
	readyCount: 12,
	isReadyLoading: false,
	hasError: false,
	pickerCount: 6,
};

test('a list longer than its window reserves both "more" rows', () => {
	expect(listRows(3, 8)).toBe(3);
	expect(listRows(8, 8)).toBe(8);
	expect(listRows(9, 8)).toBe(10);
});

test('nothing is given up without a height or when the dialog fits', () => {
	const full: PromptDialogLayout = {
		showInstructions: true,
		paddingY: 1,
		readyMaxVisible: READY_MAX_VISIBLE,
		pickerMaxVisible: 4,
	};
	expect(promptDialogLayout(undefined, 4, busy)).toStrictEqual(full);
	expect(promptDialogLayout(60, 4, busy)).toStrictEqual(full);
});

test('an 80x24 pane fits a full ready list and profile list', () => {
	// 24 rows less the header and status line.
	const layout = promptDialogLayout(22, 4, busy);
	expect(promptDialogRows(layout, busy) <= 22).toBe(true);
	expect(layout.showInstructions).toBe(false);
	expect(layout.readyMaxVisible >= 2).toBe(true);
	expect(layout.pickerMaxVisible >= 2).toBe(true);
});

test('the instructions go before any list row does', () => {
	const full = promptDialogLayout(undefined, 4, busy);
	const layout = promptDialogLayout(promptDialogRows(full, busy) - 1, 4, busy);
	expect(layout.showInstructions).toBe(false);
	expect(layout.paddingY).toBe(1);
	expect(layout.readyMaxVisible).toBe(READY_MAX_VISIBLE);
	expect(layout.pickerMaxVisible).toBe(4);
});

test('the ready list shrinks before the picker', () => {
	const layout = promptDialogLayout(21, 4, busy);
	expect(layout.readyMaxVisible < READY_MAX_VISIBLE).toBe(true);
	expect(layout.pickerMaxVisible).toBe(4);
	expect(promptDialogRows(layout, busy) <= 21).toBe(true);
});

test('each list keeps two rows however short the pane is', () => {
	const layout = promptDialogLayout(5, 4, busy);
	expect(layout.readyMaxVisible).toBe(2);
	expect(layout.pickerMaxVisible).toBe(2);
});
