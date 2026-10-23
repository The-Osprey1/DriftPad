// Keep the tested device interface identical in development and packaged builds.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'configurator');
const target = path.join(root, 'dist', 'configurator');
fs.mkdirSync(target, { recursive: true });
for (const entry of ['index.html', 'keymap.html', 'css', 'js']) {
  fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}
console.log('Bundled the offline device interface.');
