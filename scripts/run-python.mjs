import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error('A project Python script is required');
const local = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const choices = existsSync(local) ? [[local]] : [
  ...(process.env.TONGPIN_PYTHON ? [[process.env.TONGPIN_PYTHON]] : []),
  ...(process.platform === 'win32' ? [['py', '-3.12']] : []), ['python3'], ['python'],
];
const choice = choices.find(([command, ...prefix]) => spawnSync(command, [...prefix, '-c', 'import sys; assert sys.version_info >= (3, 11)'], { stdio: 'ignore', windowsHide: true }).status === 0);
if (!choice) {
  process.stderr.write('No usable Python interpreter. Install Python 3.12 or set TONGPIN_PYTHON.\n');
  process.exit(1);
}
const [command, ...prefix] = choice;
const result = spawnSync(command, [...prefix, resolve(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
