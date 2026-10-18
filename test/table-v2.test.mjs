import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createApplication}from'../src/application.mjs';
import{startServer}from'../src/server.mjs';
async function setup(t){const dir=mkdtempSync(join(tmpdir(),'jh-table-v2-'));const app=createApplication({databasePath:join(dir,'data.sqlite'),announcementProcessor:null,matchingProcessor:null,now:()=>new Date('2026-10-08T01:00:00Z')});const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});});return{app,base:`http://127.0.0.1:${server.address().port}`};}

test('三页共用两表schema，表头筛选、短资格、官方入口与历史折叠不改变个人投递',async t=>{
 const{app,base}=await setup(t);app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟本人确认',quote:'硕士'}}});
 const job=app.createJob({title:'模拟博士岗位<script>',recruitmentUnit:'模拟单位',originalText:'博士学历',knownConditions:['博士学历'],location:{options:['中国-北京市-通州区','北京','上海市']},applicationPath:{kind:'direct',url:'https://example.invalid/apply'}});app.evaluateEligibility(job.id);app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);
 const history=app.createJob({title:'模拟历史岗',originalText:'历史岗位',evidenceUse:'historical'});app.setPersonalState(history.id,{followed:true});app.setApplied(history.id,true);
 for(const route of['/jobs','/followed','/applications']){
  const html=await(await fetch(base+route)).text();assert.match(html,/可考虑岗位/);assert.match(html,/<details[^>]*class="history-jobs"[^>]*>/);assert.match(html,/排除与历史/);assert.equal((html.match(/<table\b/g)??[]).length,2);
  assert.match(html,/<thead>[\s\S]*name="location"/);assert.match(html,/name="recommendation"/);assert.doesNotMatch(html,/class="job-filters"/);
  assert.match(html,/>模拟博士岗位&lt;script&gt;<\/a>/);assert.match(html,/href="https:\/\/example.invalid\/apply" target="_blank"/);assert.match(html,/北京、上海/);
  const row=html.match(new RegExp(`<tr data-job-row data-job-id="${job.id}">([\\s\\S]*?)</tr>`))[1];const cell=row.match(/<td data-job-column="eligibility">([\s\S]*?)<\/td>/)[1];assert.match(cell,/不满足/);assert.match(cell,/要求博士/);assert.doesNotMatch(cell,/<ul>|关键条件/);
  assert.match(html,/官方报名起止/);assert.match(html,/data-action="followed"/);assert.match(html,/data-action="applied"/);assert.doesNotMatch(html,/已确认：|公开列示开放（/);
 }
 assert.equal(app.listApplications(job.id).length,1);
});

