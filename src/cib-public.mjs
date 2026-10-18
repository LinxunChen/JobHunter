import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,createHmac,randomInt} from 'node:crypto';
const execute=promisify(execFile),origin='https://job.cib.com.cn';
const reads=new Set(['/ersApi/recruitposition/portalPage','/ersApi/recruitposition/queryByIdForPortal']);
// Only the public anonymous handshake and two read queries are permitted.
export async function createCibPublicSession(){
 const dir=await mkdtemp(join(tmpdir(),'jh-cib-read-')),cookie=join(dir,'anonymous.cookies');let sm4Key,signKey;
 async function raw(path,payload,headers={},signal){
  const args=['--compressed','--silent','--show-error','--max-time','20','--max-filesize','5242880','--cookie',cookie,'--cookie-jar',cookie,'--output',join(dir,'body'),'--write-out','%{http_code}',origin+path];
  if(payload!==undefined)args.push('--request','POST','--header','Content-Type: application/json','--data-binary',JSON.stringify(payload));for(const[k,v]of Object.entries(headers))args.push('--header',k+': '+v);
  const{stdout}=await execute('/usr/bin/curl',args,{signal,maxBuffer:1024});return new Response(await readFile(join(dir,'body')),{status:Number(stdout)});
 }
 const decrypt=(value,key)=>{const d=createDecipheriv('sm4-ecb',Buffer.from(key,'hex'),null);return Buffer.concat([d.update(value,'hex'),d.final()]).toString();};
 async function initialize(signal){
  const authResponse=await raw('/api/authPrehandler',{}, {},signal);if(authResponse.status!==200)throw Error('兴业匿名公开查询初始化失败');const auth=await authResponse.json();if(!/^[a-f0-9]{128}$/i.test(auth.pubKey??'')||typeof auth.salt!=='string'||!auth.salt||!auth.userIdentity)throw Error('兴业公开查询编码配置变化');
  const key=Buffer.from('3059301306072a8648ce3d020106082a811ccf5501822d03420004'+auth.pubKey,'hex'),nonce=(Date.now().toString()+String(randomInt(100,1000))).split('').map(c=>c.charCodeAt(0)).join('');
  if(nonce.length!==32)throw Error('兴业匿名随机参数长度变化');await writeFile(join(dir,'public.der'),key);await writeFile(join(dir,'nonce'),nonce);
  // Existing local OpenSSL supports the site's public SM2 encoding; no install.
  await execute('/usr/local/bin/openssl',['pkeyutl','-encrypt','-pubin','-keyform','DER','-inkey',join(dir,'public.der'),'-in',join(dir,'nonce'),'-out',join(dir,'encoded.der')],{signal});
  const der=await readFile(join(dir,'encoded.der'));let offset=0;function part(){const tag=der[offset++];let length=der[offset++];if(length&128){let n=length&127;length=0;while(n--)length=length*256+der[offset++];}if(offset+length>der.length)throw Error('SM2编码不完整');const value=der.subarray(offset,offset+length);offset+=length;return{tag,value};}const seq=part();if(seq.tag!==48)throw Error('SM2编码格式变化');offset=seq.value.byteOffset-der.byteOffset;const pieces=[part(),part(),part(),part()];if(pieces.map(p=>p.tag).join(',')!=='2,2,4,4')throw Error('SM2编码结构变化');const pad=b=>b.length===33&&b[0]===0?b.subarray(1):b.length<=32?Buffer.concat([Buffer.alloc(32-b.length),b]):(()=>{throw Error('SM2坐标变化');})();const encrypted=Buffer.concat([pad(pieces[0].value),pad(pieces[1].value),pieces[3].value,pieces[2].value]).toString('hex'),salt=Buffer.from(auth.salt),keySalt=Array.from(Buffer.from(encrypted)).map((v,i)=>v^salt[i%salt.length]);
  const tokenResponse=await raw('/api/cfn/sysToken',{keySalt,userIdentity:auth.userIdentity},{},signal);if(tokenResponse.status!==200)throw Error('兴业匿名查询编码初始化失败');const tokens=await tokenResponse.json();sm4Key=decrypt(tokens.tokenKey,nonce).split('|')[0];signKey=decrypt(tokens.signKey,sm4Key);if(!/^[a-f0-9]{32}$/i.test(sm4Key)||!/^[a-f0-9]{32}$/i.test(signKey))throw Error('兴业匿名查询编码参数变化');
 }
 return{close:()=>rm(dir,{recursive:true,force:true}),fetch:async(url,options={})=>{
  const u=new URL(url);if(u.origin!==origin||u.search||u.hash||u.username||u.password||!(u.pathname==='/portal/'||reads.has(u.pathname)))throw Error('兴业公开读取地址越界');if(u.pathname==='/portal/')return raw(u.pathname,undefined,{},options.signal);if(options.method!=='POST'||!options.body)throw Error('兴业公开查询参数缺失');if(!sm4Key)await initialize(options.signal);
  const payload=JSON.parse(options.body),normalized=JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]]))).replaceAll('[','').replaceAll(']',''),signature=createHmac('sm3',Buffer.from(signKey)).update(normalized).digest('base64'),timestamp=Date.now().toString(),cipher=createCipheriv('sm4-ecb',Buffer.from(sm4Key,'hex'),null),replay=Buffer.concat([cipher.update('|'+timestamp.slice(-9)+String(randomInt(100000,1000000))+'|'+timestamp),cipher.final()]).toString('hex');return raw(u.pathname,payload,{'X-VALID-TOKEN':signature,'X-AntiReplay-Token':replay,'X-BROWSER-LANG':'zh-CN'},options.signal);
 }};
}
