import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createApplication} from '../src/application.mjs';import {startServer} from '../src/server.mjs';
test('六个来源检查入口拒绝非对象JSON和错误内容类型，未发出外部请求',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jh-source-input-'));let requests=0;const fetcher=async()=>{requests++;throw Error('外部接入不应执行');};const app=createApplication({databasePath:join(dir,'data.sqlite'),announcementProcessor:null,matchingProcessor:null,sourceFetch:fetcher,ccbSourceFetch:fetcher,icbcFetch:fetcher,cmriFetch:fetcher,sasacFetch:fetcher});const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();rmSync(dir,{recursive:true,force:true});});
 for(const source of ['icbc','cmri','boc','ccb','efunds','sasac'])for(const input of ['null','[]','"invalid"','{broken']){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sources/${source}/check`,{method:'POST',headers:{'Content-Type':'application/json'},body:input});assert.equal(response.status,400,source+' '+input);
 }
 for(const source of ['icbc','cmri','boc','ccb','efunds','sasac'])assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/sources/${source}/check`,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,400);
 assert.equal(requests,0);
});
