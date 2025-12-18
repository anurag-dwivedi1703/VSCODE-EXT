import * as esbuild from 'esbuild';

esbuild.build({
    entryPoints: ['src/main.tsx'],
    bundle: true,
    outfile: 'dist/assets/index.js',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    minify: true,
    sourcemap: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2020'],
    plugins: [],
}).then(() => console.log('⚡ Build complete! ⚡'))
    .catch(() => process.exit(1));
