import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AdaptiveCapture } from "./adaptiveCapture";
import { writeCaptureControl } from "./captureControl";
import { getAdaptiveStreamPerformanceProfile } from "../domain/streamPerformanceMode";

const pressure = {backpressured:false,bufferedAmount:0,droppedFrames:0};
describe("adaptive capture work feedback", () => {
  it("writes bounded profiles to capture stdin and gradually recovers from slow work", () => {
    const controller = new AdaptiveCapture();
    const input = new PassThrough();
    const commands: string[]=[];
    input.on("data",data=>commands.push(data.toString()));
    let current = getAdaptiveStreamPerformanceProfile(pressure);
    const apply = (profile: typeof current) => {
      current=profile;
      expect(writeCaptureControl(input,`set-stream-profile ${profile.loopSleepMs} ${profile.jpegQuality} ${profile.maxMergeWidth}\n`,()=>{})).toBe(true);
    };
    expect(commands).toEqual([]);
    controller.observe(70);
    controller.update(0,pressure,current,apply);
    expect(commands).toEqual(["set-stream-profile 140 76 384\n"]);
    for(let now=1;now<2000;now++) controller.update(now,pressure,current,apply);
    expect(commands).toHaveLength(1);
    controller.observe(5);
    controller.update(2000,pressure,current,apply);
    expect(current.loopSleepMs).toBe(112);
    controller.observe(60_000);
    controller.update(4000,pressure,current,apply);
    expect(current.loopSleepMs).toBe(250);
    input.destroy();
  });
  it("ignores malformed legacy samples, updates quality even at unchanged interval and resets", () => {
    const controller = new AdaptiveCapture();
    const profiles: number[]=[];
    const current = {...getAdaptiveStreamPerformanceProfile(pressure),jpegQuality:60};
    for(const value of [undefined,"70",NaN,Infinity,-1,60_001]) controller.observe(value);
    controller.update(0,pressure,current,p=>profiles.push(p.jpegQuality));
    expect(profiles).toEqual([76]);
    controller.observe(100);
    controller.update(2000,pressure,current,p=>expect(p.loopSleepMs).toBe(200));
    new AdaptiveCapture().update(0,pressure,current,p=>expect(p.loopSleepMs).toBe(20));
  });
  it("bounds 24h continuous pressure without timers or repeated identical writes", () => {
    const controller = new AdaptiveCapture();
    let current=getAdaptiveStreamPerformanceProfile(pressure), writes=0;
    for(let now=0;now<86_400_000;now+=100) {
      controller.observe(40);
      controller.update(now,pressure,current,p=>{current=p;writes++;});
    }
    expect(writes).toBe(1);
  });
});
