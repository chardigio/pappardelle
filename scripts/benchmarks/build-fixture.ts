import {nativeCompileOptions} from '../build-native.ts';
import path from 'node:path';
import {unlink} from 'node:fs/promises';

// Compile the real row component and its renderer together so React remains a
// singleton. Importing a prebundled row into another React runtime is invalid.
const [mode = 'bundle', destination] = process.argv.slice(2);
if (!destination) throw new Error('Usage: build-fixture.ts <mode> <output>');
const project = path.resolve(import.meta.dirname, '../..');
const entry = path.join(project, '.pappardelle-fixture-source.mjs');
if (await Bun.file(entry).exists()) throw new Error(`${entry} already exists`);
const template = await Bun.file(
	path.join(import.meta.dirname, 'tui-fixture.mjs'),
).text();
const source = template
	.replace(
		"'./dist/components/SpaceListItem.js'",
		"'./source/components/SpaceListItem.tsx'",
	)
	.replace(
		"const native = process.env.BENCH_FRAMEWORK === 'opentui';",
		'const native = true;',
	)
	.replace(
		"native ? await import('@opentui/core') : null",
		"await import('@opentui/core')",
	)
	.replace(
		"await import(native ? '@opentui/react' : 'ink')",
		"await import('@opentui/react')",
	);
try {
	await Bun.write(entry, source);
	const compiled = mode === 'standalone' || mode === 'bytecode';
	const result = await Bun.build({
		entrypoints: [entry],
		target: 'bun',
		format: 'esm',
		...(compiled
			? {compile: nativeCompileOptions(destination)}
			: {
					outdir: path.dirname(destination),
					naming: path.basename(destination),
				}),
		bytecode: mode === 'bytecode',
		external: compiled
			? []
			: mode === 'full-bundle'
				? ['@opentui/core-*']
				: ['@opentui/core'],
		define: {
			PAPPARDELLE_COMPILED: JSON.stringify(compiled),
			'process.env.NODE_ENV': JSON.stringify('production'),
			...(process.platform === 'linux'
				? {'process.env.OPENTUI_LIBC': JSON.stringify('glibc')}
				: {}),
		},
		minify: {syntax: true, whitespace: true, identifiers: false},
	});
	if (!result.success)
		throw new AggregateError(result.logs, 'Fixture build failed');
} finally {
	await unlink(entry);
}
