import test from 'ava';
import {toHerdrRatio} from './layout.ts';

// herdr's `pane split --ratio X` keeps X of the space in the pane being split
// and gives the new pane the rest. Pappardelle's layout maths speaks in the
// new pane's share, so the conversion flips it.
test('toHerdrRatio flips a new pane share into the target share', t => {
	t.is(toHerdrRatio(0.3), 0.7);
	t.is(toHerdrRatio(0.7), 0.3);
	t.is(toHerdrRatio(0.5), 0.5);
});

test('toHerdrRatio clamps so neither pane collapses', t => {
	t.false(toHerdrRatio(0) === 1);
	t.true(toHerdrRatio(0) >= 0.05);
	t.true(toHerdrRatio(1) <= 0.95);
	t.true(toHerdrRatio(-5) <= 1);
	t.true(toHerdrRatio(5) >= 0);
});

// The real case this exists for: a 120-column tab with a 36-column rail.
test('toHerdrRatio leaves the rail its own share of the tab', t => {
	// The agent band is 84 of 120 columns, so the rail keeps 0.3.
	t.is(toHerdrRatio(84 / 120), 0.3);
});
