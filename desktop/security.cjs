const path = require('node:path');
const APP_URL = 'driftpad://app/';
function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'driftpad:' && url.host === 'app' && !url.username && !url.password;
  } catch { return false; }
}
function resolveAsset(root, value) {
  if (!isAppUrl(value)) return null;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    if (/[\\:\0]/.test(pathname) || pathname.split('/').includes('..')) return null;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return file;
  } catch { return null; }
}
function isProjectLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      !url.port && !url.username && !url.password &&
      (url.pathname === '/The-Osprey1/DriftPad' || url.pathname.startsWith('/The-Osprey1/DriftPad/'));
  } catch { return false; }
}
module.exports = { APP_URL, isAppUrl, resolveAsset, isProjectLink };
