// Copies the browser bundles MarkFlow loads from CDNs into media/vendor/, so the
// webview can reference them through asWebviewUri (webviews cannot reach a CDN).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'media', 'vendor');
const from = (...p) => join(root, 'node_modules', ...p);

const files = [
  [from('marked', 'marked.min.js'), 'marked.min.js'],
  [from('dompurify', 'dist', 'purify.min.js'), 'purify.min.js'],
  [from('mermaid', 'dist', 'mermaid.min.js'), 'mermaid.min.js'],
  [from('@highlightjs', 'cdn-assets', 'highlight.min.js'), 'highlight.min.js'],
  [from('@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'), 'github-dark.min.css'],
  [from('@highlightjs', 'cdn-assets', 'styles', 'github.min.css'), 'github.min.css'],
];

// Latin subsets only; reader.css declares a system fallback for each family.
const fonts = [
  ['inter', ['inter-latin-400-normal', 'inter-latin-500-normal', 'inter-latin-600-normal', 'inter-latin-700-normal']],
  ['lora', ['lora-latin-400-normal', 'lora-latin-400-italic', 'lora-latin-600-normal']],
  ['jetbrains-mono', ['jetbrains-mono-latin-400-normal', 'jetbrains-mono-latin-500-normal']],
];
for (const [pkg, names] of fonts) {
  for (const n of names) files.push([from('@fontsource', pkg, 'files', `${n}.woff2`), join('fonts', `${n}.woff2`)]);
}

rmSync(dest, { recursive: true, force: true });
for (const [src, rel] of files) {
  const out = join(dest, rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(src, out);
}
console.log(`vendored ${files.length} files into media/vendor`);
