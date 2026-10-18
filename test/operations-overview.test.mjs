import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from './helpers/career-application.mjs';
export function setup(t,extra={}) {
 const root=mkdtempSync(join(tmpdir(),'jh-ops-'));let at='2026-10-08T02:00:00Z';
 const blocked=async()=>{throw Error('controlled external boundary');};
 const options={databasePath:join(root,'data.sqlite'),now:()=>new Date(at),announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked,...extra};
 const app=createApplication(options);t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});return {app,options,setTime:value=>at=value};
}
test('概览区分未运行、后台信号、真实接入机构与来源线索；读取不制造事件',t=>{
 const {app,setTime}=setup(t);let view=app.getOperationsOverview();
 assert.equal(view.today.status,'not_run');assert.equal(view.scheduler.status,'no_signal');
 assert.deepEqual(view.institutions.counts,{included:51,implemented:5,pending:46});assert.equal(view.discovery.length,1);
 const job=app.createJob({title:'首次入库',originalText:'模拟原文'});
 assert.equal(app.getOperationsOverview().changes.counts.added,1);assert.equal(app.getOperationalChanges({kind:'added'})[0].jobId,job.id);
 const before=app.getOperationalChanges();app.getOperationsOverview();assert.deepEqual(app.getOperationalChanges(),before);
 const tick=app.beginSchedulerActivity();setTime('2026-10-08T02:10:00Z');assert.equal(app.getOperationsOverview().scheduler.status,'checking');
 app.finishSchedulerActivity(tick,{status:'not_due',nextCheckAt:'2026-10-09T01:00:00Z'});assert.equal(app.getOperationsOverview().scheduler.status,'online');
 setTime('2026-10-08T02:14:00Z');assert.equal(app.getOperationsOverview().scheduler.status,'stale');
});
test('资格排除只移出可考虑表，失败不当结束，招聘汰换与恢复按日去重，历史转移未记录',t=>{
 const {app,setTime,options}=setup(t);
 app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'受控确认',quote:'本人最高已取得学历硕士'}}});
 const job=app.importJob({title:'模拟博士岗',originalText:'要求博士学历',knownConditions:['要求博士学历'],sourceIdentity:{sourceId:'efunds-social',externalId:'62fd32a72f9d2421b983ae01'},observedAt:'2026-10-08T02:00:00Z',recruitmentUnit:'易方达基金',evidenceUse:'current'}).job;
 const observed=(id,extra={})=>({id,sourceId:'efunds-social',externalId:'62fd32a72f9d2421b983ae01',observedAt:'2026-10-08T02:00:00Z',acquisition:'success',listComplete:true,listed:true,detailAccessible:true,applicationOpen:true,evidence:{url:'https://example.org/job',text:'模拟公开列示开放',quote:'公开列示开放'},...extra});
 app.recordRecruitmentObservation(job.id,observed('open'));
 app.evaluateEligibility(job.id);assert.equal(app.getOperationsOverview().changes.counts.left,1);assert.equal(app.getOperationsOverview().changes.counts.ended,0);assert.match(app.getOperationalChanges({kind:'left'})[0].reason,/要求博士/);
 app.updateMonitoringObject('seed-39',{monitoringStatus:'paused'});assert.equal(app.getOperationsOverview().changes.counts.left,1);
 app.updateMonitoringObject('seed-39',{monitoringStatus:'active'});
 app.recordRecruitmentObservation(job.id,observed('failed',{acquisition:'failed',listComplete:false,listed:false,applicationOpen:false,error:'受控失败'}));assert.equal(app.getOperationsOverview().changes.counts.ended,0);
 app.recordRecruitmentObservation(job.id,observed('missing',{observedAt:'2026-10-08T02:01:00Z',listed:false,detailAccessible:false,applicationOpen:false}));assert.equal(app.getOperationalChanges({kind:'suspected_offline'}).length,1);
 app.recordRecruitmentObservation(job.id,observed('restore',{observedAt:'2026-10-08T02:02:00Z'}));app.recordRecruitmentObservation(job.id,observed('missing-again',{observedAt:'2026-10-08T02:03:00Z',listed:false,detailAccessible:false,applicationOpen:false}));assert.equal(app.getOperationalChanges({kind:'suspected_offline'}).length,1);
 const other=createApplication(options);try{assert.equal(other.getOperationalChanges({kind:'left'}).length,1);}finally{other.close();}
 assert.equal(app.getOperationalChanges({date:'2026-10-07'}).length,0);setTime('2026-10-09T00:05:00Z');assert.equal(app.getOperationalChanges({kind:'left'}).length,0);assert.equal(app.getOperationsOverview().changes.counts.left,1);
});
test('最近手动来源失败独立于今日周期，重复缺口合并，后续成功解除当前异常',async t=>{
 const {app}=setup(t);const cycle=await app.runScheduledCycle();assert.equal(cycle.status,'partial');
 app.recordSourceCheck({id:'manual-latest',sourceId:'ccb-social',checkedAt:'2026-10-08T02:10:00Z',status:'failed',trigger:'manual',error:'受控重新登录',gaps:['受控重新登录','受控重新登录']});
 const view=app.getOperationsOverview();assert.equal(view.today.runId,cycle.id);assert.equal(view.exceptions.filter(x=>x.reason==='受控重新登录').length,1);
 app.recordSourceCheck({id:'manual-ok',sourceId:'ccb-social',checkedAt:'2026-10-08T02:11:00Z',status:'success',trigger:'manual',gaps:[]});assert.equal(app.getOperationsOverview().exceptions.some(x=>x.reason==='受控重新登录'),false);
});
test('每日完成与未运行、跨日补查及中断分开；7天记录不以调度信号代替检查',async t=>{
 const {app,setTime}=setup(t,{careerSource:{readCareerOverview:async()=>({id:'20000101000000-example',complete:true,text:'受控职业事实',windows:[]})}});
 for(const id of ['seed-01','seed-02','seed-04','seed-23','seed-39'])app.updateMonitoringObject(id,{monitoringStatus:'paused'});app.setDiscoveryMonitoring('beijing-sasac',false);
 const cycle=await app.runScheduledCycle();assert.equal(cycle.status,'completed');assert.equal(app.getOperationsOverview().today.status,'completed');
 setTime('2026-10-09T03:00:00Z');assert.equal(app.getOperationsOverview().today.status,'not_run');const next=await app.runScheduledCycle();assert.equal(next.date,'2026-10-09');assert.equal(app.getOperationsOverview().days[1].status,'completed');assert.equal(app.getOperationsOverview().days.length,7);
});
test('旧库初始化仅建存量基线，读取旧来源投影不补健康事件、候选或岗位变化',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const root=mkdtempSync(join(tmpdir(),'jh-legacy-')),databasePath=join(root,'data.sqlite'),options={databasePath,now:()=>new Date('2026-10-08T02:00:00Z'),announcementProcessor:null,matchingProcessor:null,careerSource:null};
 let seed=createApplication(options);const job=seed.createJob({title:'原有岗位',originalText:'要求博士',knownConditions:['要求博士']});seed.evaluateEligibility(job.id,{profile:{education:'硕士',version:'fixture'}});seed.close();
 const fixture=new DatabaseSync(databasePath);fixture.exec('DROP TABLE operational_state; DROP TABLE job_transitions;');fixture.prepare('INSERT INTO source_checks VALUES(?,?,?,?)').run('legacy','efunds-social',JSON.stringify({id:'legacy',sourceId:'efunds-social',status:'failed',checkedAt:'2026-10-07T02:00:00Z',gaps:['旧检查失败']}),'2026-10-07T02:00:00Z');fixture.close();
 const app=createApplication(options);t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(app.getOperationsOverview().changes.counts.left,0);assert.equal(app.getOperationalChanges({kind:'left'}).length,0);
 assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').latest.verification,'read_only_projection');assert.equal(app.listSourceHealthEvents().length,0);assert.equal(app.listSourceCandidates().length,0);assert.equal(app.getActionEvents().length,0);
 const oldDay=app.getOperationalChanges({date:'2026-10-07'});assert.deepEqual(oldDay,[]);assert.throws(()=>app.getOperationalChanges({date:'2026-02-30'}));
});

