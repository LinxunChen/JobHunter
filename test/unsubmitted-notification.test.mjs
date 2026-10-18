import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../src/application.mjs';

// Persisted legacy ledger fixture: the old release cancelled before transport.
// Reopen through the application boundary, exactly as a restart after upgrade.
function setup(t,{status='cancelled',category='pre_dispatch_cancelled',transportStartedAt=null,date='2026-10-15',send,followed=false}={}){
 const root=mkdtempSync(join(tmpdir(),'jobhunter-unsubmitted-')),databasePath=join(root,'test.sqlite');
 let app=createApplication({databasePath,now:()=>new Date(date+'T02:21:00Z')});
 let job;if(followed){job=app.createJob({title:'关注的软件岗位',originalText:'北京软件研发',evidenceUse:'current',location:{options:['北京']},applicationPath:{kind:'direct',url:'https://example.invalid/old'}});app.setPersonalState(job.id,{followed:true});}
 const draft=app.prepareDailyActions().dailyDigest;app.handoffNotificationDraft(draft.id,{attemptId:'old-attempt'});app.close();
 const db=new DatabaseSync(databasePath);
 const attempt={id:'old-attempt',deliveryId:draft.id,date,kind:'daily_digest',status,category,createdAt:date+'T02:21:00Z',finishedAt:date+'T02:22:00Z',queryHistory:[],...(transportStartedAt?{transportStartedAt}:{})};
 db.prepare('INSERT INTO notification_attempts VALUES(?,?)').run(attempt.id,JSON.stringify(attempt));
 db.prepare('INSERT INTO notification_deliveries VALUES(?,?)').run(draft.id,JSON.stringify({...draft,status,attemptIds:[attempt.id],draftId:draft.id,finalResult:'unknown'}));db.close();
 const requests=[];app=createApplication({databasePath,now:()=>new Date('2026-10-15T05:00:00Z'),notificationTransport:{enabled:true,simulated:true,send:async x=>{requests.push(x);return send?send(x):{code:200,shortCode:'recovered'};}}});
 t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});return {app,draft,attempt,requests,job};
}

test('当日明确发送前取消可恢复一次，旧尝试和正文保留、占用第二额度、接受后幂等',async t=>{
 const {app,draft,attempt,requests}=setup(t);
 const before=app.getNotificationDraft(draft.id);
 assert.equal(app.resumeUnsubmittedNotification(draft.id).status,'retry_wait');
 assert.equal(app.listNotificationWork().length,1);
 assert.equal((await app.sendNotification(draft.id)).status,'accepted');
 assert.equal(requests.length,1);assert.equal(requests[0].content,draft.htmlContent);
 assert.deepEqual(app.listNotificationAttempts()[0],attempt);assert.deepEqual(app.getNotificationDraft(draft.id),before);
 assert.equal(app.getNotificationStatus().usedAttempts,2);
 assert.equal(app.getNotificationDelivery(draft.id).attemptIds.length,2);
 assert.equal(app.getNotificationDelivery(draft.id).resumedUnsubmittedAt,'2026-10-15T05:00:00.000Z');
 assert.throws(()=>app.resumeUnsubmittedNotification(draft.id),/明确未提交/);
 await app.sendNotification(draft.id);assert.equal(requests.length,1);
});

test('明确未提交日报可显式刷新同一批岗位的当前入口，旧正文和旧尝试完整保留',async t=>{
 const {app,draft,attempt,requests,job}=setup(t,{followed:true});const frozen=app.getNotificationDraft(draft.id);
 app.correctJob(job.id,{field:'applicationPath',value:{kind:'direct',url:'https://example.invalid/new'},basis:{reason:'模拟官方入口更新'}});
 assert.throws(()=>app.resumeUnsubmittedNotification(draft.id),/当前岗位或个人状态已变化/);
 assert.equal(app.resumeUnsubmittedNotification(draft.id,{refreshContent:true}).status,'retry_wait');
 assert.equal((await app.sendNotification(draft.id)).status,'accepted');
 assert.match(requests[0].content,/https:\/\/example.invalid\/new/);assert.doesNotMatch(requests[0].content,/https:\/\/example.invalid\/old/);
 const delivery=app.getNotificationDelivery(draft.id);assert.equal(delivery.supersededContent.htmlContent,draft.htmlContent);
 assert.deepEqual(delivery.supersededContent.report,draft.report);assert.deepEqual(app.getNotificationDraft(draft.id),frozen);assert.deepEqual(app.listNotificationAttempts()[0],attempt);
});

test('显式刷新也不能跳过岗位集合变化或未知提交结果',t=>{
 const {app,draft,job}=setup(t,{followed:true});app.setPersonalState(job.id,{remindersPaused:true});
 assert.throws(()=>app.resumeUnsubmittedNotification(draft.id,{refreshContent:true}),/岗位集合已变化/);
 const unknown=setup(t,{status:'unknown'});assert.throws(()=>unknown.app.resumeUnsubmittedNotification(unknown.draft.id,{refreshContent:true}),/明确未提交/);
});

test('结果未知、已接受、已调用transport、跨日及普通取消都不能按未提交恢复',t=>{
 for(const options of [{status:'unknown',category:'network_or_timeout_acceptance_unknown'},{status:'accepted'}, {transportStartedAt:'2026-10-15T02:21:30Z'}, {date:'2026-10-14'}, {category:'service_rejected'}]){
  const {app,draft,requests}=setup(t,options);
  assert.throws(()=>app.resumeUnsubmittedNotification(draft.id),/明确未提交/);assert.equal(requests.length,0);
 }
});
