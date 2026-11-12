import test from 'ava';
import {runSuperviseCommand, type SuperviseDeps} from './supervise-command.ts';
import type {SuperviseEntry} from './supervise-log.ts';
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
	const logged: SuperviseEntry[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const sent: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: 'agent-repo-STA-1\n'};
		if (args[0] === 'capture-pane') return {status: 0, stdout: dialog.render()};
		return {status: 1, stdout: ''};
	};

	const deps: SuperviseDeps = {
		repo: () => 'repo',
		resolveKey: raw => raw,
		hookKey: async key => key,
		readHook: async () => ({status: 'unknown'}),
		readSnapshot: async () => null,
		runner,
		serverRunner: () => ({status: 1, stdout: ''}),
		now: () => new Date(2026, 10, 9, 12, 0),
		async sleep() {},
		async waitForStatusChange() {},
		send: async () => 'sent',
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
		classify: async () => ({allow: true}),
		policy: {scratchRoots: ['/tmp/q-']},
		store: () => ({root: '/nonexistent', repo: 'repo'}),
		timers: () => ({create() {}, remove() {}}),
		caller: 'STA-9',
		readStdin: () => undefined,
		out: text => out.push(text),
		err: text => err.push(text),
		log(_repo, _caller, entry) {
			logged.push(entry);
		},
	};
	return {
		logged,
		out,
		err,
		sent,
		run: async (...argv: string[]) =>
			runSuperviseCommand(['answer', 'STA-1', ...argv], deps),
	};
}

test('several options on a multi-select are ticked, then confirmed on Submit', async t => {
	const dialog = new Dialog(true);
	const h = harness(dialog);
	t.is(await h.run('--option', '3', '--option', '1'), 0);
	t.deepEqual(h.sent, [
		'1',
		'3',
		'Down',
		'Down',
		'Down',
		'Down',
		'Down',
		'Enter',
	]);
	t.true(dialog.answered);
	t.like(h.logged[0], {
		action: 'answer',
		sent: '1. Cheese, 3. Peppers',
		detail: 'Which toppings do you want?',
	});
});

test('options already ticked are left alone and stray ticks are cleared', async t => {
	const dialog = new Dialog(true);
	dialog.checked = new Set([1, 2]);
	dialog.cursor = 4;
	const h = harness(dialog);
	t.is(await h.run('--option', '1', '--option', '3'), 0);
	t.deepEqual(h.sent, ['2', '3', 'Down', 'Down', 'Enter']);
});

test('a tick the dialog ignores stops the answer before it is confirmed', async t => {
	const dialog = new Dialog(true);
	dialog.deaf.add('3');
	const h = harness(dialog);
	t.is(await h.run('--option', '1', '--option', '3'), 1);
	t.deepEqual(h.sent, ['1', '3']);
	t.false(dialog.answered);
	t.regex(h.err[0]!, /options 1, 3 ticked didn't show/);
	t.regex(h.logged[0]!.detail!, /stuck: options 1, 3 ticked/);
});

test('typed text goes into the free-text row and is submitted once it shows there', async t => {
	const dialog = new Dialog(false);
	const h = harness(dialog);
	t.is(await h.run('--text', 'Enter the dragon'), 0);
	t.deepEqual(h.sent, ['5', 'text:Enter the dragon', 'Enter']);
	t.true(dialog.answered);
	t.like(h.logged[0], {sent: 'Enter the dragon'});
});

test('text the row never shows is not submitted', async t => {
	const dialog = new Dialog(false);
	dialog.type = () => {};
	const h = harness(dialog);
	t.is(await h.run('--text', 'hello'), 1);
	t.deepEqual(h.sent, ['5', 'text:hello']);
	t.false(dialog.answered);
});

test('the answer rules refuse what the question cannot take', async t => {
	const multi = harness(new Dialog(true));
	t.is(await multi.run('--option', '9'), 1);
	t.regex(multi.err[0]!, /no option 9/);
	t.is(await multi.run('--text', 'hi'), 1);
	t.regex(multi.err[1]!, /multi-select/);
	const single = harness(new Dialog(false));
	t.is(await single.run('--option', '1', '--option', '2'), 1);
	t.regex(single.err[0]!, /single-select/);
	t.deepEqual([...multi.sent, ...single.sent], []);
});

test('an open free-text row is left before ticking, and digits never go into it', async t => {
	const dialog = new Dialog(true);
	dialog.press('5');
	const h = harness(dialog);
	t.is(await h.run('--option', '2', '--option', '4'), 0);
	t.deepEqual(h.sent.slice(0, 2), ['Up', '2']);
	t.deepEqual(
		[...dialog.checked].sort((a, b) => a - b),
		[2, 4],
	);
});

test('a free-text row holding text, the free-text row as an option, and multi-line text are refused before any key', async t => {
	const typedIn = new Dialog(false);
	typedIn.press('5');
	typedIn.type('half an answer');
	const typed = harness(typedIn);
	t.is(await typed.run('--option', '1'), 1);
	t.is(await typed.run('--text', 'fresh'), 1);
	t.regex(typed.err[0]!, /already holds "half an answer"/);

	const single = harness(new Dialog(false));
	t.is(await single.run('--option', '5'), 1);
	t.regex(single.err[0]!, /free-text row; answer it with --text/);
	t.is(await single.run('--option', '7'), 1);
	t.regex(single.err[1]!, /no option 7/);
	t.is(await single.run('--text', 'line one\nline two'), 1);
	t.regex(single.err[2]!, /one line/);
	t.deepEqual([...typed.sent, ...single.sent], []);
});

test('a single-select option is pressed and checked like the rest', async t => {
	const dialog = new Dialog(false);
	const h = harness(dialog);
	t.is(await h.run('--option', '2'), 0);
	t.deepEqual(h.sent, ['2']);
	t.true(dialog.answered);
	t.like(h.logged[0], {sent: '2. Olives'});
});

test('text left in an unfocused free-text row is still the free-text row, not an option', async t => {
	const dialog = new Dialog(false);
	dialog.press('5');
	dialog.type('abc');
	dialog.press('Up');
	const h = harness(dialog);
	t.is(await h.run('--option', '5'), 1);
	t.is(await h.run('--option', '1'), 1);
	t.is(await h.run('--text', 'fresh'), 1);
	for (const message of h.err) t.regex(message, /already holds "abc"/);
	t.deepEqual(h.sent, []);
});

test('clearing the free-text row with keys counts as taken', async t => {
	const dialog = new Dialog(false);
	dialog.press('5');
	dialog.type('abc');
	const h = harness(dialog);
	t.is(await h.run('--keys', 'C-u'), 0);
	t.is(dialog.text, '');
});
