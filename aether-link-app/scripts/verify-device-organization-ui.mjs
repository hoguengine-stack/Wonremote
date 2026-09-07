import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const make = (id, storeName, businessNumber) => ({id, deviceNumber:id, storeName, businessNumber, deviceName:'Android', desktopName:'CTD-7000 CTD-7000',status:'offline',lastSeenAt:''});
  const devices = [make('POS','Store A','123-45-67890'),make('TABLET','상호명 미설정','123-45-67890'),make('MOVE','상호명 미설정','555-55-55555')];
  const patches = [];
  let updateRequests = 0;
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/src/firebase/firebaseConfig.ts') return route.fulfill({contentType:'text/javascript',body:'export const resolveFirebaseConfig=()=>null; export const isFirebaseConfigured=()=>false;'});
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname.endsWith('/request-update')) updateRequests++;
      if (url.pathname === '/api/devices') body = {devices};
      else if (req.method()==='PATCH' && url.pathname.startsWith('/api/devices/')) {
        const device = devices.find(d=>d.id===decodeURIComponent(url.pathname.split('/').pop()));
        const patch = req.postDataJSON();
        patches.push(patch);
        Object.assign(device,patch);
        body={device};
      } else if (url.pathname.includes('history')) body={history:[]};
      return route.fulfill({json:body});
    }
    if (!['127.0.0.1','localhost'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.goto(process.env.VIEWER_TEST_URL || 'http://127.0.0.1:5175/');
  await page.locator('[name=username]').fill('test');
  await page.locator('[name=password]').fill('test');
  await page.getByRole('button',{name:'로그인',exact:true}).click();
  const tablet = page.locator('.table-row').filter({hasText:'TABLET'});
  await tablet.waitFor();
  assert.match(await tablet.innerText(),/Store A/);
  assert.ok(!(await tablet.innerText()).includes('CTD-7000 CTD-7000'));
  await tablet.getByRole('button',{name:'장비 정보 수정'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('장비 종류').selectOption('태블릿');
  await dialog.getByLabel('데스크탑명').fill('Table 1');
  await dialog.getByRole('button',{name:'저장',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert.match(await tablet.innerText(),/Table 1/);
  await page.locator('.table-row').filter({hasText:'MOVE'}).dragTo(page.locator('.group-button').filter({hasText:'Store A'}));
  await page.waitForFunction(()=>[...document.querySelectorAll('.table-row')].some(r=>r.textContent.includes('MOVE')&&r.textContent.includes('Store A')));
  assert.deepEqual(patches.at(-1),{storeName:'Store A'});
  assert.equal(devices[2].businessNumber,'555-55-55555');
  await tablet.getByRole('button',{name:'에이전트 업데이트 요청'}).click();
  await tablet.getByRole('button',{name:'에이전트 업데이트 요청'}).click();
  assert.equal(updateRequests,1);
  console.log('PASS: tablet preset, editable name, duplicate suppression, automatic grouping, persisted drag payload; no production traffic');
} finally { await browser.close(); }
