/* eslint-disable no-bitwise */
import test from 'ava';
import {ImageIds} from './pane-frame-image-ids.ts';

const ESC = '\u001B';
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const idOf = (command: string) => Number(/i=(\d+)/.exec(command)![1]);
const cells = (red: number, green: number, blue: number) =>
	bytes(`${ESC}[38;2;${red};${green};${blue}m\u{10EEEE}\u{10EEEE}${ESC}[39m`);

// Program image 0x7b_00_01_02, whose cells carry 1;2 in green and blue.
const programId = 0x7b_00_01_02;
const upload = `${ESC}_Ga=T,i=${programId},f=100,m=1,U=1,c=4,r=2;AAAA${ESC}\\`;

test('an upload shown by the cells after it goes to a fresh ID with the same high byte', t => {
	const ids = new ImageIds(0x10);
	const [command] = ids.translate(upload, [cells(0, 1, 2)]);
	const id = idOf(command!);
	t.not(id, programId);
	t.is(id >>> 24, 0x7b);
	t.is(command, upload.replace(`i=${programId}`, `i=${id}`));
	t.is(
		text(ids.rewriteCells(cells(0, 1, 2))),
		text(cells((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff)),
	);
});

test('an image re-uploaded with its cells cycles through four IDs', t => {
	const ids = new ImageIds(0x10);
	const used = Array.from({length: 6}, () =>
		idOf(ids.translate(upload, [cells(0, 1, 2)])[0]!),
	);
	t.is(new Set(used.slice(0, 4)).size, 4);
	t.deepEqual(used.slice(4), used.slice(0, 2));
});

test('an upload with no cells after it replaces the image its cells already show', t => {
	const ids = new ImageIds(0x10);
	const shown = idOf(ids.translate(upload, [cells(0, 1, 2)])[0]!);
	t.is(idOf(ids.translate(upload, [])[0]!), shown);
	t.is(idOf(ids.translate(upload, [bytes('other text')])[0]!), shown);
});

test('commands about an image name the ID it was last given', t => {
	const ids = new ImageIds(0x10);
	const shown = idOf(ids.translate(upload, [cells(0, 1, 2)])[0]!);
	const frameEdit = `${ESC}_Ga=f,r=1,i=${programId},x=0,y=0,s=1,v=1;AAAA${ESC}\\`;
	t.is(idOf(ids.translate(frameEdit, [])[0]!), shown);
	t.is(ids.programId(shown), programId);
});

test('deleting an image deletes every ID it was given', t => {
	const ids = new ImageIds(0x10);
	const given = [0, 1].map(() =>
		idOf(ids.translate(upload, [cells(0, 1, 2)])[0]!),
	);
	const deletes = ids.translate(
		`${ESC}_Ga=d,d=I,i=${programId},q=2${ESC}\\`,
		[],
	);
	t.deepEqual(
		deletes.map(command => idOf(command)),
		given,
	);
	t.is(text(ids.rewriteCells(cells(0, 1, 2))), text(cells(0, 1, 2)));
});

test('images a program never shows with cells keep their IDs', t => {
	const ids = new ImageIds(0x10);
	const query = `${ESC}_Ga=q,i=65537,s=1,v=1,f=24;AAAA${ESC}\\`;
	t.deepEqual(ids.translate(query, []), [query]);
	const chunk = `${ESC}_Gm=0;AAAA${ESC}\\`;
	t.deepEqual(ids.translate(chunk, [cells(0, 1, 2)]), [chunk]);
});

test('a color split across writes, or among other attributes, is still rewritten', t => {
	const ids = new ImageIds(0x10);
	const id = idOf(ids.translate(upload, [cells(0, 1, 2)])[0]!);
	const color = `${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}`;
	const first = ids.rewriteCells(bytes(`a${ESC}[1;38;2;0;`));
	const second = ids.rewriteCells(bytes(`1;2;48;2;0;1;2mb`));
	t.is(text(first) + text(second), `a${ESC}[1;38;2;${color};48;2;0;1;2mb`);
	t.is(
		text(ids.rewriteCells(bytes(`${ESC}[38:2::0:1:2m`))),
		`${ESC}[38:2::${color.replaceAll(';', ':')}m`,
	);
});
