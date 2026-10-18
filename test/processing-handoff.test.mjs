import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {updateNecessaryJobs} from '../src/necessary-jobs.mjs';
const at=()=>new Date('2026-10-12T05:00:00Z');
const title='大模型应用工程师',url='https://chinaamc.zhiye.com/szzwxq?jobId=190767079';
const text=`岗位：${title}\n工作地点：北京\n工作职责：研发大模型应用平台\n任职资格：本科以上\n截止时间：2026-12-31`;
const output={commonConditions:[],inputGaps:[],jobs:[{title,recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:['北京'],duties:'研发大模型应用平台',conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:title}],applicationPath:null,unknownFields:['招聘主体未披露'],dateEvidence:[]}]};
function setup(t){let matches=0;const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,announcementProcessor:{process:async()=>structuredClone(output)},matchingProcessor:{match:async()=>{matches++;throw Error('模拟匹配失败');}}});t.after(()=>app.close());app.saveCareerProfile({text:'模拟大模型研发资料',version:'v1',sourceId:'manual'});return {app,calls:()=>matches};}
test('独立补加工把官方开放事实交给招聘状态与自动匹配，不依赖再次跑来源',async t=>{
 const {app,calls}=setup(t);
 const a=await app.createAnnouncement({title,originalText:text,sourceUrl:url,jobIdentities:[{title,recruitmentUnit:null,department:null,batch:null,sourceIdentity:{sourceId:'ctyun-social',externalId:'6a88158c68cc6f624f61ef68'},observedAt:at().toISOString(),sourceEvidence:{listed:true,applicationOpen:true,checkedAt:at().toISOString()}}],targetJobs:[{title,recruitmentUnit:null,department:null,batch:null}]});
 const r=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});assert.equal(r.status,'processed');
 assert.equal(app.getJob(r.jobIds[0]).recruitmentStatus,'publicly_listed_open');
 await app.withModelBatch(()=>updateNecessaryJobs(app),{automatic:true});assert.equal(calls(),1);
 const before=app.getRecruitmentObservations(r.jobIds[0]).length;await app.processAnnouncement(a.id);assert.equal(app.getRecruitmentObservations(r.jobIds[0]).length,before);
});
test('已核验官方单岗URL的稳定编号可关联未知招聘主体，不冒造雇主',async t=>{
 const {app}=setup(t);const a=await app.createAnnouncement({title,originalText:text,sourceUrl:url,sourceIdentityContext:{sourceId:'chinaamc-social',externalId:url,observedAt:at().toISOString()}});
 app.recordAnnouncementProcessingObservation(a.id,{sourceUrl:url,title,checkedAt:at().toISOString(),applicationOpen:true,locations:['北京']});
 const r=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true}),j=app.getJob(r.jobIds[0]);
 assert.equal(j.sourceIdentities?.[0]?.externalId,'190767079');assert.equal(j.recruitmentUnit,null);assert.equal(j.recruitmentStatus,'publicly_listed_open');
 app.recordAnnouncementProcessingObservation(a.id,{sourceUrl:url,title,checkedAt:at().toISOString(),applicationOpen:false,locations:['北京']});
 await app.processAnnouncement(a.id);assert.notEqual(app.getJob(j.id).recruitmentStatus,'publicly_listed_open');
});
test('国资委新增策略不复查既有线索，开关切换保留策略，新线索仍可选',t=>{
 let clock='2026-10-12T04:00:00Z';const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 const run=(id,url)=>({id,sourceId:'beijing-sasac',checkedAt:clock,listComplete:true,listings:[{url,title:'集团北京软件技术人才招聘',listDate:'2026-10-12'}]});
 app.recordSourceCandidates(run('baseline','https://mp.weixin.qq.com/s/old'));
 clock='2026-10-12T05:00:00Z';app.setDiscoveryNewOnly('beijing-sasac');
 app.setDiscoveryMonitoring('beijing-sasac',false);app.setDiscoveryMonitoring('beijing-sasac',true);
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='beijing-sasac').due,false);
 clock='2026-10-12T06:00:00Z';app.recordSourceCandidates(run('new','https://mp.weixin.qq.com/s/new'));
 const plan=app.listRecruitmentReviewPlan();assert.equal(plan.find(x=>x.selectionId.endsWith('/old')).due,false);assert.equal(plan.find(x=>x.selectionId.endsWith('/new')).due,true);
});
test('普通公告、错域和多岗位不能以未知单位合成官方岗位身份',async t=>{
 const {officialRoleIdentity}=await import('../src/processing-handoff.mjs');
 for(const externalId of ['https://example.invalid/szzwxq?jobId=190767079','https://chinaamc.zhiye.com/other?jobId=190767079','https://chinaamc.zhiye.com/szzwxq?jobId=bad'])assert.equal(officialRoleIdentity({sourceId:'chinaamc-social',externalId}),null);
});
test('官方列表窗口缺席仍核验已发现岗位详情，独立复查覆盖招聘事实且不重跑模型',async t=>{
 let count=0,window=true,date='2026-12-31';const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,matchingProcessor:null,announcementProcessor:{process:async()=>{count++;return structuredClone(output);}},sourceFetch:async u=>{
  if(String(u).includes('/szzw/'))return new Response(`社会招聘<!-- <a href="?PageIndex=40">末页</a> --><a href="/szzwxq?jobId=${window?'190767079':'190111111'}">${window?title:'其他岗位'}</a>`);
  return new Response(`<div class="zwxq"><p>${title}</p><p>工作地点：北京</p><p>工作职责：研发大模型应用平台</p><p>任职资格：本科以上</p><p>截止时间：${date}</p></div><a id="apply" url="/Portal/Resume/ResumeItem?jid=190767079">立即申请</a>`);
 }});t.after(()=>app.close());
 const first=await app.withModelBatch(()=>app.checkExpanded_chinaamc_social({postIds:['190767079']}),{automatic:true});assert.equal(first.status,'success');assert.equal(first.listComplete,false);assert.equal(first.listingWindowVerified,true);assert.equal(count,1);const id=first.jobIds[0];assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');
 window=false;const refresh=await app.checkExpanded_chinaamc_social({postIds:['190767079'],processJobs:false});assert.equal(refresh.details.length,1);assert.equal(refresh.details[0].applicationOpen,true);assert.equal(count,1);assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');
 date='2027-01-31';await app.checkExpanded_chinaamc_social({postIds:['190767079'],processJobs:false});assert.equal(app.getRecruitmentState(id).dates.officialDeadline.value,'2027-01-31');
 date='2026-10-01';await app.checkExpanded_chinaamc_social({postIds:['190767079'],processJobs:false});assert.notEqual(app.getJob(id).recruitmentStatus,'publicly_listed_open');assert.equal(count,1);
});

test('截止日期和可访问详情本身不替代当前申请证据',async t=>{
 const {app}=setup(t);const a=await app.createAnnouncement({title,originalText:text,sourceUrl:url,sourceIdentityContext:{sourceId:'chinaamc-social',externalId:url,observedAt:at().toISOString()}});
 const result=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});assert.equal(app.getJob(result.jobIds[0]).recruitmentStatus,'unverified');
});
