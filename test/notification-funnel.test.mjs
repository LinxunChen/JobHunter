import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

test('只读消息预览展示今日漏斗，来源重试去重且首次入库独立于推荐卡片',t=>{
 let clock='2026-10-09T23:50:00Z';
 const app=createApplication({databasePath:':memory:',now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 for(const id of ['fa','fb','fc','fd','old','future'])app.registerSource({id,name:'模拟来源'+id,kind:'recruitment',scope:'模拟',monitoringObjectIds:['seed-01']});
 const check=(id,status,at,suffix='')=>app.recordSourceCheck({id:id+suffix,sourceId:id,status,checkedAt:at,listComplete:status!=='failed',gaps:status==='success'?[]:['模拟解析缺口']});
 check('fa','failed','2026-10-09T23:40:00Z','first');check('fa','success','2026-10-09T23:45:00Z','retry');
 check('fb','partial','2026-10-09T23:40:00Z');check('fc','failed','2026-10-09T23:40:00Z');check('fd','success','2026-10-09T23:40:00Z');
 check('old','success','2026-10-09T15:59:59Z');check('future','success','2026-10-10T01:00:00Z');
 const input={title:'模拟首次入库岗位',originalText:'负责算法开发',sourceIdentity:{sourceId:'fa',externalId:'job1'},evidenceUse:'current',observedAt:clock};
 app.importJob(input);app.importJob(input);
 app.importJob({...input,title:'模拟历史样本',sourceIdentity:{sourceId:'fa',externalId:'history'},evidenceUse:'historical'});
 const events=app.getActionEvents(),drafts=app.listNotificationDrafts();
 const preview=app.getNotificationPreview();
 assert.deepEqual(preview.runSummary.counts,{checkedSources:4,parsedSources:2,partialSources:1,failedSources:1,newJobs:1});
 assert.equal(preview.runSummary.date,'2026-10-10');
 assert.match(preview.content,/今日检查4个源 · 完整解析2个源 · 新增入库1个岗位/);
 assert.match(preview.content,/部分完成1个源 · 失败1个源/);
 assert.match(preview.htmlContent,/data-notification-section="system"/);assert.match(preview.htmlContent,/新增入库/);
 assert.match(preview.content,/今日无新增可考虑岗位/);
 assert.deepEqual(app.getActionEvents(),events);assert.deepEqual(app.listNotificationDrafts(),drafts);assert.equal(app.listNotificationAttempts().length,0);
 clock='2026-10-10T16:00:00Z';
 assert.deepEqual(app.getNotificationPreview().runSummary.counts,{checkedSources:0,parsedSources:0,partialSources:0,failedSources:0,newJobs:0});
 assert.match(app.getNotificationPreview().content,/尚无今日检查记录/);
});

test('草稿交接前更新漏斗，交接后冻结，HTTP只读预览反映当前累计而不重发',async t=>{
 const app=createApplication({databasePath:':memory:',now:()=>new Date('2026-10-10T02:00:00Z'),announcementProcessor:null,matchingProcessor:null});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});
 for(const id of ['fault','parsed','cross-day'])app.registerSource({id,name:'模拟'+id,kind:'recruitment',scope:'模拟',monitoringObjectIds:['seed-01']});
 for(const date of ['09','10'])app.recordSourceCheck({id:'fault'+date,sourceId:'fault',status:'failed',checkedAt:'2026-10-'+date+'T01:00:00Z',trigger:'scheduled',scheduledFor:'2026-10-'+date+'T01:00:00Z',gaps:['模拟来源不可用']});
 const draft=app.prepareDailyActions().dailyDigest;assert.equal(draft.runSummary.counts.checkedSources,1);
 app.recordSourceCheck({id:'parsed10',sourceId:'parsed',status:'success',checkedAt:'2026-10-10T01:30:00Z',gaps:[]});
 app.importJob({title:'模拟新增',originalText:'负责算法开发',sourceIdentity:{sourceId:'parsed',externalId:'new'},evidenceUse:'current',observedAt:'2026-10-10T01:30:00Z'});
 const held=app.handoffNotificationDraft(draft.id,{attemptId:'controlled-attempt'});
 assert.deepEqual(held.runSummary.counts,{checkedSources:2,parsedSources:1,partialSources:0,failedSources:1,newJobs:1});
 app.recordSourceCheck({id:'cross',sourceId:'cross-day',status:'partial',checkedAt:'2026-10-09T15:59:00Z',finishedAt:'2026-10-09T16:01:00Z',gaps:['模拟跨日处理缺口']});
 const before=app.getActionEvents();
 const base=`http://127.0.0.1:${server.address().port}`;
 const preview=await(await fetch(base+'/api/notification-preview')).json();
 assert.deepEqual(preview.runSummary.counts,{checkedSources:3,parsedSources:1,partialSources:1,failedSources:1,newJobs:1});
 assert.equal(preview.runSummary.date,'2026-10-10');
 const frozen=await(await fetch(base+'/api/notification-preview?id='+draft.id)).json();assert.equal(frozen.htmlContent,held.htmlContent);assert.deepEqual(frozen.runSummary,held.runSummary);
 assert.deepEqual(app.getActionEvents(),before);assert.equal(app.listNotificationAttempts().length,0);
});
