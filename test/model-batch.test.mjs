import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';

const ids=Array.from({length:5},(_,i)=>`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`);
const home='<script>var BSGlobal = {"PortalId":"portal","Pages":[{"Name":"社会招聘列表页","Code":"SocialList","BusinessType":"1"}]};</script>';
const sourceFetch=async url=>{
 const parsed=new URL(url),id=parsed.searchParams.get('jobAdId');
 return new Response(parsed.pathname.includes('GetJobAdInfo')?JSON.stringify({Code:200,Data:{Id:id,CategoryId:'1',JobAdName:'岗位'+ids.indexOf(id),Duty:'受控建设数据平台\n报名截止时间：2026-12-31',Require:'硕士以上',LocNames:['北京'],EndTime:'2026-12-31'}}):parsed.pathname.includes('GetJobAdPageList')?JSON.stringify({Code:200,Count:ids.length,Data:ids.map((Id,i)=>({Id,CategoryId:'1',JobAdName:'岗位'+i}))}):home);
};
for(const [category,message,expected] of [['quota','Codex调用失败：使用额度不足',1],['configuration','Codex调用失败：请求或输出结构配置无效',1],['connection','Codex调用失败：连接中断',3],['unknown','Codex缺少成功完成事件',3],['protocol','Codex返回未知事件类型',3]])test(`批次${category}失败停止重复模型调用，所有选中原文保留、任务可再次重试`,async()=>{
 let calls=0;const processor={process:async()=>{calls++;const error=Error(message);error.receipt={completed:false,failureCategory:category};throw error;}};
 const app=createApplication({databasePath:':memory:',expandedSources:true,sourceFetch,announcementProcessor:processor,matchingProcessor:null,careerSource:null});
 try {
  const result=await app.checkExpanded_bob_social({postIds:ids});assert.equal(result.status,'partial');assert.equal(calls,expected);assert.equal(result.details.length,5);assert.equal(app.listAnnouncements().length,5);assert.equal(app.listJobs().length,0);assert.equal(app.listNotificationAttempts().length,0);assert.equal(app.listAnnouncements().filter(x=>x.status==='deferred').length,5-expected);assert.match(result.businessGaps.join(' '),/等待模型执行恢复/);
  await app.checkExpanded_bob_social({postIds:[ids[0]]});assert.equal(calls,expected+1);
 }finally{app.close();}
});

test('公共异步任务跨来源共用失败保护，原文获取继续，不调用职业资料、发送或备份',async()=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,sourceFetch,announcementProcessor:{process:async()=>{calls++;const error=Error('Codex调用失败：使用额度不足');error.receipt={completed:false,failureCategory:'quota'};throw error;}},matchingProcessor:null,careerSource:null});
 try {
  for(const id of ['bob-social','csc-social'])app.setSourceSettings(id,{postIds:ids.slice(0,2)});
  const task=app.startSourceCheck({sourceIds:['bob-social','csc-social']});const done=await app.waitForSourceCheck(task.id);assert.equal(done.status,'partial');assert.equal(done.results.length,2);assert.equal(calls,1);assert.equal(app.listAnnouncements().length,4);assert.equal(app.listBackups().length,0);assert.equal(app.listNotificationAttempts().length,0);assert.equal(app.listCareerProfiles().length,0);
 }finally{app.close();}
});
