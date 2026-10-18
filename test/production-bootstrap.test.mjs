import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {createProductionApplication} from '../src/production-bootstrap.mjs';
import {startServer} from '../src/server.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {runScheduledOnce} from '../src/run-scheduled.mjs';

test('生产公共入口加载独立模拟凭据，普通应用默认禁用，HTTP只读不发送', async t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'data.sqlite'),credentials=join(dir,'credentials');mkdirSync(credentials,{mode:0o700});
  writeFileSync(join(credentials,'pushplus.json'),JSON.stringify({enabled:true,queryEnabled:false,token:'synthetic-not-real'}),{mode:0o600});
  let requests=0;
  const app=createProductionApplication({databasePath,pushplusRequest:async()=>{requests++;return new Response(JSON.stringify({code:200,data:'synthetic-message'}),{status:200});}});t.after(()=>app.close());
  assert.equal(app.getNotificationStatus().sendEnabled,true);assert.equal(app.getNotificationStatus().queryEnabled,false);
  const plain=createApplication({databasePath});assert.equal(plain.getNotificationStatus().sendEnabled,false);plain.close();
  const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/notifications`),ledger=await response.json();
  assert.equal(response.status,200);assert.equal(ledger.capability.mode,'configured');assert.equal(requests,0);assert(!JSON.stringify(ledger).includes('synthetic-not-real'));
  const draft=app.createNotificationVerification();assert.equal((await app.sendNotification(draft.id)).status,'accepted');assert.equal(requests,1);assert.equal(app.listNotificationAttempts().length,1);
});

test('缺失凭据默认禁用；恢复标记和核对模式优先禁用而不读取坏凭据', t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'data.sqlite');let app=createProductionApplication({databasePath});assert.equal(app.getNotificationStatus().mode,'disabled');app.close();
  mkdirSync(join(dir,'credentials'),{mode:0o700});writeFileSync(join(dir,'credentials/pushplus.json'),'invalid secret synthetic-private-text',{mode:0o600});
  app=createProductionApplication({databasePath,verificationMode:true});assert.equal(app.verificationMode,true);assert.equal(app.getNotificationStatus().sendEnabled,false);app.close();
  writeFileSync(join(dir,'restore-verification.json'),'{}',{mode:0o600});app=createProductionApplication({databasePath});assert.equal(app.verificationMode,true);assert.equal(app.getNotificationStatus().mode,'disabled');assert.throws(()=>app.createNotificationVerification(),/核对模式/);app.close();
});

test('不安全或损坏配置关闭启动，错误不包含模拟密钥，不能注入接入实现', t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'data.sqlite'),directory=join(dir,'credentials'),file=join(directory,'pushplus.json');mkdirSync(directory,{mode:0o700});
  const invalid=[{mode:0o644,body:JSON.stringify({enabled:true,token:'synthetic-private-text'})},{mode:0o600,body:'{"token":"synthetic-private-text", invalid'},{mode:0o600,body:JSON.stringify({enabled:'true',token:'synthetic-private-text'})},{mode:0o600,body:JSON.stringify({enabled:true,queryEnabled:true,token:'synthetic-private-text'})},{mode:0o600,body:JSON.stringify({enabled:true,token:'synthetic-private-text',request:'unexpected'})},{mode:0o600,body:'synthetic-private-text'.repeat(10000)}];
  for(const item of invalid){writeFileSync(file,item.body);chmodSync(file,item.mode);assert.throws(()=>createProductionApplication({databasePath}),error=>error.message==='JobHunter通知配置不可用；发送未启用');}
  writeFileSync(file,JSON.stringify({enabled:true,token:'synthetic-private-text'}));chmodSync(file,0o600);chmodSync(directory,0o755);assert.throws(()=>createProductionApplication({databasePath}),/通知配置不可用/);chmodSync(directory,0o700);
  rmSync(file);symlinkSync(join(dir,'not-a-credential'),file);assert.throws(()=>createProductionApplication({databasePath}),/通知配置不可用/);
});

test('生产Web实际子进程和CLI共用配置；09点前无网络并在重启后保持发送能力', async t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'data.sqlite');mkdirSync(join(dir,'credentials'),{mode:0o700});writeFileSync(join(dir,'credentials/pushplus.json'),JSON.stringify({enabled:true,queryEnabled:false,token:'synthetic-not-real'}),{mode:0o600});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:'/usr/bin:/bin',JOBHUNTER_DB:databasePath,JOBHUNTER_PORT:'0',JOBHUNTER_VERIFICATION:'0'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();
  try {
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('本机Web未启动')),10000);child.stdout.on('data',()=>{const found=output.match(/127\.0\.0\.1:(\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('本机Web退出'));});});
    const result=await (await fetch(`http://127.0.0.1:${port}/api/notifications`)).json();assert.equal(result.capability.sendEnabled,true);assert.equal(result.attempts.length,0);
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
  let external=0;const forbidden=async()=>{external++;throw Error('禁止真实外部调用');};
  const run=await runScheduledOnce({databasePath,now:()=>new Date('2026-10-09T00:00:00.000Z'),sourceFetch:forbidden,ccbSourceFetch:forbidden,icbcFetch:forbidden,cmriFetch:forbidden,sasacFetch:forbidden,careerSource:{readCareerOverview:forbidden},pushplusRequest:forbidden});
  assert.equal(run.status,'not_due');assert.equal(run.notifications.capability.sendEnabled,true);assert.equal(external,0);
});

