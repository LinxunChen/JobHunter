import {execFile}from'node:child_process';
import {createCipheriv,createDecipheriv,publicEncrypt,constants,randomBytes,createHash}from'node:crypto';
import {mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const origin='https://career.abchina.com.cn';
const allowed=new Set(['/new/getInfo','/pubDict/getRecruitTypeById','/org/getOrgsByAreaId','/org/getOrgInfoById','/orgPosition/getAllInPosition','/orgPosition/getPositioninfoById']);
// The public frontend uses these encodings for anonymous read queries. This is
// no account key: obtain the server's public RSA key afresh for each check.
function publicSignKey(){const key=Buffer.from('这一段文字用来做给路由加密的私钥','latin1'),d=createDecipheriv('aes-128-cbc',key,key);d.setAutoPadding(false);return Buffer.from(JSON.parse(Buffer.concat([d.update('BdKiQIIqbS8MgLraCvRReZVtxnlSnnKkqkrJrQJhx2XOYhI8fiHvqb2HxFlyNUy0','base64'),d.final()]).toString().replace(/\0+$/,'')),'hex');}
export async function createAbcPublicSession(){
 const dir=await mkdtemp(join(tmpdir(),'jh-abc-read-')),cookie=join(dir,'anonymous.cookies'),bodyFile=join(dir,'body');let publicKey;
 async function raw(url,options={}){
  const u=new URL(url);if(u.origin!==origin||u.username||u.password||u.search||u.hash||!(u.pathname==='/build/index.html'||allowed.has(u.pathname)))throw Error('农行公开读取地址越界');
  const args=['--compressed','--silent','--show-error','--max-time','20','--max-filesize','5242880','--cookie',cookie,'--cookie-jar',cookie,'--output',bodyFile,'--write-out','%{http_code}',url];
  if(options.method)args.push('--request',options.method);for(const[k,v]of Object.entries(options.headers??{}))args.push('--header',k+': '+v);if(options.body)args.push('--data-binary',options.body);
  const status=await new Promise((resolve,reject)=>execFile('/usr/bin/curl',args,{maxBuffer:1024,signal:options.signal},(error,stdout)=>error?reject(Error('农行公开读取失败：curl '+error.code)):resolve(Number(stdout))));return new Response(await readFile(bodyFile),{status});
 }
 return {close:()=>rm(dir,{recursive:true,force:true}),fetch:async(url,options={})=>{
  if(!options.body)return raw(url,options);
  if(!publicKey){const r=await raw(origin+'/new/getInfo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"value":1}',signal:options.signal});if(r.status!==200)throw Error('农行匿名查询初始化失败');const d=await r.json();if(d.descCode!=='CL00001'||typeof d.object?.value!=='string')throw Error('农行公开查询编码配置变化');publicKey='-----BEGIN PUBLIC KEY-----\n'+d.object.value+'\n-----END PUBLIC KEY-----';}
  const iv=randomBytes(8).toString('hex'),key=randomBytes(8).toString('hex'),cipher=createCipheriv('aes-128-cbc',Buffer.from(key),Buffer.from(iv)),body=Buffer.concat([cipher.update(options.body),cipher.final()]).toString('hex');
  const sample='1'+[1,2,5,6,15,25].filter(i=>body.length>i).map(i=>body[i]).join(''),sm4=createCipheriv('sm4-ecb',publicSignKey(),null),sign=Buffer.concat([sm4.update(sample),sm4.final()]).toString('hex'),rsa=value=>publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(value)).toString('base64');
  const r=await raw(url,{...options,body,headers:{'Content-Type':'application/json',viF:rsa(iv),keF:rsa(key),pellosetq:sign}});if(r.status!==200)return r;
  const original=await r.text(),data=JSON.parse(original);let decoded={...data};
  if(data.object){const d=createDecipheriv('aes-128-cbc',Buffer.from(key),Buffer.from(iv));decoded.object=JSON.parse(Buffer.concat([d.update(data.object,'hex'),d.final()]).toString());}
  // Never persist an anonymous session token with recruitment evidence.
  const response=new Response(JSON.stringify({...data,rmisToken:null}),{status:r.status});response.wireHash=createHash('sha256').update(original).digest('hex');response.rawRedacted=true;response.publicData={...decoded,rmisToken:null};return response;
 }};
}
