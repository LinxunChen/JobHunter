import test from 'node:test';import assert from 'node:assert/strict';import{createApplication}from'../src/application.mjs';
const parent='中国银行保险信息技术管理有限公司',unit='银保信科技（北京）有限公司',id='CC596117920J40843928905';
function setup(t,{badCompany=false,repeat=false,qualificationsOnly=false}={}){let models=0;const row={company:{companyNumber:'CZ596117920',slaveDisplayOrgName:parent},job:{jobNumber:id,title:'软件设计与开发岗',cityName:'北京',positionSourceType:1,url:'http://jobs.zhaopin.com/'+id+'.htm',detail:'【'+unit+'职位】<div>岗位职责：软件研发</div><div>岗位要求：三年经验</div>',jobCategories:[unit]}};if(qualificationsOnly)row.job.detail='岗位要求：本科计算机专业，熟悉软件开发。';const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:{process:async()=>{models++;throw Error('开放未确认不能加工');}},matchingProcessor:null,sourceFetch:async(url,options)=>{
 if(String(url).includes('index.html'))return new Response('<title>'+parent+'2026社会招聘</title>');
 const p=JSON.parse(options.body);
 if(String(url).endsWith('get-company-detail'))return Response.json({code:200,data:{companyBase:{companyNumber:badCompany?'wrong':'CZ596117920',authenticationState:1},businessInfo:{registeredName:parent}}});
 if(String(url).endsWith('search-job-list')){row.job.applyCount=(row.job.applyCount??0)+1;assert.equal(p.jobSource,1);assert.deepEqual(p.orgNumbers,['CZ596117920']);return Response.json({code:200,data:{jobList:repeat?[row,row]:[row],pageInfo:{pageIndex:1,pageSize:50,totalNum:repeat?2:1,totalPage:1}}});}
 assert.equal(p.jobNumber,id);return Response.json({code:200,data:row});
 }});t.after(()=>app.close());return{app,models:()=>models};}
test('智联社招专题核验招聘账号，完整读取；子公司以详情主体为准，不用母公司账号覆盖',async t=>{
 const{app,models}=setup(t);const run=await app.checkExpanded_cbit_social({postIds:[id]});assert.equal(run.status,'success');assert.equal(run.listCount,1);assert.equal(run.listComplete,true);assert.equal(run.details[0].unit,unit);assert.match(run.details[0].originalText,/三年经验/);assert.equal(run.details[0].applicationOpen,null);assert.equal(run.details[0].processingDecision.status,'needs_material');assert.equal(models(),0);assert.equal(app.listJobs().length,0);
});
test('智联招聘账号不符或重复分页不能算接入检查成功',async t=>{
 for(const options of [{badCompany:true},{repeat:true}]){const{app}=setup(t,options);const r=await app.checkExpanded_cbit_social({postIds:[]});assert.equal(r.status,'failed');assert.equal(r.listComplete,false);}
});

test('已保存的开放缺口按内容变化复查，列表统计波动不反复读取详情',async t=>{
 const{app}=setup(t);const first=await app.checkExpanded_cbit_social({postIds:[id]});
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='cbit-social'&&x.selectionId===id).due,false);
 await app.checkExpanded_cbit_social({postIds:[]});
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='cbit-social'&&x.selectionId===id).due,false);
 const next=structuredClone(first);next.id='next-list';next.details=[];next.checkedAt='2026-10-20T03:00:00Z';next.listings[0].raw.job.detail+='新增明确报名说明';
 app.recordSourceCandidates(next);
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='cbit-social'&&x.selectionId===id).due,true);
});


test('只有任职条件的技术相关标题仍明确缺职责，不因专业关键词视为完整技术岗位',async t=>{
 const{app,models}=setup(t,{qualificationsOnly:true});const r=await app.checkExpanded_cbit_social({postIds:[id]});assert.equal(r.status,'success');assert.equal(r.details[0].dutiesVerified,false);assert.match(r.details[0].processingDecision.reason,/职责/);assert.equal(models(),0);
});
