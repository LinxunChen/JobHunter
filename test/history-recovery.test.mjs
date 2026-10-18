import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';
import {DatabaseSync} from 'node:sqlite';
import {migrateHistoryIndexes} from '../src/history-store.mjs';
import {createSourceTaskLauncher} from '../src/source-task-launcher.mjs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from '../src/processing-owner.mjs';

test('来源历史有界翻页，原文按ID可查；页面及当日漏斗不携带旧原始快照',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-history-'));
 const app=createApplication({databasePath:join(directory,'data.sqlite'),now:()=>new Date('2026-10-11T03:00:00Z'),announcementProcessor:null,matchingProcessor:null,careerSource:null});
 const server=await startServer({app,port:0});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();rmSync(directory,{recursive:true,force:true});});
 const marker='历史原文不可进入日常读取';
 for(let n=0;n<25;n++)app.recordSourceCheck({id:'history-'+n,sourceId:'efunds-social',status:'success',checkedAt:new Date(Date.parse('2026-10-10T16:00:00Z')+n*60000).toISOString(),gaps:[],listCount:0,listComplete:true,pages:[{raw:marker.repeat(10000)}],details:[],jobIds:[]});
 const base=`http://127.0.0.1:${server.address().port}`;
 const firstResponse=await fetch(base+'/api/history/source_health_checks?sourceId=efunds-social');
 assert.equal(firstResponse.status,200);
 const first=await firstResponse.json();assert.equal(first.items.length,20);assert.ok(first.nextCursor);
 const second=await(await fetch(base+'/api/history/source_health_checks?sourceId=efunds-social&cursor='+first.nextCursor)).json();
 assert.equal(second.items.length,5);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,25);
 assert.equal(second.nextCursor,null);
 const raw=await(await fetch(base+'/api/history/source_health_checks/history-0/raw')).json();assert.equal(raw.pages[0].raw,marker.repeat(10000));
 const overview=app.getSourcesOverview();assert.equal(overview.sources.find(source=>source.id==='efunds-social').historyCount,25);assert.ok(JSON.stringify(overview).length<100000);assert.ok(!JSON.stringify(overview).includes(marker));
 const preview=app.getNotificationPreview();assert.deepEqual(preview.runSummary.counts,{checkedSources:1,parsedSources:1,partialSources:0,failedSources:0,newJobs:0});
 const before=app.getActionEvents();for(const path of ['/jobs','/sources','/notification-preview','/runs'])assert.equal((await fetch(base+path)).status,200);
 assert.deepEqual(app.getActionEvents(),before);assert.equal(app.listNotificationAttempts().length,0);
 for(let n=0;n<2500;n++){
  app.recordSourceCheck({id:'older-'+n,sourceId:'efunds-social',status:'success',checkedAt:'2026-10-09T00:00:00Z',pages:[{raw:marker.repeat(100)}],details:[],jobIds:[]});
  // Fixture loading must let HTTP idle sockets close normally, as the production worker does.
  if(n%100===0)await new Promise(resolve=>setImmediate(resolve));
 }
 const started=performance.now(),response=await fetch(base+'/sources',{headers:{connection:'close'}});assert.equal(response.status,200);assert.ok((await response.text()).length<150000);assert.ok(performance.now()-started<1000);
 assert.equal(app.getSourceCheckSummary('efunds-social').historyCount,2525);assert.equal(app.getSourceCheckSummary('efunds-social').history.length,20);
 assert.equal(app.getNotificationPreview().runSummary.counts.checkedSources,1);
});

test('有效进程的不同启动身份不冒充旧任务，缺少身份证据仍保守处理',async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>child.kill('SIGKILL'));
 const owner=beginProcessingOwner();assert.equal(processingOwnerAlive(owner),true);endProcessingOwner(owner);assert.equal(processingOwnerAlive(owner),false);
 // A deliberately mismatched start time models PID reuse; the child process is real.
 assert.equal(processingOwnerAlive({pid:child.pid,id:'old-task',processStartedAt:'2000-01-01T00:00:00.000Z'}),false);
 assert.equal(processingOwnerAlive({pid:child.pid,id:'legacy-task'}),true);
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 assert.equal(processingOwnerAlive({pid:child.pid,id:'old-task'}),false);
});

test('明确所属进程已退出的备份中断锁不会阻止Web重开，已有投递和历史保留',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-backup-restart-')),databasePath=join(directory,'data.sqlite');
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null};
 let app=createApplication(options);t.after(()=>{app?.close();rmSync(directory,{recursive:true,force:true});});
 const job=app.createJob({title:'模拟备份重启',originalText:'模拟历史保留'});app.setApplied(job.id,true);app.close();app=null;
 const code=`import{writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';writeFileSync(${JSON.stringify(databasePath+'.backup.lock')},JSON.stringify({token:randomUUID(),pid:process.pid,startedAt:new Date().toISOString()}),{mode:0o600});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});await once(child,'exit');
 app=createApplication(options);assert.equal(app.getPersonalState(job.id).applied,true);assert.equal(app.listJobs().length,1);assert.equal(app.listNotificationAttempts().length,0);
});

test('独立检查期间页面快速响应，Web重开保留任务；检查进程中断后只续未完成来源且不发送',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-worker-')),databasePath=join(directory,'data.sqlite');
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceCheckLauncher:createSourceTaskLauncher({databasePath,workerPath:fileURLToPath(new URL('./fixtures/check-worker.mjs',import.meta.url))})};
 let app=createApplication(options),server=await startServer({app,port:0});
 t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));app.close();rmSync(directory,{recursive:true,force:true});});
 const task=app.startSourceCheck({sourceIds:['efunds-social','boc-social']});
 const until=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('任务进度未及时保存');await new Promise(resolve=>setTimeout(resolve,40));}};
 await until(()=>app.getSourceCheckTask(task.id).results.length===1);
 const owner=app.getSourceCheckTask(task.id).owner;assert.notEqual(owner.pid,process.pid);
 const start=performance.now();assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/sources`)).status,200);assert.ok(performance.now()-start<1000);
 assert.equal(app.startSourceCheck({sourceIds:['boc-social']}).id,task.id);
 await assert.rejects(app.executeSourceCheckTask(task.id),/接管/);
 await new Promise(resolve=>server.close(resolve));app.close();app=createApplication(options);server=await startServer({app,port:0});
 assert.equal(app.getSourceCheckTask(task.id).status,'running');
 process.kill(owner.pid,'SIGKILL');await until(()=>app.getSourceCheckTask(task.id).status==='interrupted');
 const resumed=app.resumeSourceCheck(task.id);await app.waitForSourceCheck(resumed.id);
 assert.equal(app.getSourceCheckTask(resumed.id).results.length,2);assert.equal(app.getSourceCheckSummary('efunds-social').historyCount,1);
 assert.equal(app.listNotificationAttempts().length,0);assert.equal(app.listCareerRefreshes().length,0);assert.equal(app.listBackups().length,0);
});

