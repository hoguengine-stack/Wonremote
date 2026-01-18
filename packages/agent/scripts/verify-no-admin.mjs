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

function rimraf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function scanExtracted(rootDir, forbiddenTokens) {
  const textExt = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.txt']);
  const hits = [];

  const walk = (p) => {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }

      // 경로 자체 검사
      for (const token of forbiddenTokens) {
        if (full.includes(token)) {
          hits.push({ token, where: 'path', file: full });
        }
      }

      const ext = path.extname(full).toLowerCase();
      if (!textExt.has(ext)) continue;
      if (st.size > 2 * 1024 * 1024) continue; // 2MB 이상은 스킵

      let content = '';
      try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      for (const token of forbiddenTokens) {
        if (content.includes(token)) {
          hits.push({ token, where: 'content', file: full });
        }
      }
    }
  };

  walk(rootDir);
  return hits;
}

const asarPath = findAsar();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonremote-agent-verify-'));

try {
  execSync(`npx asar extract "${asarPath}" "${tmpDir}"`, { stdio: 'ignore' });

  // Agent 안에서 발견되면 안 되는 admin 흔적
  // (주의) shared/types에 존재할 수 있는 일반 토큰(예: "ADMIN")은 금지하지 않음
  const forbidden = [
    'AdminDashboard',
    'WonRemote Admin',
    'com.wonremote.admin',
    '/admin'
  ];

  const hits = scanExtracted(tmpDir, forbidden);
  if (hits.length) {
    console.error('[FAIL] agent 패키지에서 admin 흔적 발견');
    for (const h of hits.slice(0, 30)) console.error(`- ${h.token} (${h.where}) :: ${h.file}`);
    if (hits.length > 30) console.error(`... +${hits.length - 30} more`);
    process.exit(1);
  }

  console.log('[OK] agent app.asar 에 admin 흔적 없음');
} finally {
  rimraf(tmpDir);
}
