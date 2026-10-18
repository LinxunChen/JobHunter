import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';
test('表格组合筛选、变化详情与异步HTTP，机构管理失败保留原值，GET全只读且不外呼',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jh-console-'));let calls=0;const blocked=async()=>{calls++;throw Error('受控来源失败');};
 const app=createApplication({databasePath:join(root,'data.sqlite'),announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked,now:()=>new Date('2026-10-08T02:00:00Z')});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(root,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}`;
 const object=app.createMonitoringObject({name:'受控<机构>',officialUrl:'https://example.org/clue'});app.updateMonitoringObject(object.id,{monitoringStatus:'paused'});
 const before={jobs:app.listJobs(),events:app.getActionEvents(),changes:app.getOperationalChanges(),checks:app.getSourcesOverview().sources.map(x=>x.history)};
 const filtered=await(await fetch(base+'/sources?q='+encodeURIComponent('受控')+'&integration=pending&monitoring=paused')).text();
 assert.match(filtered,/受控&lt;机构&gt;/);assert.equal([...filtered.matchAll(/data-object-id=/g)].length,1);assert.match(filtered,/data-check-sources="" disabled/);assert.match(filtered,/<dialog id="object-editor"/);
 const invalid=await fetch(base+'/api/monitoring-objects/'+object.id,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"bad","officialUrl":"javascript:alert(1)","monitoringStatus":"removed"}'});assert.equal(invalid.status,400);assert.equal(app.listMonitoringObjects().find(x=>x.id===object.id).name,'受控<机构>');
 for(const path of ['/sources','/api/operations','/api/job-changes','/sources/changes?kind=left','/assets/sources.js','/assets/sources.css'])assert.equal((await fetch(base+path)).status,200);
 assert.deepEqual({jobs:app.listJobs(),events:app.getActionEvents(),changes:app.getOperationalChanges(),checks:app.getSourcesOverview().sources.map(x=>x.history)},before);assert.equal(calls,0);
 const response=await fetch(base+'/api/source-checks',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"sourceIds":["efunds-social"]}'});assert.equal(response.status,202);const started=await response.json();await app.waitForSourceCheck(started.id);
 const result=await(await fetch(base+'/api/source-checks/'+started.id)).json();assert.equal(result.status,'partial');assert.equal(result.results[0].status,'failed');assert.equal(app.listNotificationAttempts().length,0);
 const form=await fetch(base+'/api/discovery/beijing-sasac',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"enabled":false}'});assert.equal(form.status,200);assert.equal(app.getSourceMonitoringStatus('beijing-sasac').enabled,false);
 assert.equal((await fetch(base+'/api/source-checks',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"send":true}'})).status,400);
});
test('SQLite保存中途失败回滚机构开关与待发状态，不留下半次暂停',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const root=mkdtempSync(join(tmpdir(),'jh-rollback-')),databasePath=join(root,'data.sqlite');
 const app=createApplication({databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null});t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});
 app.createJob({title:'受控记录',originalText:'回滚验证',recruitmentUnit:'中国银行'});app.prepareDailyActions();
 const fixture=new DatabaseSync(databasePath);fixture.exec("CREATE TRIGGER controlled_write_failure BEFORE UPDATE ON action_job_state BEGIN SELECT RAISE(ABORT,'controlled write failure'); END;");fixture.close();
 const before=app.getActionEvents();assert.throws(()=>app.updateMonitoringObject('seed-01',{monitoringStatus:'paused'}),/controlled write failure/);
 assert.equal(app.listMonitoringObjects().find(x=>x.id==='seed-01').monitoringStatus,'active');assert.deepEqual(app.getActionEvents(),before);
});

test('本周数字和点击明细同口径，周内跨日累计且旧日查询兼容',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jh-week-web-'));let at='2026-10-05T02:00:00Z',calls=0;const blocked=async()=>{calls++;throw Error('禁止外呼');};
 const app=createApplication({databasePath:join(root,'data.sqlite'),now:()=>new Date(at),announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked});
 const monday=app.createJob({title:'本周一岗位',originalText:'受控原文'});at='2026-10-09T02:00:00Z';const friday=app.createJob({title:'本周五岗位',originalText:'受控原文'});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(root,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}`;
 const before=app.getOperationalChanges({period:'week'}),html=await(await fetch(base+'/sources')).text();assert.match(html,/本周岗位变化/);assert.match(html,/2026-10-05 — 2026-10-11/);assert.match(html,/period=week&amp;kind=added|period=week&kind=added/);assert.doesNotMatch(html,/今日岗位变化/);
 const overview=await(await fetch(base+'/api/operations')).json(),items=await(await fetch(base+'/api/job-changes?period=week&kind=added')).json();assert.equal(overview.changes.counts.added,2);assert.equal(items.length,overview.changes.counts.added);assert.deepEqual(new Set(items.map(x=>x.jobId)),new Set([monday.id,friday.id]));
 const detail=await(await fetch(base+'/sources/changes?date=2026-10-09&period=week&kind=added')).text();assert.match(detail,/2026-10-05 — 2026-10-11/);assert.match(detail,/本周一岗位/);assert.match(detail,/本周五岗位/);
 const daily=await(await fetch(base+'/api/job-changes?date=2026-10-09&kind=added')).json();assert.deepEqual(daily.map(x=>x.jobId),[friday.id]);assert.equal((await fetch(base+'/api/job-changes?period=month')).status,400);
 const dayHtml=await(await fetch(base+'/sources/changes?date=2026-10-09&kind=added')).text();assert.doesNotMatch(dayHtml,/本周同岗位同类型只计一次/);assert.doesNotMatch(dayHtml,/本周一岗位/);
 assert.deepEqual(app.getOperationalChanges({period:'week'}),before);assert.equal(calls,0);
});