test('有效备份持锁期间Web可重开读取，写入仍被阻止，所属进程退出后才释放锁',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-live-backup-')),databasePath=join(directory,'data.sqlite');
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null};
 let app=createApplication(options),child,server;
 t.after(async()=>{child?.kill('SIGKILL');if(server?.listening)await new Promise(resolve=>server.close(resolve));app?.close();rmSync(directory,{recursive:true,force:true});});
 const job=app.createJob({title:'保留已有岗位',originalText:'受控备份'});app.close();app=null;
 const code=`import{writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';import{DatabaseSync}from'node:sqlite';writeFileSync(${JSON.stringify(databasePath+'.backup.lock')},JSON.stringify({token:randomUUID(),pid:process.pid,startedAt:new Date().toISOString()}),{mode:0o600});const db=new DatabaseSync(${JSON.stringify(databasePath)});db.exec('BEGIN IMMEDIATE');console.log('ready');setInterval(()=>{},1000);`;
 child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','ignore']});await once(child.stdout,'data');
 const started=performance.now();app=createApplication(options);server=await startServer({app,port:0});
 assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/jobs`)).status,200);assert.ok(performance.now()-started<2000);
 assert.throws(()=>app.setApplied(job.id,true),/备份/);
 child.kill('SIGKILL');await once(child,'exit');child=null;
 await new Promise(resolve=>server.close(resolve));app.close();app=createApplication(options);
 assert.equal(app.listJobs().length,1);app.setApplied(job.id,true);assert.equal(app.getPersonalState(job.id).applied,true);
});

test('恢复旧周期检查点仍使用原周期顺序，不遮蔽新周期或造成翻页重复',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-run-order-')),databasePath=join(directory,'data.sqlite');
 const app=createApplication({databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null});
 t.after(()=>{app.close();rmSync(directory,{recursive:true,force:true});});
 const db=new DatabaseSync(databasePath);
 try{
  for(let n=0;n<25;n++)db.prepare('INSERT INTO scheduled_runs VALUES(?,?)').run('run-'+n,JSON.stringify({id:'run-'+n,date:'2026-10-10',status:'completed',steps:[],startedAt:'2026-10-10T01:00:00Z'}));
  db.prepare('INSERT INTO run_checkpoints VALUES(?,?)').run('run-0',JSON.stringify({id:'run-0',date:'2026-10-10',status:'interrupted',steps:[],startedAt:'2026-10-10T01:00:00Z'}));
 }finally{db.close();}
 const first=app.listHistoryPage({kind:'scheduled_runs'}),second=app.listHistoryPage({kind:'scheduled_runs',cursor:first.nextCursor});
 assert.equal(first.items[0].id,'run-24');assert.equal(second.items.at(-1).id,'run-0');assert.equal(second.items.at(-1).status,'interrupted');assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,25);
});

test('旧周期显式迁移可重复，恢复仅更新检查点并完整保留原始历史',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-legacy-history-')),databasePath=join(directory,'data.sqlite');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const old={id:'legacy-run',date:'2026-10-10',status:'running',startedAt:'2026-10-10T01:00:00Z',owner:{pid:999999,id:'legacy-owner'},sources:[],steps:[{key:'career',status:'completed',result:{status:'completed',raw:'旧原文'.repeat(100000)}}],gaps:[],coverage:{counts:{included:51}}};
 const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE scheduled_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');db.prepare('INSERT INTO scheduled_runs VALUES(?,?)').run(old.id,JSON.stringify(old));db.close();
 await assert.rejects(migrateHistoryIndexes({databasePath,batchSize:1,onProgress:()=>{throw Error('受控迁移中断');}}),/受控迁移中断/);
 assert.equal((await migrateHistoryIndexes({databasePath,batchSize:1})).status,'completed');
 assert.equal((await migrateHistoryIndexes({databasePath})).status,'completed');
 const blocked=async()=>{throw Error('本测试禁止外呼');};
 const app=createApplication({databasePath,now:()=>new Date('2026-10-11T00:00:00Z'),announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked});
 t.after(()=>app.close());
 assert.ok(JSON.stringify(app.getScheduledRun(old.id)).length<5000);
 assert.equal((await app.runScheduledCycle()).status,'not_due');
 assert.equal(app.getScheduledRun(old.id).status,'interrupted');
 assert.deepEqual(app.getHistoryRecord('scheduled_runs',old.id),old);
 assert.equal(app.listNotificationAttempts().length,0);
});