test('运行概览只输出覆盖摘要，完整来源原文与附件保留在详情入口',t=>{
 const {app}=setup(t);const raw='受控完整来源原文-不应传入概览';
 app.recordSourceCheck({id:'large-source',sourceId:'boc-social',checkedAt:'2026-10-08T02:00:00Z',status:'success',gaps:[],catalogCount:20,catalogComplete:true,catalogPages:[{raw}],platformListComplete:true,platformJobs:[{raw},{raw}],platformPages:[{raw}],announcements:[{raw,attachments:[{status:200,contentBase64:raw},{status:404}]}],jobIds:[]});
 const overview=app.getOperationsOverview(),latest=overview.sources.find(x=>x.id==='boc-social').latest;
 assert.deepEqual(latest.coverage,{catalogPages:1,platformPages:1,platformJobs:2,announcements:1,attachments:2,attachmentsObtained:1});assert.doesNotMatch(JSON.stringify(overview),new RegExp(raw));
 assert.doesNotMatch(JSON.stringify(app.getSourcesOverview()),new RegExp(raw));assert.match(JSON.stringify(app.getHistoryRecord('source_health_checks','large-source')),new RegExp(raw));assert.equal(latest.catalogCount,20);
});

test('本周变化按北京时间周一至周日累计，同岗位同类型去重，日查询仍保持原口径',t=>{
 const {app,setTime}=setup(t);
 setTime('2026-10-04T15:59:59Z');app.createJob({title:'上周日',originalText:'受控原文'});
 setTime('2026-10-04T16:00:00Z');const monday=app.createJob({title:'本周一',originalText:'受控原文'});
 setTime('2026-10-09T02:00:00Z');const friday=app.createJob({title:'本周五博士岗',originalText:'要求博士学历',knownConditions:['要求博士学历']});
 const profile=education=>app.saveQualificationProfile({facts:{education},sources:{education:{kind:'user',reference:'受控确认',quote:'最高已取得学历'+education}}});
 profile('硕士');app.evaluateEligibility(friday.id);
 setTime('2026-10-10T02:00:00Z');profile('博士');app.evaluateEligibility(friday.id);profile('硕士');app.evaluateEligibility(friday.id);
 setTime('2026-10-11T15:59:59Z');const week=app.getOperationsOverview().changes;
 assert.equal(week.period,'week');assert.equal(week.startDate,'2026-10-05');assert.equal(week.endDate,'2026-10-11');assert.equal(week.counts.added,2);assert.equal(week.counts.left,1);
 assert.deepEqual(new Set(app.getOperationalChanges({period:'week',kind:'added'}).map(x=>x.jobId)),new Set([monday.id,friday.id]));
 const left=app.getOperationalChanges({period:'week',kind:'left'});assert.equal(left.length,1);assert.equal(left[0].date,'2026-10-10');assert.match(left[0].reason,/要求博士/);
 assert.equal(app.getOperationalChanges({date:'2026-10-09',kind:'left'}).length,1);assert.equal(app.getOperationalChanges({date:'2026-10-10',kind:'left'}).length,1);
 assert.equal(app.getOperationalChanges({period:'week',date:'2026-10-12',kind:'added'}).length,0);
 const before=app.getOperationalChanges({period:'week'});app.getOperationsOverview();assert.deepEqual(app.getOperationalChanges({period:'week'}),before);assert.throws(()=>app.getOperationalChanges({period:'month'}));
 setTime('2026-10-11T16:00:00Z');assert.equal(app.getOperationsOverview().changes.startDate,'2026-10-12');assert.equal(app.getOperationsOverview().changes.counts.added,0);
});

