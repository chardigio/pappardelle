import {superviseDeps} from '../test/helpers/supervise-deps.ts';
import {test, expect} from 'bun:test';
import {runSuperviseCommand} from './supervise-command.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const OPTIONS = ['Cheese', 'Olives', 'Peppers', 'Onions'];

/**
 * A stand-in for Claude's AskUserQuestion that reacts to keys the way the
 * real one does (digits tick a multi-select, or open the free-text row),
 * drawn the way Claude draws it.
 */
class Dialog {
	checked = new Set<number>();
	/** 1-based row, or 'done' for Submit/Next. */
	cursor: number | 'done' = 1;
	text = '';
	/** The free-text row is taking keys as text. */
	open = false;
	answered = false;
	/** Rows whose digit the dialog ignores, to test the screen check. */
	deaf = new Set<string>();

	constructor(readonly multi: boolean) {}

	get textRow() {
		return OPTIONS.length + 1;
	}

	press(key: string) {
		if (this.deaf.has(key)) return;
		// An open free-text row takes digits as text, as Claude's does.
		if (this.open && /^\d$/.test(key)) {
			this.text += key;
			return;
		}

		if (this.open && key === 'C-u') {
			this.text = '';
			return;
		}

		if (/^\d$/.test(key)) {
			const row = Number(key);
			if (row === this.textRow) {
				this.cursor = row;
				this.open = true;
			} else if (this.multi) {
				if (this.checked.has(row)) this.checked.delete(row);
				else this.checked.add(row);
			} else {
				this.answered = true;
			}

			return;
		}

		if (key === 'Up' && typeof this.cursor === 'number' && this.cursor > 1) {
			if (this.cursor === this.textRow) this.open = false;
			this.cursor--;
		} else if (key === 'Down') {
			this.cursor =
				this.cursor === 'done' || this.cursor === this.textRow
					? 'done'
					: this.cursor + 1;
		} else if (key === 'Enter' && (this.cursor === 'done' || this.open)) {
			this.answered = true;
		}
	}

	type(text: string) {
		if (this.open) this.text += text;
	}

	render(): string {
		if (this.answered) return "● User answered Claude's questions:\n\n❯ \n";
		const rows = OPTIONS.map((label, index) => {
			const row = index + 1;
			const box = this.multi ? (this.checked.has(row) ? '[✔] ' : '[ ] ') : '';
			return `${this.cursor === row ? '❯' : ' '} ${row}. ${box}${label}\n     ${label} topping`;
		});
		const text = this.text || 'Type something.';
		rows.push(
			`${this.cursor === this.textRow ? '❯' : ' '} ${this.textRow}. ${this.multi ? '[ ] ' : ''}${text}`,
		);
		if (this.multi)
			rows.push(`${this.cursor === 'done' ? '❯' : ' '}    Submit`);
		return [
			'────────────────',
			this.multi ? '←  ☐ Toppings  ✔ Submit  →' : ' ☐ Toppings',
			'Which toppings do you want?',
			...rows,
			'────────────────',
			'  6. Chat about this',
			`${this.open ? '-- INSERT -- · ' : ''}Enter to select · ↑/↓ to navigate · Esc to cancel`,
		].join('\n');
	}
}

function harness(dialog: Dialog) {
	const sent: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: 'agent-repo-STA-1\n'};
		if (args[0] === 'capture-pane') return {status: 0, stdout: dialog.render()};
		return {status: 1, stdout: ''};
	};

	const {deps, logged, out, err} = superviseDeps({
		runner,
		readHookState: async () => ({kind: 'none'}),
		policy: () => ({
			worktree: null,
			roots: [],
			reserved: [],
			shared: [],
			scratchpad: '-repo',
			defaultBranch: null,
			realpath: target => target,
		}),
		holds: () => ({
			save: async () => undefined,
			load: () => null,
			list: () => [],
		}),
		sendKeys(_key, keys) {
			sent.push(...keys);
			for (const key of keys) dialog.press(key);
			return 'sent';
		},
		typeText(_key, text) {
			sent.push(`text:${text}`);
			dialog.type(text);
			return 'sent';
		},
	});
	return {
		logged,
		out,
		err,
		sent,
		run: async (...argv: string[]) =>
			runSuperviseCommand(['answer', 'STA-1', ...argv], deps),
	};
}

test('several options on a multi-select are ticked, then confirmed on Submit', async () => {
	const dialog = new Dialog(true);
	const h = harness(dialog);
	expect(await h.run('--option', '3', '--option', '1')).toBe(0);
	expect(h.sent).toStrictEqual([
		'1',
		'3',
		'Down',
		'Down',
		'Down',
		'Down',
		'Down',
		'Enter',
	]);
	expect(dialog.answered).toBe(true);
	expect(h.logged[0]).toMatchObject({
		action: 'answer',
		sent: '1. Cheese, 3. Peppers',
		detail: 'Which toppings do you want?',
	});
});

