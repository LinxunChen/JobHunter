import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';
import {DatabaseSync} from 'node:sqlite';
import {classifyOperationIssue} from '../src/operation-issues.mjs';

test('建行接口的重新登录文案不能判定匿名详情不可读或要求本人登录',()=>{
 const issue=classifyOperationIssue('建行公开查询失败：暂时未能处理您的请求，请重新登录。');
 assert.equal(issue.code,'source_session');
 assert.doesNotMatch(issue.label,/拒绝匿名/);
 assert.match(issue.action,/浏览器与程序/);
 assert.match(issue.solution,/不能证明公开详情必须登录/);
 assert.match(issue.solution,/浏览器能打开时由项目修适配/);
});

function setup(t,extra={}) {
 const root=mkdtempSync(join(tmpdir(),'jh-settings-audit-'));let at='2026-10-11T07:00:00Z';
 const blocked=async()=>{throw Error('禁止真实外呼');};
 const options={databasePath:join(root,'data.sqlite'),now:()=>new Date(at),announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked,...extra};
 const app=createApplication(options);t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});return {app,options,setTime:value=>at=value};
}

test('同类岗位异常合并为问题组，分清模型与来源，每条原始问题保留解法，恢复后解除',t=>{
 const {app}=setup(t);
 for(const [sourceId,gaps] of [['boc-social',['岗位甲加工失败：Codex缺少成功完成事件','岗位乙加工失败：Codex缺少成功完成事件']],['efunds-social',['岗位加工失败：Codex调用失败：使用额度不足']],['beijing-sasac',['公众号访问验证，未取得正文/附件，不绕过验证码']],['ccb-social',['建行公开查询失败：暂时未能处理您的请求，请重新登录。']]])app.recordSourceCheck({id:sourceId+'-fault',sourceId,status:'partial',checkedAt:'2026-10-11T06:00:00Z',gaps});
 const view=app.getOperationsOverview();assert.equal(view.exceptionGroups.length,4);assert.equal(view.exceptionSummary.total,5);
 const model=view.exceptionGroups.find(x=>x.code==='model_incomplete');assert.equal(model.count,2);assert.equal(model.category,'project');assert.match(model.solution,/回执|事件流/);assert.ok(model.details.every(x=>x.solution&&x.reason));
 assert.equal(view.exceptionGroups.find(x=>x.code==='source_wechat').category,'source');
 app.recordSourceCheck({id:'boc-ok',sourceId:'boc-social',status:'success',checkedAt:'2026-10-11T06:10:00Z',gaps:[]});assert.equal(app.getOperationsOverview().exceptionGroups.some(x=>x.code==='model_incomplete'),false);
});

test('周期完成和来源问题分别展示，真实长任务返回当前来源及耗时，手动检查明确互斥',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve);const {app,setTime}=setup(t,{sourceFetch:async()=>{await wait;throw Error('受控访问失败');}});
 const running=app.runScheduledCycle();await new Promise(resolve=>setImmediate(resolve));setTime('2026-10-11T08:00:00Z');
 try{const o=app.getOperationsOverview();assert.equal(o.today.status,'running');assert.equal(o.today.progress.currentSourceId,'boc-social');assert.ok(o.today.progress.elapsedMinutes>=60);assert.match(o.today.displayLabel,/检查/);assert.equal(o.scheduler.status,'no_signal');const busy=app.startSourceCheck({sourceIds:['efunds-social']});assert.equal(busy.status,'busy');assert.ok(busy.runId);
  setTime('2026-10-11T16:10:00Z');const crossDay=app.getOperationsOverview();assert.equal(crossDay.today.status,'not_run');assert.equal(crossDay.busy.date,'2026-10-11');assert.equal(crossDay.busy.progress.currentSourceId,'boc-social');setTime('2026-10-11T08:00:00Z');}
 finally{release();await running;}
 const o=app.getOperationsOverview();assert.equal(o.today.status,'partial');assert.equal(o.today.displayLabel,'已完成，有待处理');assert.ok(o.today.sourceCounts.failed>0);
});