test('HTTP资格表单保存本人事实、回读历史并重验岗位，非法来源不可写入',async t=>{
 const{app,base}=await setup(t);const job=app.createJob({title:'模拟岗位',originalText:'博士学历',knownConditions:['博士学历']});
 let response=await fetch(base+'/api/qualification-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'本人确认',quote:'最高学历硕士'}}})});assert.equal(response.status,201);
 assert.equal((await(await fetch(base+'/api/qualification-profile')).json()).facts.education,'硕士');assert.equal(app.getEligibility(job.id).status,'ineligible');
 const html=await(await fetch(base+'/qualification-profile')).text();assert.match(html,/name="education"/);assert.match(html,/来源与版本/);
 response=await fetch(base+'/api/qualification-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({facts:{education:'博士'}})});assert.equal(response.status,400);assert.equal(app.listQualificationProfiles().length,1);
});

test('组合筛选无结果时保留表头操作，不需要先清掉全部条件',async t=>{
 const{app,base}=await setup(t);app.createJob({title:'模拟北京岗位',originalText:'模拟原文',recruitmentUnit:'模拟单位'});
 const html=await(await fetch(base+'/jobs?unit=不存在&eligibility=verified')).text();assert.match(html,/没有匹配岗位，可调整表头条件/);assert.match(html,/<thead>[\s\S]*name="unit"/);assert.match(html,/name="eligibility"/);assert.equal((await(await fetch(base+'/api/jobs?unit=不存在&eligibility=verified')).json()).length,0);
});

test('三页可考虑表排除当前博士资格不符，待核验仍可查看且个人记录不丢失',async t=>{
 const{app,base}=await setup(t);app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'最高学历硕士'}}});
 const blocked=app.createJob({title:'模拟博士硬门槛岗',originalText:'博士学历',knownConditions:['博士学历']});app.evaluateEligibility(blocked.id);
 const pending=app.createJob({title:'模拟资格待确认岗',originalText:'计算机专业',knownConditions:['计算机专业']});app.evaluateEligibility(pending.id);
 for(const job of[blocked,pending]){app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);}
 for(const route of['/jobs','/followed','/applications']){
  const html=await(await fetch(base+route)).text();const active=html.match(/<tbody data-job-group="active">([\s\S]*?)<\/tbody>/)[1];
  assert.doesNotMatch(active,/模拟博士硬门槛岗/);assert.doesNotMatch(active,/模拟资格待确认岗/);assert.match(html.match(/<tbody data-job-group="pending">([\s\S]*?)<\/tbody>/)[1],/模拟资格待确认岗/);const history=html.match(/<tbody data-job-group="history">([\s\S]*?)<\/tbody>/)[1];assert.match(history,/模拟博士硬门槛岗/);assert.match(history,/资格不符：要求博士/);
  assert.match(html,/可考虑岗位/);assert.match(html,/排除与历史/);assert.doesNotMatch(html,/<details[^>]*class="history-jobs"[^>]*\bopen/);
 }
 const filtered=await(await fetch(base+'/jobs?eligibility=ineligible')).text();assert.match(filtered,/当前没有可考虑岗位，可展开“待核验岗位”或“排除与历史”查看/);assert.match(filtered,/模拟博士硬门槛岗/);assert.doesNotMatch(filtered,/模拟资格待确认岗/);
 assert.equal(app.getPersonalState(blocked.id).followed,true);assert.equal(app.getPersonalState(blocked.id).applied,true);assert.equal(app.listApplications(blocked.id).length,1);
 app.saveQualificationProfile({facts:{education:'博士'},sources:{education:{kind:'user',reference:'模拟资料更正',quote:'已取得博士'}}});
 assert.equal(app.listJobView().find(job=>job.id===blocked.id).display.group,'pending','资格事实更正后不继续用旧不符结论排除');
});

test('招聘主体未披露时显示原文已知的平台并保留待核验，单位筛选不冒充真实主体',async t=>{
 const{app,base}=await setup(t);
 const job=app.createJob({title:'数据应用与推广岗',department:'数据管理部',originalText:'官方社会招聘岗位\n招聘单位：未披露\n部门：数据管理部\n平台所属机构（不替代岗位招聘单位）：中信建投证券股份有限公司\n工作职责：客户数据标签建设',applicationPath:{kind:'steps',url:'https://example.invalid/detail',steps:'登录后填写简历'}});
 const display=app.listJobView().find(x=>x.id===job.id).display;
 assert.equal(display.unit.label,'中信建投证券股份有限公司（主体待核验）');
 assert.equal(app.getJob(job.id).recruitmentUnit,null);
 const html=await(await fetch(base+'/jobs?unit='+encodeURIComponent('中信建投'))).text();assert.match(html,/数据应用与推广岗/);assert.match(html,/中信建投证券股份有限公司（主体待核验）/);
 const title=html.match(/<td data-job-column="title">([\s\S]*?)<\/td>/)[1];assert.doesNotMatch(title,/subline/);assert.doesNotMatch(html,/data-job-column="detail"/);
 const explicit=app.createJob({title:'具体子公司岗位',recruitmentUnit:'明确子公司有限公司',originalText:'招聘单位：明确子公司有限公司\n平台所属机构（不替代岗位招聘单位）：集团公司'});
 assert.equal(app.listJobView().find(x=>x.id===explicit.id).display.unit.label,'明确子公司有限公司');
 const unknown=app.createJob({title:'未披露岗位',originalText:'主体未披露'});assert.equal(app.listJobView().find(x=>x.id===unknown.id).display.unit.label,'未披露');
});
