const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2]);
const label = process.argv[3] || 'packaged';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'driftpad-smoke-'));
const output = path.resolve('release');
fs.mkdirSync(output, { recursive: true });
for (const pass of ['first', 'second']) {
  const resultPath = path.join(output, 'smoke-' + label + '-' + pass + '.json');
  fs.rmSync(resultPath, { force: true });
  const result = spawnSync(executable, ['--smoke-test'], {
    env: { ...process.env, DRIFTPAD_SMOKE_DATA: data, DRIFTPAD_SMOKE_RESULT: resultPath },
    stdio: 'inherit', timeout: 90000, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Packaged app failed to start.');
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(report.previous, pass === 'first' ? null : 'saved', 'Settings did not survive restart.');
  console.log(pass + ' launch: ' + JSON.stringify(report));
}