test('本周个人操作只记三个实际标记变更，撤销也算、幂等和其他操作不计，重启保留',t=>{
 const {app,setTime,options}=setup(t);const job=app.createJob({title:'受控岗位',originalText:'受控原文'});
 app.setPersonalState(job.id,{viewed:true,preparing:true});assert.equal(app.getOperationalChanges({period:'week',kind:'operated'}).length,0);
 app.setPersonalState(job.id,{followed:true});app.setPersonalState(job.id,{followed:true});
 app.setApplied(job.id,true);app.setApplied(job.id,false);setTime('2026-10-11T07:10:00Z');app.setPersonalState(job.id,{notInterested:true});
 const items=app.getOperationalChanges({period:'week',kind:'operated'});assert.equal(items.length,1);assert.match(items[0].reason,/排除/);assert.equal(app.getOperationsOverview().changes.counts.operated,1);
 const other=createApplication(options);try{assert.deepEqual(other.getOperationalChanges({period:'week',kind:'operated'}),items);}finally{other.close();}
 setTime('2026-10-11T16:00:00Z');assert.equal(app.getOperationsOverview().changes.counts.operated,0);app.setPersonalState(job.id,{notInterested:false});assert.equal(app.getOperationsOverview().changes.counts.operated,1);
});

test('操作历史写入失败时个人标记一同回滚，不留下未被统计的事实',t=>{
 const {app,options}=setup(t),job=app.createJob({title:'受控回滚岗位',originalText:'受控原文'}),db=new DatabaseSync(options.databasePath);t.after(()=>db.close());
 db.exec("CREATE TRIGGER reject_mark BEFORE INSERT ON personal_mark_events BEGIN SELECT RAISE(ABORT,'受控写入失败'); END");
 assert.throws(()=>app.setPersonalState(job.id,{followed:true}),/受控写入失败/);
 assert.equal(app.getPersonalState(job.id).followed,false);assert.equal(app.listPersonalMarkEvents().length,0);
 db.exec('DROP TRIGGER reject_mark');app.setPersonalState(job.id,{followed:true});assert.equal(app.getPersonalState(job.id).followed,true);assert.equal(app.getOperationsOverview().changes.counts.operated,1);
});

test('临期共用官方截止依据，七天内包含今日而排除八天、已过期、历史及排除岗位，GET不补事件',t=>{
 const {app}=setup(t);const ids=[];
 for(const [title,end,evidenceUse] of [['今日','2026-10-11','current'],['七天','2026-10-18','current'],['八天','2026-10-19','current'],['昨天','2026-10-10','current'],['历史','2026-10-14','historical'],['排除','2026-10-14','current']]){
  const quote='报名截止日期：'+end;const job=app.importJob({title,originalText:quote,evidenceUse,sourceIdentity:{sourceId:'efunds-social',externalId:'fixture-'+title},sourceUrl:'https://example.org/job',sourceEvidence:{listed:true},recruitmentStatus:'publicly_listed_open',dateEvidence:[{field:'deadline',raw:end,meaning:'explicit_deadline',evidence:[{quote}]}],observedAt:'2026-10-11T06:00:00Z'}).job;ids.push(job.id);if(title==='排除')app.setPersonalState(job.id,{notInterested:true});
 }
 const before=app.getActionEvents(),items=app.getOperationalChanges({period:'week',kind:'deadline'});assert.deepEqual(new Set(items.map(x=>x.jobId)),new Set(ids.slice(0,2)));assert.equal(app.getOperationsOverview().changes.counts.deadline,2);assert.deepEqual(app.getActionEvents(),before);
});

test('公共HTTP首页只显示三类变化、归类解法与在线说明，组合筛选不外呼，按钮禁用原因明确',async t=>{
 const {app}=setup(t);const object=app.createMonitoringObject({name:'受控待接入'});app.updateMonitoringObject(object.id,{monitoringStatus:'paused'});
 app.recordSourceCheck({id:'quota',sourceId:'efunds-social',status:'failed',checkedAt:'2026-10-11T06:00:00Z',error:'岗位加工失败：Codex调用失败：使用额度不足',gaps:[]});
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const html=await(await fetch(base+'/sources')).text();assert.match(html,/岗位操作/);assert.match(html,/岗位临期/);assert.doesNotMatch(html,/新确认结束|可考虑岗位进入|可考虑岗位移出/);assert.match(html,/模型服务/);assert.match(html,/额度/);assert.match(html,/补充招聘渠道/);assert.match(html,/data-check-feedback/);assert.match(html,/<button>搜索<\/button>/);assert.match(html,/接入后启用/);assert.match(html,/当前未采集/);
 const filtered=await(await fetch(base+'/sources?q='+encodeURIComponent('受控')+'&integration=pending&monitoring=paused')).text();assert.equal([...filtered.matchAll(/data-object-id=/g)].length,1);assert.match(filtered,/待接入，暂不能检查/);
 assert.equal((await(await fetch(base+'/api/job-changes?period=week&kind=operated')).json()).length,0);
});

