import {Glob} from 'bun';
import {mkdir, rm, chmod} from 'node:fs/promises';

// Preserve module boundaries: helpers resolve scripts/ and package.json relative
// to their module, and the program-status monitor is a separate entry point.
await rm('dist', {recursive: true, force: true});
await mkdir('dist', {recursive: true});
const transpiler = new Bun.Transpiler({
	loader: 'tsx',
	target: 'bun',
	autoImportJSX: true,
	tsconfig: await Bun.file('tsconfig.json').text(),
});
for await (const file of new Glob('**/*.{ts,tsx}').scan('source')) {
	if (
		file.endsWith('.test.ts') ||
		file.endsWith('.test.tsx') ||
		file.endsWith('.d.ts')
	)
		continue;
	const source = await Bun.file(`source/${file}`).text();
	const output = transpiler
		.transformSync(source)
		.replace(/(from\s*|import\s*\()(['"])(\.[^'"\n]+)\.tsx?\2/g, '$1$2$3.js$2');
	const destination = `dist/${file.replace(/\.tsx?$/, '.js')}`;
	const shebang = source.startsWith('#!')
		? source.slice(0, source.indexOf('\n') + 1)
		: '';
	await Bun.write(destination, shebang + output);
	if (shebang) await chmod(destination, 0o755);
}
