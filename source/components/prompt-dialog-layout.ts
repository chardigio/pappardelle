export const READY_MAX_VISIBLE = 8;

const READY_MIN_VISIBLE = 2;
const PICKER_MIN_VISIBLE = 2;

export type PromptDialogLayout = {
	showInstructions: boolean;
	paddingY: 0 | 1;
	readyMaxVisible: number;
	pickerMaxVisible: number;
};

/**
 * Rows a windowed list draws. A list longer than its window can show a
 * "more" row at each end, and both are counted so the dialog keeps its height
 * as the cursor moves through the list.
 */
export function listRows(count: number, maxVisible: number): number {
	return count <= maxVisible ? count : maxVisible + 2;
}

type Content = {
	readyCount: number;
	isReadyLoading: boolean;
	hasError: boolean;
	pickerCount: number;
	/**
	 * The profile search row is on screen. It takes one row above the list,
	 * and an empty result still shows one row that says so.
	 */
	isSearching?: boolean;
};

export function promptDialogRows(
	layout: PromptDialogLayout,
	{readyCount, isReadyLoading, hasError, pickerCount, isSearching}: Content,
): number {
	// Top rule, input, margin, hint and bottom border.
	const prompt =
		5 +
		(layout.showInstructions ? 4 : 0) +
		2 * layout.paddingY +
		(hasError ? 2 : 0);
	let ready = 0;
	if (isReadyLoading) ready = 1;
	// Frame (2), the rows, and the hint under the frame.
	else if (readyCount > 0)
		ready = 3 + listRows(readyCount, layout.readyMaxVisible);
	const picker = isSearching
		? 4 + listRows(Math.max(1, pickerCount), layout.pickerMaxVisible)
		: 3 + listRows(pickerCount, layout.pickerMaxVisible);
	return prompt + ready + picker;
}

/**
 * Fit the new-session dialog into `availableHeight` rows. Space comes out of
 * the instructions first, then the prompt box's padding, then the ready list
 * and the picker, so the text field and at least two rows of each list stay
 * on screen.
 */
export function promptDialogLayout(
	availableHeight: number | undefined,
	pickerMaxVisible: number,
	content: Content,
): PromptDialogLayout {
	const layout: PromptDialogLayout = {
		showInstructions: true,
		paddingY: 1,
		readyMaxVisible: READY_MAX_VISIBLE,
		pickerMaxVisible,
	};
	if (availableHeight === undefined) return layout;

	const fits = () => promptDialogRows(layout, content) <= availableHeight;
	if (fits()) return layout;
	layout.showInstructions = false;
	if (fits()) return layout;
	layout.paddingY = 0;

	while (!fits() && layout.readyMaxVisible > READY_MIN_VISIBLE) {
		layout.readyMaxVisible--;
	}

	while (!fits() && layout.pickerMaxVisible > PICKER_MIN_VISIBLE) {
		layout.pickerMaxVisible--;
	}

	return layout;
}
