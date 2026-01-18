import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const excludeModules = [
  'tkinter',
  'PIL',
  'pyscreeze',
  'mouseinfo',
  'numpy',
  'pymsgbox',
  'pytweening'
];

const baseArgs = [
  '-m',
  'PyInstaller',
  '--noconsole',
  '--onedir',
  'control.py',
  '--name',
  'control',
  '--distpath',
  'resources',
  '--workpath',
  'build/control',
  '--clean',
  '--strip',
  '--noconfirm',
  '--hidden-import',
  'pyautogui',
  '--collect-all',
  'pyautogui',
  ...excludeModules.flatMap((m) => ['--exclude-module', m])
];

const upxDirFromEnv = process.env.UPX_DIR;
let upxDir = upxDirFromEnv && fs.existsSync(upxDirFromEnv) ? upxDirFromEnv : '';

if (!upxDir) {
  const where = spawnSync('where', ['upx'], { encoding: 'utf8' });
  if (where.status === 0) {
    const first = where.stdout.split(/\r?\n/).find(Boolean);
    if (first) upxDir = path.dirname(first.trim());
  }
}

const args = upxDir ? baseArgs.concat(['--upx-dir', upxDir]) : baseArgs;
const result = spawnSync('python', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
