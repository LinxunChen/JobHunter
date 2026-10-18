import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process.mjs';
import {createHash} from 'node:crypto';
let compiler;
const cache=new Map();
async function reader() {
 if(process.platform!=='darwin')throw Error('本机图片识别仅支持macOS；保留原图待补录');
 if(!compiler)compiler=(async()=>{
  const parent=fileURLToPath(new URL('../.runtime/',import.meta.url));await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(parent+'image-reader-'),command=directory+'/reader';
  try {const result=await runProcess('/usr/bin/xcrun',['swiftc',fileURLToPath(new URL('./read-image.swift',import.meta.url)),'-o',command],{timeoutMs:45000});if(result.code!==0)throw Error('本机图片识别编译不可用；原图保留，不安装依赖');}
  catch(error){await rm(directory,{recursive:true,force:true});compiler=null;throw error;}
  process.once('exit',()=>rmSync(directory,{recursive:true,force:true}));return command;
 })();
 return compiler;
}
export async function readImage(bytes) {
 const hash=createHash('sha256').update(bytes).digest('hex');if(cache.has(hash))return structuredClone(cache.get(hash));
 const command=await reader(),result=await runProcess(command,[],{input:bytes,timeoutMs:15000,maxBytes:1024*1024});
 if(result.code!==0)throw Error('图片识别未完成（损坏或超出像素/动画帧读取边界）；原图保留待核对');
 const output=JSON.parse(result.stdout);
 if(/此图片来自微信公众平台|未经允许不可引用/.test(output.text??''))throw Error('图片响应为平台引用提示，未取得招聘原图；需核对文章图片请求上下文');
 if(!Array.isArray(output.lines)||typeof output.text!=='string'||output.lines.length>2000||output.lines.some(x=>typeof x.text!=='string'||!Number.isFinite(x.confidence)))throw Error('图片未取得有效识别结果；原图保留');
 const segments=output.lines.map((line,i)=>({locator:`图片OCR第${i+1}行`,text:line.text,confidence:line.confidence,frame:line.frame??1}));
 const value={text:output.text,segments,reader:'macOS Vision OCR',imageFrames:output.frameCount,imageTextStatus:output.text.trim()?'text':'no_text',ocrNeedsReview:segments.some(x=>x.confidence<.9),readerNote:output.text.trim()?'本机OCR文字；全部动画帧、原图与逐行置信度保留，低置信文字不作为自动推荐完整条件':'完整图片/动画帧已识别，未识别到文字；原图保留，不充当岗位证据或链接已读取证明'};
 if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(hash,value);return structuredClone(value);
}
