import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findAsar() {
  const base = path.resolve('release');
  if (!fs.existsSync(base)) throw new Error('release 폴더가 없음. 먼저 dist 하세요.');

  const hits = [];
  const walk = (p) => {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name === 'app.asar') hits.push(full);
    }
  };
  walk(base);
  if (!hits.length) throw new Error('app.asar 를 찾지 못함.');
  return hits[0];
}

function listAllFiles(root) {
  const out = [];
  const walk = (p) => {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

const asarPath = findAsar();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonremote-admin-verify-'));
const extractedDir = path.join(tmpDir, 'asar');
fs.mkdirSync(extractedDir, { recursive: true });

function rimraf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

try {
  execSync(`npx asar extract "${asarPath}" "${extractedDir}"`, { stdio: 'ignore' });

  const forbidden = [
    // 파일/컴포넌트 흔적
    'UserPortal',
    'WonRemote Agent',
    'com.wonremote.agent',

    // 자산(Agent 전용)
    'control.exe',
    'control.py'
  ];

  const files = listAllFiles(extractedDir);
  const hits = new Set();

  for (const file of files) {
    const rel = path.relative(extractedDir, file).replaceAll('\\', '/');

    // 경로에 포함
    for (const k of forbidden) {
      if (rel.includes(k)) hits.add(`path:${k}`);
    }

    // 텍스트 파일만 내용 검사(2MB 제한)
    const ext = path.extname(file).toLowerCase();
    const isText = ['.js', '.cjs', '.mjs', '.html', '.css', '.json', '.txt', '.svg'].includes(ext);
    if (!isText) continue;

    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const k of forbidden) {
      if (content.includes(k)) hits.add(`content:${k}`);
    }
  }

  if (hits.size) {
    console.error('[FAIL] admin 패키지에 agent 흔적 발견:', Array.from(hits));
    process.exit(1);
  }

  console.log('[OK] admin app.asar 에 agent 흔적 없음');
} finally {
  rimraf(tmpDir);
}