/**
 * Motion is computed from a clock value rather than kept in component state,
 * so the exporter can render any instant of a scene and get the same frame
 * the live preview shows at that instant.
 */

export const clamp = (value: number, low = 0, high = 1) =>
	Math.min(high, Math.max(low, value));

export const ease = {
	linear: (t: number) => t,
	outCubic: (t: number) => 1 - (1 - t) ** 3,
	inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
	outBack(t: number) {
		const c1 = 1.70158;
		const c3 = c1 + 1;
		return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
	},
};

/** Progress 0..1 of a transition that started at `start` and lasts `duration`. */
export function progressOf(now: number, start: number, duration: number) {
	if (now < start) return 0;
	return clamp((now - start) / duration);
}

/** True while a transition that started at `start` is still running. */
export const isRunning = (now: number, start: number, duration: number) =>
	now >= start && now < start + duration;

/** A 0..1..0 wave with the given period. */
export function pulse(now: number, period: number, phase = 0) {
	return (1 - Math.cos(((now + phase) / period) * Math.PI * 2)) / 2;
}

/** Steps through glyphs at a fixed interval, all rows in lockstep. */
export function cycle<T>(items: readonly T[], now: number, interval: number) {
	return items[Math.floor(Math.max(0, now) / interval) % items.length]!;
}

/** Column of the leading edge of a sweep crossing `width` cells. */
export function sweepColumn(
	now: number,
	start: number,
	duration: number,
	width: number,
) {
	const t = progressOf(now, start, duration);
	return Math.round(ease.inOutSine(t) * (width + 6)) - 3;
}

/** Eighth-block bar: sub-cell precision for progress at any width. */
export function eighthBar(fraction: number, cells: number) {
	const eighths = Math.round(clamp(fraction) * cells * 8);
	const full = Math.floor(eighths / 8);
	const partial = eighths % 8;
	const glyphs = ' ▏▎▍▌▋▊▉';
	return (
		'█'.repeat(full) +
		(partial ? glyphs[partial] : '') +
		' '.repeat(Math.max(0, cells - full - (partial ? 1 : 0)))
	);
}

const SPARK = '▁▂▃▄▅▆▇█';

export function sparkline(samples: number[]) {
	return samples
		.map(sample => SPARK[Math.round(clamp(sample) * (SPARK.length - 1))])
		.join('');
}
