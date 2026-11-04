import path from 'node:path';

export async function buildNative(destination: string, bytecode = true) {
	const project = path.resolve(import.meta.dirname, '..');
	const {platform} = process;
	const result = await Bun.build({
		entrypoints: [path.join(project, 'source/standalone.ts')],
		target: 'bun',
		format: 'esm',
		compile: nativeCompileOptions(destination),
		bytecode,
		minify: {syntax: true, whitespace: true, identifiers: false},
		define: {
			PAPPARDELLE_COMPILED: 'true',
			'process.env.NODE_ENV': JSON.stringify('production'),
			...(platform === 'linux'
				? {'process.env.OPENTUI_LIBC': JSON.stringify('glibc')}
				: {}),
		},
	});
	if (!result.success)
		throw new AggregateError(result.logs, 'Native build failed');
}

export function nativeCompileOptions(outfile: string): Bun.CompileBuildOptions {
	const {platform} = process;
	if (platform !== 'linux' && platform !== 'darwin')
		throw new Error(`Unsupported platform: ${platform}`);
	const target: Bun.Build.CompileTarget =
		process.arch === 'x64'
			? `bun-${platform}-x64-baseline`
			: `bun-${platform}-arm64`;

	return {
		outfile,
		target,
		autoloadDotenv: false,
		autoloadBunfig: false,
		autoloadTsconfig: false,
		autoloadPackageJson: false,
	};
}
