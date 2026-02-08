import * as esbuild from 'esbuild';

esbuild.build({
    entryPoints: ['src/main.tsx'],
    bundle: true,
    outdir: 'dist/assets',
    entryNames: 'index',
    loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
        '.css': 'css',
        '.woff': 'file',
        '.woff2': 'file'
    },
    minify: true,
    sourcemap: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2020'],
    plugins: [],
}).then(() => console.log('⚡ Build complete! ⚡'))
    .catch(() => process.exit(1));
