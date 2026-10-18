import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

test('岗位和旧来源历史同时增长时，公共岗位页不按每岗每历史遍历整库',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-growth-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const databasePath=join(directory,'data.sqlite'),at='2026-10-14T02:00:00Z';
 let app=createApplication({databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date(at)});app.close();
 const db=new DatabaseSync(databasePath);const rows=[];db.exec('BEGIN');
 // A historical database fixture bypasses write-time transition calculation;
 // the actual public HTTP read path, SQLite projections and rendering are real.
 for(let n=0;n<80;n++){
  const id='job-'+n,postId=(n+1).toString(16).padStart(24,'0');
  const job={id,title:'模拟算法专家'+n,originalText:'模拟岗位算法研发职责',duties:'负责算法研发',knownConditions:[],unknownFields:[],conditions:[],dateEvidence:[],location:{options:['北京']},evidenceUse:'unverified',recruitmentStatus:'unverified',firstDiscoveredAt:at,recruitmentUnit:'模拟基金',sourceIdentities:[{sourceId:'efunds-social',externalId:postId}]};
  db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(id,JSON.stringify(job),at);rows.push({postId});
 }
 for(let n=0;n<10;n++){
  const run={id:'legacy-'+n,sourceId:'efunds-social',status:'success',checkedAt:at,listComplete:true,listCount:rows.length,pages:[{url:'https://example.org',raw:{data:{pageForm:{dataCount:rows.length,pageData:rows}}}}],details:rows.map(row=>({status:200,raw:{data:{...row,canDelivery:true,showDeliverButton:1}},applicationPage:{status:200,raw:'/pb/js/posDetail.js'}}))};
  db.prepare('INSERT INTO source_checks VALUES(?,?,?,?)').run(run.id,run.sourceId,JSON.stringify(run),at);
 }
 db.exec('COMMIT');db.close();
 let fullJobReads=0,legacyBodyReads=0,reading=false;const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);return new Proxy(statement,{get(target,method){const value=Reflect.get(target,method,target);if(typeof value!=='function')return value;return (...args)=>{if(reading&&['get','all'].includes(method)){if(sql==='SELECT body FROM jobs ORDER BY rowid')fullJobReads++;if(sql.includes('FROM history_records')&&sql.includes("kind='source_checks'")&&(sql.startsWith('SELECT body ')||sql.startsWith('SELECT h.body ')))legacyBodyReads++;}return value.apply(target,args);};}});};
 t.after(()=>{DatabaseSync.prototype.prepare=prepare;});
 app=createApplication({databasePath,verificationMode:true,now:()=>new Date(at)});const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();});reading=true;
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/jobs`,{headers:{connection:'close'}}),jobs=await response.json();
 assert.equal(response.status,200);assert.equal(jobs.length,80);
 assert.ok(jobs.every(job=>job.recruitment.status==='unverified'));
 const detail=await(await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/job-0`)).json();assert.equal(detail.recruitment.history.length,10);
 assert.ok(fullJobReads<=2,`岗位与详情读取扫描整库${fullJobReads}次，随岗位×历史增长`);
 assert.ok(legacyBodyReads<=10,`10条旧检查正文被读取${legacyBodyReads}次`);
 assert.equal(app.listNotificationAttempts().length,0);
});

test('读取复用不跨请求，缓存返回值、同进程写入及另一连接提交都不会隐藏新状态',t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-read-fresh-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const databasePath=join(directory,'data.sqlite');
 const app=createApplication({databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null});t.after(()=>app.close());
 const job=app.createJob({title:'模拟新状态',originalText:'完整模拟原件'});
 app.withReadSnapshot(()=>{
  const first=app.getJob(job.id);first.title='调用者修改副本';assert.equal(app.getJob(job.id).title,job.title);
  assert.equal(app.getPersonalState(job.id).followed,false);app.setPersonalState(job.id,{followed:true});assert.equal(app.getPersonalState(job.id).followed,true);
  const writer=new DatabaseSync(databasePath);const fresh=JSON.parse(writer.prepare('SELECT body FROM jobs WHERE id=?').get(job.id).body);fresh.title='另一连接更新';writer.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(fresh),job.id);writer.close();
  assert.equal(app.getJob(job.id).title,'另一连接更新');
 });
 assert.equal(app.getJob(job.id).title,'另一连接更新');assert.equal(app.getPersonalState(job.id).followed,true);
});

test('公告同步只处理脏记录，中断写入可在重启恢复，带空格的旧JSON同样收口',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'jh-issue-queue-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const databasePath=join(directory,'data.sqlite');
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date('2026-10-15T02:00:00Z')};
 let app=createApplication(options);const ann=await app.createAnnouncement({title:'模拟中断',originalText:'模拟招聘原文',sourceUrl:'https://example.org/job',sourceIdentityContext:{sourceId:'efunds-social',externalId:'https://example.org/job',observedAt:'2026-10-15T00:00:00Z'}});app.close();
 const db=new DatabaseSync(databasePath);
 const failed={...ann,status:'failed',error:'模型证据无法定位：announcement/正文',processingFailure:{stage:'validation'},steps:[...ann.steps,{step:'model_failed',at:'2026-10-15T01:00:00Z'}]};
 db.prepare('UPDATE announcements SET body=? WHERE id=?').run(JSON.stringify(failed,null,2),ann.id);
 assert.equal(db.prepare('SELECT count(*) n FROM processing_issue_sync_queue').get().n,1);db.close();
 app=createApplication(options);assert.equal(app.listProcessingIssues().length,1);app.close();
 const check=new DatabaseSync(databasePath);assert.equal(check.prepare('SELECT count(*) n FROM processing_issue_sync_queue').get().n,0);check.close();
 let announcementReads=0;const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){if(sql.includes('SELECT')&&sql.includes('body FROM announcements'))announcementReads++;return prepare.call(this,sql);};
 try{app=createApplication(options);assert.equal(announcementReads,0);assert.equal(app.listProcessingIssues()[0].status,'failed');app.close();}finally{DatabaseSync.prototype.prepare=prepare;}
});


test('未到计划时刻的后台空周期不重复计算全库岗位与变化',async t=>{
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date('2026-10-15T00:00:00Z')});t.after(()=>app.close());
 let scans=0;const read=app.listJobView;app.listJobView=(...args)=>{scans++;return read(...args);};
 const result=await app.runScheduledCycle();assert.equal(result.status,'not_due');assert.equal(scans,0);assert.equal(app.listNotificationAttempts().length,0);
});
