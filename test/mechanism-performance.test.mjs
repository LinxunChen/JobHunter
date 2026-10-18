import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';

test('关注与投递仅派生所选岗位，撤销投递保留历史但移出当前集合',t=>{
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null});t.after(()=>app.close());
 const jobs=Array.from({length:12},(_,i)=>app.createJob({title:'模拟岗位'+i,originalText:'完整模拟原文'}));
 app.setPersonalState(jobs[3].id,{followed:true});app.setApplied(jobs[6].id,true);
 const read=app.getRecruitmentState;let reads=[];app.getRecruitmentState=(id,...args)=>{reads.push(id);return read(id,...args);};
 assert.deepEqual(app.listJobView('followed').map(x=>x.id),[jobs[3].id]);assert.deepEqual([...new Set(reads)],[jobs[3].id]);
 reads=[];assert.deepEqual(app.listJobView('applied').map(x=>x.id),[jobs[6].id]);assert.deepEqual([...new Set(reads)],[jobs[6].id]);
 app.setApplied(jobs[6].id,false);reads=[];assert.deepEqual(app.listJobView('applied'),[]);assert.deepEqual(reads,[]);assert.equal(app.listApplications(jobs[6].id).length,1);
 assert.throws(()=>app.listJobView('applied',{bad:'filter'}),/筛选/);
});

test('公告交接通过持久队列只处理变更，失败和另一连接更新不会被确认丢失',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(join(tmpdir(),'jh-handoff-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const databasePath=join(dir,'db.sqlite');
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null};let app=createApplication(options);
 const ann=await app.createAnnouncement({title:'模拟公告',originalText:'完整模拟正文'});
 assert.equal(app.reconcilePendingAnnouncements().length,1);assert.deepEqual(app.reconcilePendingAnnouncements(),[]);
 const writer=new DatabaseSync(databasePath),update=title=>writer.prepare('UPDATE announcements SET body=json_set(body,\'$.title\',?) WHERE id=?').run(title,ann.id);
 update('跨进程变更');app.close();app=createApplication(options);t.after(()=>{app.close();writer.close();});
 const reconcile=app.reconcileAnnouncementJobs;let fail=true;app.reconcileAnnouncementJobs=id=>{if(fail)throw Error('模拟交接中断');return reconcile(id);};
 assert.throws(()=>app.reconcilePendingAnnouncements(),/模拟交接中断/);fail=false;
 assert.equal(app.reconcilePendingAnnouncements().length,1);assert.deepEqual(app.reconcilePendingAnnouncements(),[]);
 update('旧版本待处理');app.reconcileAnnouncementJobs=id=>{const result=reconcile(id);update('处理过程中另一个进程修改');return result;};
 assert.equal(app.reconcilePendingAnnouncements().length,1);app.reconcileAnnouncementJobs=reconcile;
 assert.equal(app.reconcilePendingAnnouncements().length,1);assert.deepEqual(app.reconcilePendingAnnouncements(),[]);
});

test('日报已交接后的准备按变更和时间到期执行，不漏跨进程更新与跨日',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(join(tmpdir(),'jh-daily-change-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const databasePath=join(dir,'db.sqlite');let at='2026-10-15T02:00:00.000Z';
 const options={databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date(at)};let app=createApplication(options);
 const job=app.importJob({title:'模拟关注岗位',originalText:'完整模拟正文',sourceIdentity:{sourceId:'demo',externalId:'boundary'},observedAt:at}).job;
 const fact=raw=>({raw,evidence:{url:'https://example.org/job',text:raw,quote:raw}});
 app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:'boundary',observedAt:at,acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url:'https://example.org/job',text:'公开开放',quote:'公开开放'},start:fact('2026-10-15T02:30:00Z'),deadline:fact('2026-10-15T03:00:00Z')});
 const draft=app.prepareDailyActions().dailyDigest;app.handoffNotificationDraft(draft.id,{attemptId:'controlled-no-send'});
 let scans=0;const original=app.listJobs;app.listJobs=(...args)=>{scans++;return original(...args);};
 assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);assert.equal(scans,0);
 app.close();app=createApplication(options);t.after(()=>app.close());assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);
 const writer=new DatabaseSync(databasePath);writer.prepare('INSERT INTO personal_states VALUES(?,?)').run(job.id,JSON.stringify({followed:true}));writer.close();
 assert.notEqual(app.prepareDailyActionsIfNeeded().unchanged,true);assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);
 at='2026-10-15T02:30:00.000Z';assert.notEqual(app.prepareDailyActionsIfNeeded().unchanged,true);assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);
 at='2026-10-15T03:00:00.001Z';assert.notEqual(app.prepareDailyActionsIfNeeded().unchanged,true);assert.equal(app.getRecruitmentState(job.id).dates.deadlinePassed,true);
 at='2026-10-16T01:00:00.000Z';assert.equal(app.prepareDailyActionsIfNeeded().dailyDigest.date,'2026-10-16');assert.equal(app.listNotificationAttempts().length,0);
});

test('轻量进度HTTP不派生岗位，不返回原文，业务变更更新版本而调度心跳不更新',async t=>{
 const {startServer}=await import('../src/server.mjs');
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date('2026-10-15T02:00:00Z')});
 const job=app.createJob({title:'模拟岗位',originalText:'长原文'.repeat(10000)});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();});
 const read=app.getRecruitmentState;let reads=0;app.getRecruitmentState=(...args)=>{reads++;return read(...args);};
 const get=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/operations/progress`);assert.equal(response.status,200);const text=await response.text();assert.ok(text.length<12000);assert.doesNotMatch(text,/长原文/);return JSON.parse(text);};
 const first=await get();assert.equal(reads,0);
 const tick=app.beginSchedulerActivity();app.finishSchedulerActivity(tick,{status:'not_due'});const heartbeat=await get();assert.equal(heartbeat.revision,first.revision);
 app.setPersonalState(job.id,{followed:true});const changed=await get();assert.notEqual(changed.revision,first.revision);assert.equal(reads,0);
 const page=await(await fetch(`http://127.0.0.1:${server.address().port}/sources`)).text();assert.ok(page.includes('data-revision="'+changed.revision+'"'));
});