test('options already ticked are left alone and stray ticks are cleared', async () => {
	const dialog = new Dialog(true);
	dialog.checked = new Set([1, 2]);
	dialog.cursor = 4;
	const h = harness(dialog);
	expect(await h.run('--option', '1', '--option', '3')).toBe(0);
	expect(h.sent).toStrictEqual(['2', '3', 'Down', 'Down', 'Enter']);
});

test('a tick the dialog ignores stops the answer before it is confirmed', async () => {
	const dialog = new Dialog(true);
	dialog.deaf.add('3');
	const h = harness(dialog);
	expect(await h.run('--option', '1', '--option', '3')).toBe(1);
	expect(h.sent).toStrictEqual(['1', '3']);
	expect(dialog.answered).toBe(false);
	expect(h.err[0]!).toMatch(/options 1, 3 ticked didn't show/);
	expect(h.logged[0]).toMatchObject({
		detail: expect.stringMatching(/stuck: options 1, 3 ticked/),
	});
});

test('typed text goes into the free-text row and is submitted once it shows there', async () => {
	const dialog = new Dialog(false);
	const h = harness(dialog);
	expect(await h.run('--text', 'Enter the dragon')).toBe(0);
	expect(h.sent).toStrictEqual(['5', 'text:Enter the dragon', 'Enter']);
	expect(dialog.answered).toBe(true);
	expect(h.logged[0]).toMatchObject({sent: 'Enter the dragon'});
});

test('text the row never shows is not submitted', async () => {
	const dialog = new Dialog(false);
	dialog.type = () => {};
	const h = harness(dialog);
	expect(await h.run('--text', 'hello')).toBe(1);
	expect(h.sent).toStrictEqual(['5', 'text:hello']);
	expect(dialog.answered).toBe(false);
});

test('the answer rules refuse what the question cannot take', async () => {
	const multi = harness(new Dialog(true));
	expect(await multi.run('--option', '9')).toBe(1);
	expect(multi.err[0]!).toMatch(/no option 9/);
	expect(await multi.run('--text', 'hi')).toBe(1);
	expect(multi.err[1]!).toMatch(/multi-select/);
	const single = harness(new Dialog(false));
	expect(await single.run('--option', '1', '--option', '2')).toBe(1);
	expect(single.err[0]!).toMatch(/single-select/);
	expect([...multi.sent, ...single.sent]).toStrictEqual([]);
});

test('an open free-text row is left before ticking, and digits never go into it', async () => {
	const dialog = new Dialog(true);
	dialog.press('5');
	const h = harness(dialog);
	expect(await h.run('--option', '2', '--option', '4')).toBe(0);
	expect(h.sent.slice(0, 2)).toStrictEqual(['Up', '2']);
	expect([...dialog.checked].sort((a, b) => a - b)).toStrictEqual([2, 4]);
});

test('a free-text row holding text, the free-text row as an option, and multi-line text are refused before any key', async () => {
	const typedIn = new Dialog(false);
	typedIn.press('5');
	typedIn.type('half an answer');
	const typed = harness(typedIn);
	expect(await typed.run('--option', '1')).toBe(1);
	expect(await typed.run('--text', 'fresh')).toBe(1);
	expect(typed.err[0]!).toMatch(/already holds "half an answer"/);

	const single = harness(new Dialog(false));
	expect(await single.run('--option', '5')).toBe(1);
	expect(single.err[0]!).toMatch(/free-text row; answer it with --text/);
	expect(await single.run('--option', '7')).toBe(1);
	expect(single.err[1]!).toMatch(/no option 7/);
	expect(await single.run('--text', 'line one\nline two')).toBe(1);
	expect(single.err[2]!).toMatch(/one line/);
	expect([...typed.sent, ...single.sent]).toStrictEqual([]);
});

test('a single-select option is pressed and checked like the rest', async () => {
	const dialog = new Dialog(false);
	const h = harness(dialog);
	expect(await h.run('--option', '2')).toBe(0);
	expect(h.sent).toStrictEqual(['2']);
	expect(dialog.answered).toBe(true);
	expect(h.logged[0]).toMatchObject({sent: '2. Olives'});
});

test('text left in an unfocused free-text row is still the free-text row, not an option', async () => {
	const dialog = new Dialog(false);
	dialog.press('5');
	dialog.type('abc');
	dialog.press('Up');
	const h = harness(dialog);
	expect(await h.run('--option', '5')).toBe(1);
	expect(await h.run('--option', '1')).toBe(1);
	expect(await h.run('--text', 'fresh')).toBe(1);
	for (const message of h.err) expect(message).toMatch(/already holds "abc"/);
	expect(h.sent).toStrictEqual([]);
});

test('clearing the free-text row with keys counts as taken', async () => {
	const dialog = new Dialog(false);
	dialog.press('5');
	dialog.type('abc');
	const h = harness(dialog);
	expect(await h.run('--keys', 'C-u')).toBe(0);
	expect(dialog.text).toBe('');
});
