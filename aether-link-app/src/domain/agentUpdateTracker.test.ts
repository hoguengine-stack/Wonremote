import {afterEach,describe,expect,it,vi} from "vitest";
import {trackAgentUpdate} from "./agentUpdateTracker";
import type {ManagedDevice} from "./types";

const device={id:"one",version:"0.1.115",updateState:"healthy",updateRequestId:"1700000000000"} as ManagedDevice;
function fixture(syncError=false){
  let next!:(device:ManagedDevice)=>void,fail!:(error:Error)=>void;
  const stop=vi.fn(),send=vi.fn(async()=>{}),report=vi.fn(),onDevice=vi.fn();
  const cancel=trackAgentUpdate({device,requestId:"1700000000001",send,report,onDevice,watch:(n,f)=>{next=n;fail=f;if(syncError)f(new Error("Permission denied"));return stop;}});
  return {next:(patch:Partial<ManagedDevice>)=>next({...device,...patch}),fail,stop,send,report,onDevice,cancel};
}
afterEach(()=>vi.useRealTimers());
describe("explicit Agent update result",()=>{
  it("ignores stale success and follows matching progress through new-version restart, then stays idle",async()=>{
    vi.useFakeTimers();const f=fixture();await Promise.resolve();
    f.next({});expect(f.report).toHaveBeenLastCalledWith({message:"Agent 응답 대기 중",active:true});
    f.next({updateRequestId:"1700000000001",updateState:"downloading",updateProgress:25,updateTargetVersion:"0.1.116"});
    expect(f.report).toHaveBeenLastCalledWith({message:"다운로드 중 25%",active:true});
    f.next({updateRequestId:undefined,updateState:"healthy",version:"0.1.116"});
    expect(f.report).toHaveBeenLastCalledWith({message:"업데이트 완료 v0.1.116 · Agent 재실행 확인",active:false,failed:false});
    expect(f.stop).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(86_400_000);expect(f.send).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it("distinguishes current version, session deferral, policy wait, failure and restored old version",async()=>{
    vi.useFakeTimers();const current=fixture();await Promise.resolve();current.next({updateRequestId:"1700000000001"});
    expect(current.report.mock.lastCall?.[0].message).toContain("최신 버전입니다");
    const f=fixture();await Promise.resolve();f.next({updateRequestId:"1700000000001",updateState:"idle",updateError:"원격 세션 종료 후 업데이트 대기"});
    expect(f.report.mock.lastCall?.[0]).toEqual({message:"원격 세션 종료 후 업데이트 대기",active:true});
    f.next({updateRequestId:"1700000000001",updateState:"idle",updateTargetVersion:"0.1.116",updateError:undefined});
    expect(f.report.mock.lastCall?.[0].message).toContain("배포 정책");
    f.next({updateRequestId:"1700000000001",updateState:"rollback",updateError:"서명 검증 실패 · 복구됨"});
    expect(f.report.mock.lastCall?.[0]).toMatchObject({message:"서명 검증 실패 · 복구됨",failed:true,active:false});expect(f.stop).toHaveBeenCalledOnce();
  });
  it("bounds missing acknowledgments and long updates without retrying, and ignores cancellation/other devices",async()=>{
    vi.useFakeTimers();const f=fixture();await Promise.resolve();f.next({id:"other",version:"0.1.116"});
    await vi.advanceTimersByTimeAsync(30_000);expect(f.report.mock.lastCall?.[0].message).toContain("응답");expect(f.stop).toHaveBeenCalledOnce();
    const slow=fixture();await Promise.resolve();slow.next({updateRequestId:"1700000000001",updateState:"installing"});
    await vi.advanceTimersByTimeAsync(600_000);expect(slow.report.mock.lastCall?.[0].message).toContain("시간이 초과");
    const cancelled=fixture();cancelled.cancel();const count=cancelled.report.mock.calls.length;
    cancelled.next({updateRequestId:"1700000000001",version:"0.1.116"});await vi.advanceTimersByTimeAsync(86_400_000);
    expect(cancelled.report).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);
  });
  it("does not call an initially newer server snapshot a completed request, but recognizes a later legacy restart",async()=>{
    vi.useFakeTimers();const f=fixture();await Promise.resolve();
    f.next({version:"0.1.116",updateRequestId:undefined});expect(f.report.mock.lastCall?.[0].active).toBe(true);
    f.next({version:"0.1.117",updateRequestId:undefined});expect(f.report.mock.lastCall?.[0].message).toContain("업데이트 완료 v0.1.117");expect(f.stop).toHaveBeenCalledOnce();
  });
  it("cleans a synchronous subscription failure before sending and catches late send errors",async()=>{
    vi.useFakeTimers();const f=fixture(true);expect(f.send).not.toHaveBeenCalled();expect(f.stop).toHaveBeenCalledOnce();expect(f.report.mock.lastCall?.[0].failed).toBe(true);
    const late=fixture();late.cancel();late.fail(new Error("late"));expect(late.report).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
});
