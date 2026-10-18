import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

const cases=[['190767079','大模型应用工程师'],['190819373','大模型算法工程师'],['190831259','智能投研研究员']];
const at=()=>new Date('2026-10-13T06:00:00Z');
const fixtures=new Map(cases.map(([id])=>[id,readFileSync(new URL(`./fixtures/recruitment-unit/${id}.html`,import.meta.url),'utf8')]));
const list='社会招聘'+cases.map(([id,title])=>`<a href="/szzwxq?jobId=${id}">${title}</a>`).join('');
const output=title=>({commonConditions:[],inputGaps:[],jobs:[{title,recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:['北京市'],duties:null,conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:title}],applicationPath:null,unknownFields:['招聘主体未披露','签约主体未披露'],dateEvidence:[]}]});
function setup(t,{databasePath=':memory:',html=fixtures,processor}={}){
 let models=0;
 const app=createApplication({databasePath,expandedSources:true,now:at,matchingProcessor:null,announcementProcessor:{process:async input=>{models++;return processor?processor(input):output(cases.find(([,title])=>input.documents[0].text.includes(title))[1]);}},sourceFetch:async address=>{
  const u=new URL(address);return new Response(u.pathname==='/szzwxq'?html.get(u.searchParams.get('jobId')):list);
 }});
 let closed=false;const close=()=>{if(!closed){closed=true;app.close();}};t.after(close);return {app,models:()=>models,close};
}

test('真实官网片段经公共来源检查、加工和Web展示保留三个岗位的招聘单位，即使模型遗漏',async t=>{
 const {app,models}=setup(t);
 const run=await app.checkExpanded_chinaamc_social({postIds:cases.map(x=>x[0])});
 assert.equal(run.status,'success');assert.equal(models(),3);assert.equal(app.listJobs().length,3);
 for(const job of app.listJobView()){
  assert.equal(job.recruitmentUnit,'华夏基金管理有限公司');assert.equal(job.display.unit.label,'华夏基金管理有限公司');assert.equal(job.contractingEntity,null);
  assert.ok(job.recruitmentUnitEvidence.quotes.some(x=>x.includes('在招聘过程中')));
  assert.match(app.getAnnouncement(job.announcementId).originalText,/版权所有：华夏基金管理有限公司/);
 }
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const html=await(await fetch(`http://127.0.0.1:${server.address().port}/jobs`)).text();assert.match(html,/华夏基金管理有限公司/);
 for(const job of app.listJobs()){const detail=await(await fetch(`http://127.0.0.1:${server.address().port}/jobs/${job.id}`)).text();assert.match(detail,/官网招聘单位依据/);assert.match(detail,/版权所有：华夏基金管理有限公司/);}
 const again=await app.checkExpanded_chinaamc_social({postIds:cases.map(x=>x[0])});assert.equal(again.status,'success');assert.equal(models(),3);assert.equal(app.listJobs().length,3);
});

test('旧记录只核验详情即可补齐单位，保留岗位ID、原文、个人操作和历史，重启后不造重复岗位',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jobhunter-unit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const {app,models,close}=setup(t,{databasePath:join(root,'jobs.sqlite')});
 const title=cases[0][1],url='https://chinaamc.zhiye.com/szzwxq?jobId='+cases[0][0];
 const a=await app.createAnnouncement({title,sourceUrl:url,originalText:title+'\n工作地点：北京市',sourceIdentityContext:{sourceId:'chinaamc-social',externalId:url,observedAt:at().toISOString()}});
 const processed=await app.processAnnouncement(a.id),id=processed.jobIds[0],before=app.getSourceJob(id);
 app.setPersonalState(id,{followed:true,notInterested:true});const personal=app.getPersonalState(id);const calls=models();
 const run=await app.checkExpanded_chinaamc_social({postIds:[cases[0][0]],processJobs:false});
 assert.equal(run.status,'success');assert.equal(app.getJob(id).recruitmentUnit,'华夏基金管理有限公司');assert.equal(models(),calls);
 assert.equal(app.getJob(id).originalText,before.originalText);assert.deepEqual(app.getPersonalState(id),personal);
 assert.equal(app.getJob(id).currentVersionId,before.currentVersionId);assert.equal(app.listJobs().length,1);
 assert.equal(app.getJobHistory(id).observations.filter(x=>x.type==='source_enrichment').length,1);
 close();
 const reopened=setup(t,{databasePath:join(root,'jobs.sqlite')});assert.equal(reopened.app.getJob(id).recruitmentUnit,'华夏基金管理有限公司');
 await reopened.app.checkExpanded_chinaamc_social({postIds:[cases[0][0]]});assert.equal(reopened.app.listJobs().length,1);assert.equal(reopened.app.listJobs()[0].id,id);
});

