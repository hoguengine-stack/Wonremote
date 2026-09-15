import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {IncomingFileAssembler} from "./incomingFile";

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const chunk=(index:number)=>({id:`chunk-${index}`,transferId:'transfer',filename:'test.txt',totalChunks:2,totalBytes:6,chunkIndex:index,isLast:index===1,fileData:Buffer.from(index===0?'abc':'def').toString('base64'),chunkSha256:sha(index===0?'abc':'def'),...(index===1?{fileSha256:sha('abcdef')}:{})});
describe('incoming direct files',()=>{
  it('assembles out of order, ignores duplicate chunks and emits one complete file',async()=>{
    const receiver=new IncomingFileAssembler();
    expect(await receiver.accept(chunk(1))).toBeNull();
    expect(await receiver.accept(chunk(1))).toBeNull();
    const file=await receiver.accept(chunk(0));
    expect(await file!.blob.text()).toBe('abcdef');
    expect(file!.filename).toBe('test.txt');
    expect(await receiver.accept(chunk(0))).toBeNull();
  });
  it('rejects corrupted bytes and final hash without producing a file, then permits retry',async()=>{
    const receiver=new IncomingFileAssembler();
    await expect(receiver.accept({...chunk(0),chunkSha256:sha('wrong')})).rejects.toThrow();
    await receiver.accept(chunk(0));
    await expect(receiver.accept({...chunk(1),fileSha256:sha('wrong')})).rejects.toThrow();
    await receiver.accept(chunk(0));
    expect(await (await receiver.accept(chunk(1)))!.blob.text()).toBe('abcdef');
  });
  it('rejects inconsistent metadata, oversized chunks and too many partial transfers',async()=>{
    const receiver=new IncomingFileAssembler();
    await receiver.accept(chunk(0));
    await expect(receiver.accept({...chunk(1),filename:'other'})).rejects.toThrow();
    await expect(receiver.accept({...chunk(0),fileData:'A'.repeat(100000)})).rejects.toThrow();
    for(let i=0;i<4;i++) await receiver.accept({...chunk(0),transferId:`t${i}`});
    await expect(receiver.accept({...chunk(0),transferId:'overflow'})).rejects.toThrow('너무 많');
    receiver.clear();
    expect(await receiver.accept(chunk(0))).toBeNull();
  });
  it('invalidates queued work on session disposal and preserves legacy single-file delivery',async()=>{
    const receiver=new IncomingFileAssembler();
    const pending=receiver.accept(chunk(0));receiver.clear();
    expect(await pending).toBeNull();
    const file=await receiver.accept({id:'old',filename:'legacy.txt',fileData:Buffer.from('legacy').toString('base64')});
    expect(await file!.blob.text()).toBe('legacy');
  });
});