test('无周期编号的来源锁显示实际占用，释放后公共页面恢复可检查',async t=>{
 const {app}=setup(t),lease=app.acquireSourceCheckLock();
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 try{const view=await(await fetch(base+'/api/operations')).json();assert.ok(view.busy);assert.equal(view.busy.runId,null);const html=await(await fetch(base+'/sources')).text();assert.match(html,/来源检查正在执行/);assert.doesNotMatch(html,/每日周期正在检查/);}
 finally{app.releaseSourceCheckLock(lease);}
 assert.equal((await(await fetch(base+'/api/operations')).json()).busy,null);assert.match(await(await fetch(base+'/sources')).text(),/立即检查只更新数据/);
});

test('批次暂停记录不算独立Codex失败，仍逐条保留未执行原因与解法',async t=>{
 const {app}=setup(t);app.recordSourceCheck({id:'deferred',sourceId:'boc-social',status:'partial',checkedAt:'2026-10-11T06:00:00Z',gaps:['岗位甲加工失败：Codex缺少成功完成事件','岗位乙加工失败：本批后续模型调用已暂停：Codex缺少成功完成事件','岗位丙加工失败：本批后续模型调用已暂停：Codex缺少成功完成事件']});
 const view=app.getOperationsOverview();const deferred=view.exceptionGroups.find(x=>x.code==='model_deferred');assert.equal(deferred?.count,2);assert.equal(deferred.category,'project');assert.match(deferred.label,/暂停|未执行/);assert.match(deferred.solution,/未.*调用|未执行/);assert.equal(view.exceptionGroups.find(x=>x.code==='model_incomplete').count,1);assert.equal(view.exceptionSummary.actualFailures,1);assert.equal(view.exceptionSummary.deferred,2);
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const html=await(await fetch('http://127.0.0.1:'+server.address().port+'/sources')).text();assert.match(html,/执行问题.*1|1.*执行问题/);assert.match(html,/未执行|未.*调用/);
});

test('今日概览采用同日后续来源复验，历史运行原样保留，跨日不追改',async t=>{
 const{app,options,setTime}=setup(t);const db=new DatabaseSync(options.databasePath);t.after(()=>db.close());
 const run={id:'day-reconciled',date:'2026-10-11',status:'partial',startedAt:'2026-10-11T06:00:00Z',finishedAt:'2026-10-11T06:10:00Z',sources:[{sourceId:'boc-social',name:'中国银行',status:'failed',checkId:'old-check',error:'旧结构错误',gaps:[]}],steps:[{key:'source:boc-social',status:'completed',finishedAt:'2026-10-11T06:05:00Z',result:{status:'failed'}},{key:'jobs',status:'completed',result:{status:'completed'}}],jobs:{status:'completed'},gaps:[]};db.prepare('INSERT INTO scheduled_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
 app.recordSourceCheck({id:'old-check',sourceId:'boc-social',status:'failed',checkedAt:'2026-10-11T06:00:00Z',error:'旧结构错误',gaps:[]});assert.equal(app.getOperationsOverview().today.sourceCounts.failed,1);
 app.recordSourceCheck({id:'fixed-check',sourceId:'boc-social',status:'success',checkedAt:'2026-10-11T06:30:00Z',gaps:[]});
 const server=await startServer({app,port:0});t.after(()=>new Promise(r=>server.close(r)));const view=await(await fetch(`http://127.0.0.1:${server.address().port}/api/operations`)).json();assert.equal(view.today.sourceCounts.failed,0);assert.equal(view.today.status,'completed');assert.equal(view.today.reconciledSourceCount,1);assert.equal(view.today.sources[0].checkId,'fixed-check');
 assert.equal(app.listRunSummaries({limit:1})[0].status,'partial');assert.equal(app.listRunSummaries({limit:1})[0].sources[0].checkId,'old-check');
 setTime('2026-10-11T16:30:00Z');const next=app.getOperationsOverview();assert.equal(next.days[1].status,'partial');assert.equal(next.days[1].sourceCounts.failed,1);
});