test('岗位显式子公司优先；仅站点品牌、版权、冲突或共享集团不补造招聘单位',async t=>{
 const id=cases[0][0],title=cases[0][1];
 const base=`<title>示例基金</title><div class="zwxq"><h2>${title}</h2><p>工作职责：研发</p><p>任职资格：本科</p><p>工作地点：北京市</p>{{unit}}</div><div class="footer"><p><span>版权所有：示例基金管理有限公司</span></p>{{statement}}</div>`;
 for(const [unit,statement,expected]of [
  ['','<p>示例基金在招聘过程中不会向求职者收取费用。</p>','示例基金管理有限公司'],
  ['<p>招聘单位：示例财富有限公司</p>','<p>示例基金在招聘过程中不会向求职者收取费用。</p>','示例财富有限公司'],
  ['','',null],
  ['<p>招聘单位：未披露</p>','<p>示例基金在招聘过程中不会向求职者收取费用。</p>',null],
  ['<p>招聘单位：示例财富有限公司</p><p>招聘单位：另家公司</p>','',null],
  ['<p>面向旗下子公司统一招聘</p>','<p>示例基金在招聘过程中不会向求职者收取费用。</p>',null],
  ['<p>指导外包完成项目开发，服务银行理财子公司客户</p>','<p>示例基金在招聘过程中不会向求职者收取费用。</p>','示例基金管理有限公司'],
  ['<p>所在部门：上海分公司</p>','<p>示例基金在招聘过程中不会向求职者收取费用。</p>','示例基金管理有限公司'],
 ]){
  const {app}=setup(t,{html:new Map([[id,base.replace('{{unit}}',unit).replace('{{statement}}',statement)]])});
  const run=await app.checkExpanded_chinaamc_social({postIds:[id],processJobs:false});assert.equal(run.status,'success');assert.equal(run.details[0].unit,expected);
 }
});

test('详情复查补齐不依赖source_processing缓存映射，也不覆盖已有不同招聘单位或人工纠正',async t=>{
 const {app}=setup(t),title=cases[0][1],url='https://chinaamc.zhiye.com/szzwxq?jobId='+cases[0][0];
 const originalText=title+'\n原文招聘单位：另家公司';
 const known=app.importJob({title,originalText,sourceUrl:url,recruitmentUnit:'另家公司',sourceIdentity:{sourceId:'chinaamc-social',externalId:cases[0][0]}}).job;
 const run=await app.checkExpanded_chinaamc_social({postIds:[cases[0][0]],processJobs:false});assert.equal(app.getJob(known.id).recruitmentUnit,'另家公司');assert.match(run.businessGaps.join(' '),/官网招聘单位与已存单位不一致/);
 const otherTitle=cases[1][1],otherUrl='https://chinaamc.zhiye.com/szzwxq?jobId='+cases[1][0];
 const corrected=app.importJob({title:otherTitle,originalText:otherTitle,sourceUrl:otherUrl,sourceIdentity:{sourceId:'chinaamc-social',externalId:cases[1][0]}}).job;
 app.correctJob(corrected.id,{field:'recruitmentUnit',value:'本人确认单位',basis:{reason:'模拟人工核对'}});
 await app.checkExpanded_chinaamc_social({postIds:[cases[1][0]],processJobs:false});
 assert.equal(app.getSourceJob(corrected.id).recruitmentUnit,'华夏基金管理有限公司');assert.equal(app.getJob(corrected.id).recruitmentUnit,'本人确认单位');assert.equal(app.listJobCorrections(corrected.id)[0].needsReview,false);
});

test('跨岗位、伪造引用、未来观察和较旧证据不能补齐或回退已保存单位',async t=>{
 const {app}=setup(t);const first=await app.checkExpanded_chinaamc_social({postIds:[cases[0][0]]});const job=app.getSourceJob(first.jobIds[0]);
 const proof=job.recruitmentUnitEvidence;
 for(const change of [{sourceUrl:'https://example.invalid/detail'},{title:'其他岗位'},{quotes:['原文没有的招聘声明']},{checkedAt:'2027-01-01T00:00:00Z'}])assert.throws(()=>app.recordJobRecruitmentUnitEvidence(job.id,{sourceId:'chinaamc-social',externalId:cases[0][0],evidence:{...proof,...change}}));
 const older={...proof,checkedAt:'2026-10-12T00:00:00Z'};
 assert.equal(app.recordJobRecruitmentUnitEvidence(job.id,{sourceId:'chinaamc-social',externalId:cases[0][0],evidence:older}).status,'historical');assert.equal(app.getSourceJob(job.id).recruitmentUnitEvidence.checkedAt,proof.checkedAt);
});

test('后续原文裁剪或模型再次漏字段，不丢失已核验单位也不产生重复岗位',async t=>{
 const html=new Map(fixtures),{app}=setup(t,{html,processor:input=>{
  const title=cases[0][1],result=output(title);if(input.documents[0].text.includes('版权所有'))result.jobs[0].recruitmentUnit='华夏基金管理有限公司';return result;
 }});
 const first=await app.checkExpanded_chinaamc_social({postIds:[cases[0][0]]}),id=first.jobIds[0];
 html.set(cases[0][0],`<div class="zwxq"><h2>${cases[0][1]}</h2><p>工作职责：研发新一代算法</p><p>任职资格：本科</p><p>工作地点：北京市</p></div>`);
 const next=await app.checkExpanded_chinaamc_social({postIds:[cases[0][0]]});assert.equal(next.status,'success');assert.equal(app.listJobs().length,1);assert.equal(next.jobIds[0],id);assert.equal(app.getJob(id).recruitmentUnit,'华夏基金管理有限公司');
});

test('模型误用官网母公司品牌时，岗位明确子公司证据优先，冲突结果拒绝入库',async t=>{
 const id=cases[0][0],title=cases[0][1],html=new Map([[id,fixtures.get(id).replace('<div class="zwxq">','<div class="zwxq"><p>招聘单位：示例财富有限公司</p>')]]);
 const {app}=setup(t,{html,processor:()=>{const result=output(title);result.jobs[0].recruitmentUnit='华夏基金管理有限公司';return result;}});
 const run=await app.checkExpanded_chinaamc_social({postIds:[id]});assert.equal(run.status,'partial');assert.match(run.gaps.join(' '),/模型招聘单位与已核验官网证据冲突/);assert.equal(app.listJobs().length,0);
});
