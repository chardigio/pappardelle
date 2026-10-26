import type {KeybindingConfig} from '../config.ts';

export type HelpRow = {key: string; description: string; isCustom: boolean};

/** Default descriptions for overridable keys. */
const defaultKeyDescriptions: Record<string, string> = {
	g: 'Open PR / MR in browser',
	i: 'Open issue in browser',
	d: 'Open IDE',
	o: 'Open workspace (apps, links, etc.)',
	p: 'Git pull',
	e: 'Show errors',
	K: 'Close all done/canceled spaces',
};

const fixedShortcuts: HelpRow[] = [
	{key: 'j / ↓', description: 'Move down', isCustom: false},
	{key: 'k / ↑', description: 'Move up', isCustom: false},
	{key: 'Enter / →', description: 'Focus agent pane', isCustom: false},
	{key: 'n', description: 'New space', isCustom: false},
	{key: 'x / Del', description: 'Close space', isCustom: false},
	{key: '/', description: 'Search spaces', isCustom: false},
	{key: 'U', description: 'Update to latest release', isCustom: false},
	{key: 'q', description: 'Quit', isCustom: false},
	{key: '?', description: 'Show this help', isCustom: false},
];

function describe(kb: KeybindingConfig): string {
	return kb.name + (kb.send_to_claude ? ' → agent' : '');
}

export function buildHelpRows(customKeybindings: KeybindingConfig[] = []): {
	fixed: HelpRow[];
	overridable: HelpRow[];
	extraCustom: HelpRow[];
	maxKeyLength: number;
} {
	const customByKey = new Map(customKeybindings.map(kb => [kb.key, kb]));

	// Overridden defaults show the custom description, disabled ones are
	// omitted, and the rest keep their default text.
	const overridable: HelpRow[] = [];
	for (const [key, defaultDesc] of Object.entries(defaultKeyDescriptions)) {
		const custom = customByKey.get(key);
		if (custom?.disabled) continue;
		overridable.push(
			custom
				? {key, description: describe(custom), isCustom: true}
				: {key, description: defaultDesc, isCustom: false},
		);
	}

	const extraCustom = customKeybindings
		.filter(kb => !kb.disabled && !(kb.key in defaultKeyDescriptions))
		.map(kb => ({key: kb.key, description: describe(kb), isCustom: true}));

	const maxKeyLength = Math.max(
		...[...fixedShortcuts, ...overridable, ...extraCustom].map(
			row => row.key.length,
		),
	);

	return {fixed: fixedShortcuts, overridable, extraCustom, maxKeyLength};
}

export type HelpLine =
	| {kind: 'row'; row: HelpRow}
	| {kind: 'heading'; text: string}
	| {kind: 'blank'};

/**
 * Rows the overlay spends outside the shortcut list: border and padding (4),
 * the title, version line and margin (3), and the margin and footer (2).
 */
export const HELP_CHROME_ROWS = 9;

export function helpFooter(isScrolling: boolean): string {
	return isScrolling
		? 'j/k scroll · Esc, Enter, or ? to close'
		: 'Press Esc, Enter, or ? to close';
}

/** The shortcut list as one flat run of rows, which is what scrolls. */
export function buildHelpLines(rows: {
	fixed: HelpRow[];
	overridable: HelpRow[];
	extraCustom: HelpRow[];
}): HelpLine[] {
	const lines: HelpLine[] = [...rows.fixed, ...rows.overridable].map(row => ({
		kind: 'row',
		row,
	}));
	if (rows.extraCustom.length > 0) {
		lines.push(
			{kind: 'blank'},
			{kind: 'heading', text: 'Custom Commands'},
			{kind: 'blank'},
			...rows.extraCustom.map(row => ({kind: 'row' as const, row})),
		);
	}

	return lines;
}
