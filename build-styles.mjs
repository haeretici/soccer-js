import * as sass from 'sass';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const input = path.join(root, 'scss', 'main.scss');
const output = path.join(root, 'build', 'app.css');

fs.mkdirSync(path.dirname(output), { recursive: true });

const result = sass.compile(input, {
  style: 'compressed',
  sourceMap: true,
  loadPaths: [path.join(root, 'scss')]
});

let css = result.css;
if (result.sourceMap) {
  const mapJson = JSON.stringify(result.sourceMap);
  const base64 = Buffer.from(mapJson).toString('base64');
  css += `\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64} */`;
}

fs.writeFileSync(output, css);
console.log(`  build/app.css         ${(css.length / 1024).toFixed(1)}kb`);
