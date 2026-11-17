import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web');
const output = path.join(root, 'data', 'temp', 'github-pages');
mkdirSync(output, { recursive: true });
// Only public UI assets enter the deployment artifact. No audio, database or model weights.
for (const name of ['app.js', 'hosting.js', 'mixer-state.js', 'styles.css']) {
  copyFileSync(path.join(source, name), path.join(output, name));
}
const html = readFileSync(path.join(source, 'index.html'), 'utf8')
  .replace('<head>', '<head>\n    <meta name="aims-hosting" content="github-pages" />')
  .replace('Separación musical local mediante modelos reales de inteligencia artificial.', 'Splitter: interfaz web de separación musical. Motor de IA pendiente de conectar.');
writeFileSync(path.join(output, 'index.html'), html);
writeFileSync(path.join(output, '.nojekyll'), '');
console.log('GitHub Pages: data/temp/github-pages');
