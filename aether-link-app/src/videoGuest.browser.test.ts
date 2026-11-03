import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";

let server:ViteDevServer,browser:Browser,origin:string;
beforeAll(async()=>{
  server=await createServer({server:{host:"127.0.0.1",port:0},logLevel:"error"});await server.listen();
  const address=server.httpServer!.address();if(!address||typeof address==="string")throw Error("Missing local fixture server");
  origin=`http://127.0.0.1:${address.port}`;browser=await chromium.launch({headless:true});
},30_000);
afterAll(async()=>{await browser?.close();await server?.close();});

it("opens the isolated customer page with no Viewer install metadata, App or Firebase auth requests",async()=>{
  const page=await browser.newPage({viewport:{width:390,height:844},userAgent:"Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 SamsungBrowser/27.0"});
  const requests:string[]=[];page.on("request",request=>requests.push(request.url()));
  await page.route("https://**",route=>route.abort());
  await page.goto(`${origin}/video-support.html#room=11111111-1111-4111-8111-111111111111&token=${"t".repeat(43)}`);
  await page.getByRole("button",{name:"카메라 허용하고 시작",exact:true}).waitFor();
  expect(await page.title()).toBe("WonRemote 영상상담");
  expect(await page.locator('link[rel="manifest"],meta[name="apple-mobile-web-app-capable"]').count()).toBe(0);
  expect(requests.some(url=>/\/src\/App\.tsx|firebaseServices|firebase_auth|firebase_firestore|manifest\.webmanifest|viewer-sw\.js/.test(url))).toBe(false);
  expect(await page.evaluate(()=>{const event=new Event("beforeinstallprompt",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
  const hosting=JSON.parse(readFileSync("../firebase.json","utf8")).hosting;
  expect(hosting.rewrites.slice(0,2)).toEqual([{source:"/video-support",destination:"/video-support.html"},{source:"/video-support/",destination:"/video-support.html"}]);
  expect(hosting.headers.find((rule:{source:string})=>rule.source==="/video-support**").headers).toContainEqual({key:"Permissions-Policy",value:"camera=(self), microphone=()"});
  await page.screenshot({path:"../.codex-tmp/video-sms/isolated-guest.png"});await page.close();
},30_000);
