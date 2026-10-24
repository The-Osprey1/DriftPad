// Builds the GitHub Pages site: the device configurator at the site root, without the Studio.
// pages.yml adds the verified firmware next to it as driftpad.uf2.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'configurator');
const target = path.join(root, 'dist-site');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of ['index.html', 'keymap.html', 'css', 'js']) {
  fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}

// Exact replacements: a changed page fails the build instead of publishing a broken site
function replaceOnce(text, from, to) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one match in configurator/index.html, found ${count}:\n${from}`);
  return text.replace(from, to);
}
const indexPath = path.join(target, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = replaceOnce(html,
  '<a id="studioLink" class="btn" href="../index.html">Back to Studio</a>',
  '<a id="firmwareLink" class="btn" href="driftpad.uf2" download="DriftPad.uf2">Download firmware</a>');
html = replaceOnce(html,
  '<p class="conn-detail muted">Configure your physical pad here. Studio profiles and previews stay on this computer; they are not automatically written to the pad.</p>',
  '<p class="conn-detail muted">Updating a pad that already runs DriftPad: connect it and use <strong>Device → Firmware update</strong>, no need to open the case. A new pad: click <strong>Download firmware</strong>, hold BOOTSEL on the Pico while plugging it in, and copy DriftPad.uf2 onto the RPI-RP2 drive. The pad restarts by itself; then click <strong>Connect DriftPad</strong>.</p>');
fs.writeFileSync(indexPath, html);
console.log(`Built the configurator site in ${path.relative(root, target)}/`);
