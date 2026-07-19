import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['app.js'],        // ← change if your entry is different
  bundle: true,
  outfile: 'build/app.bundle.js',
  format: 'iife',                         // safe for <script> tag
  platform: 'browser',
  sourcemap: true,
  minify: true,
  logLevel: 'info',

});
