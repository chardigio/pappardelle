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
		sourcemap: 'linked',
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
	// No explicit target: the executable embeds the runtime that is building
	// it. Bytecode only loads in the exact Bun build that produced it, so a
	// baseline runtime under bytecode from a non-baseline Bun silently falls
	// back to parsing every module, about 60 ms per launch.
	return {
		outfile,
		autoloadDotenv: false,
		autoloadBunfig: false,
		autoloadTsconfig: false,
		autoloadPackageJson: false,
	};
}
