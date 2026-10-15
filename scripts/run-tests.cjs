const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function findTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'renderer', 'assets'].includes(entry.name) ? [] : findTests(fullPath);
    }
    return /\.test\.(ts|cjs)$/.test(entry.name) ? [fullPath] : [];
  });
}
const tests = [...findTests(path.join(root, 'src')), ...findTests(path.join(root, 'desktop'))];
if (!tests.length) throw new Error('No tests found.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
