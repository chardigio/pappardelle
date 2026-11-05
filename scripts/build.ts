import {buildNative} from './build-native.ts';
import {Glob} from 'bun';
import {mkdir, rm, chmod} from 'node:fs/promises';

// Keep entry points and shared chunks directly under dist where application
// helpers resolve scripts/, package.json and the status-monitor entry point.
const outdir =
	process.argv
		.find(arg => arg.startsWith('--outdir='))
		?.slice('--outdir='.length) ?? 'dist';
await rm(outdir, {recursive: true, force: true});
await mkdir(outdir, {recursive: true});
const files = [...new Glob('**/*.{ts,tsx}').scanSync('source')].filter(
	file =>
		!file.endsWith('.test.ts') &&
		!file.endsWith('.test.tsx') &&
		!file.endsWith('.d.ts'),
);
if (!process.argv.includes('--modules')) {
	const result = await Bun.build({
		entrypoints: files.map(file => `source/${file}`),
		root: 'source',
		outdir,
		target: 'bun',
		splitting: true,
		// Keep OpenTUI's platform/worker asset resolution inside its installed package.
		external: process.argv.includes('--full-bundle')
			? ['@opentui/core-*']
			: ['@opentui/core'],
		define: {'process.env.NODE_ENV': JSON.stringify('production')},
		minify: {syntax: true, whitespace: true, identifiers: false},
		sourcemap: 'linked',
	});
	if (!result.success)
		throw new AggregateError(result.logs, 'Bun build failed');
	await chmod(`${outdir}/cli.js`, 0o755);
} else {
	// Unbundled output is retained only for the reproducible packaging comparison.
	const transpiler = new Bun.Transpiler({
		loader: 'tsx',
		target: 'bun',
		autoImportJSX: true,
		tsconfig: await Bun.file('tsconfig.json').text(),
	});
	for (const file of files) {
		const source = await Bun.file(`source/${file}`).text();
		const output = transpiler
			.transformSync(source)
			.replace(
				/(from\s*|import\s*\()(['"])(\.[^'"\n]+)\.tsx?\2/g,
				'$1$2$3.js$2',
			);
		const destination = `${outdir}/${file.replace(/\.tsx?$/, '.js')}`;
		const shebang = source.startsWith('#!')
			? source.slice(0, source.indexOf('\n') + 1)
			: '';
		await Bun.write(destination, shebang + output);
		if (shebang) await chmod(destination, 0o755);
	}
}

if (
	!process.argv.some(arg =>
		['--modules', '--bundle-only', '--full-bundle'].includes(arg),
	)
) {
	await buildNative(`${outdir}/pappardelle`);
}
