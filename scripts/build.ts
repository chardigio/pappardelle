import {buildNative} from './build-native.ts';
import {Glob} from 'bun';
import {mkdir, rm, rename} from 'node:fs/promises';

// Local installs run straight from dist, so a failed build must leave the
// previous one in place.
const outdir = 'dist.next';
await rm(outdir, {recursive: true, force: true});
await mkdir(outdir, {recursive: true});
await buildNative(`${outdir}/pappardelle`);

// Bun's compile leaves its intermediate executable in the working directory.
for (const leftover of new Glob('.*.bun-build').scanSync({dot: true})) {
	await rm(leftover, {force: true});
}

await rm('dist', {recursive: true, force: true});
await rename(outdir, 'dist');