test('周日备份补建成功后今日状态恢复，历史失败记录保持且旧备份不消除新失败',async t=>{
 const {app,setTime,options}=setup(t,{attachmentPython:join(tmpdir(),'nonexistent-backup-python'),careerSource:{readCareerOverview:async()=>({id:'20000101000000-example',complete:true,text:'受控职业事实',windows:[]})}});
 for(const id of ['seed-01','seed-02','seed-04','seed-23','seed-39'])app.updateMonitoringObject(id,{monitoringStatus:'paused'});app.setDiscoveryMonitoring('beijing-sasac',false);
 setTime('2026-10-11T02:00:00Z');const run=await app.runScheduledCycle();assert.equal(run.status,'partial');assert.equal(app.getOperationsOverview().today.status,'partial');
 const {existsSync}=await import('node:fs'),{resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??resolve('.runtime/attachment-venv/bin/python');assert.ok(existsSync(python));
 const recovery=createApplication({...options,attachmentPython:python});t.after(()=>recovery.close());setTime('2026-10-11T02:01:00Z');assert.equal((await recovery.createBackup()).status,'verified');
 const view=recovery.getOperationsOverview();assert.equal(view.today.status,'completed');assert.equal(view.today.historicalStatus,'partial');assert.equal(view.today.reconciledBackup,true);assert.equal(recovery.getScheduledRun(run.id).status,'partial');
 setTime('2026-10-11T02:02:00Z');assert.equal((await app.createBackup()).status,'failed');assert.equal(recovery.getOperationsOverview().today.status,'partial');
});