test('最小PATH下生产公告与匹配执行明确绝对CLI，固定模型推理及禁工具合同', async t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const command=join(dir,'synthetic-codex');
  const output={commonConditions:[],inputGaps:[],jobs:[{title:'模拟算法岗位',recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:[],duties:null,conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:'模拟算法岗位'}],applicationPath:null,unknownFields:[],dateEvidence:[]}]};
  const dimension={level:'unknown',explanation:'模拟未知',directExperiences:[],transferableAbilities:[],gaps:['模拟职责不足'],jobQuotes:['模拟算法岗位']},match={technical:dimension,business:dimension,scope:dimension,route:'uncertain',routeExplanation:'模拟未知',uncertainties:['模拟']};
  writeFileSync(command,`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args[args.indexOf('--model')+1]!=='gpt-6.1-sol'||!args.includes('model_reasoning_effort="high"')||!args.includes('--ignore-user-config')||args[args.indexOf('--sandbox')+1]!=='read-only')process.exit(7);for(const feature of ['hooks','shell_tool','multi_agent','memories','apps','plugins'])if(!args.some((arg,i)=>arg==='--disable'&&args[i+1]===feature))process.exit(8);const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(schema.properties.jobs?${JSON.stringify(output)}:${JSON.stringify(match)}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));\n`,{mode:0o700});
  const originalPath=process.env.PATH;process.env.PATH='';
  try{const app=createProductionApplication({databasePath:join(dir,'data.sqlite'),codexCommand:command});try{
    const announcement=await app.createAnnouncement({title:'模拟公告',originalText:'模拟算法岗位'}),processed=await app.processAnnouncement(announcement.id);assert.equal(processed.status,'processed',processed.error);assert.equal(processed.processingReceipt.model,'gpt-6.1-sol');
    app.saveCareerProfile({text:'模拟职业资料',version:'模拟v1',sourceId:'manual'});const matched=await app.matchJob(processed.jobIds[0]);assert.equal(matched.status,'completed',matched.gaps.join(' '));assert.equal(matched.receipt.model,'gpt-6.1-sol');
  }finally{app.close();}}finally{if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;}
});

test('生产CLI实际核对子进程不读坏凭据、不启外源，帮助也不写库', async t => {
  const dir=mkdtempSync(join(tmpdir(),'jobhunter-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const databasePath=join(dir,'data.sqlite');mkdirSync(join(dir,'credentials'),{mode:0o700});writeFileSync(join(dir,'credentials/pushplus.json'),'synthetic-invalid-secret',{mode:0o600});writeFileSync(join(dir,'restore-verification.json'),'{}',{mode:0o600});
  const execute=argument=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['src/run-scheduled.mjs',...argument],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:'/usr/bin:/bin',JOBHUNTER_DB:databasePath},stdio:['ignore','pipe','pipe']});let output='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.once('error',reject);child.once('exit',code=>resolve({code,output}));});
  const help=await execute(['--help']);assert.equal(help.code,0);assert.match(help.output,/恢复核对模式不读取凭据/);assert.equal(existsSync(databasePath),false);
  const result=await execute([]);assert.equal(result.code,1);assert.match(result.output,/当前检查未完成/);assert(!result.output.includes('synthetic-invalid-secret'));assert(!result.output.includes('通知配置不可用'));
});
