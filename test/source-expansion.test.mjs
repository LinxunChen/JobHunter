import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
const id='11111111-1111-4111-8111-111111111111';
const home='<title>北京银行股份有限公司</title><script>var BSGlobal = {"PortalId":"portal","Pages":[{"Name":"社会招聘列表页","Code":"SocialList","BusinessType":"1"}]};</script>';
const sourceFetch=async url=>new Response(String(url).includes('/api/')?JSON.stringify({Code:200,Count:1,Data:[{Id:id,CategoryId:'1',JobAdName:'数据研发岗',Duty:'建设数据平台',Require:'硕士以上',Status:1}]}):home,{status:200});
test('中信证券只读社招总部与分支完整列表，公开详情保留博士门槛，不将远期列示日期称为报名期限',async t=>{
 let models=0;const row={positionNo:'5449',deptNo:'25',deptName:'信息技术中心',positionName:'人工智能工程师',workplace:'北京、上海',reqendDate:'2033-01-01'};
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:{process:async()=>{models++;throw Error('不可调用');}},matchingProcessor:null,sourceFetch:async(url,options)=>{
  if(!String(url).includes('/api/'))return new Response('<title>中信证券招聘</title>');const p=new URLSearchParams(options.body);assert.equal(p.get('sysNo'),'CSE001');assert.equal(p.get('recruitType'),'05');
  return Response.json(String(url).endsWith('getPositionInfo')?{errorCode:0,type:'05',batchTitle:'2026年总部社会招聘',positionInfo:{...row,type:'社会招聘',positionDesc:'研发AI平台',qualification:'博士毕业，3年以上开发经验',isShow:1}}:{errorCode:0,count:p.get('deptype')==='Headquarter'?1:0,positionList:p.get('deptype')==='Headquarter'?[row]:[]});
 }});t.after(()=>app.close());const run=await app.checkExpanded_citics_social({postIds:['Headquarter:5449']});assert.equal(run.status,'success');assert.equal(run.listComplete,true);assert.equal(run.pages.length,2);assert.match(run.details[0].originalText,/博士毕业/);assert.equal(run.details[0].unit,'中信证券股份有限公司');assert.equal(run.details[0].applicationOpen,null);assert.equal(models,0);
});
test('中国结算混合公告保留正文社招岗位，明确已截止不调用模型',async t=>{
 const url='https://m.chinaclear.cn/zdjs/zgzh/202511/24b942b9ec7e40e0bdf42eb8730f239a.shtml';let models=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-12T00:00:00Z'),announcementProcessor:{process:async()=>{models++;throw Error('不可调用');}},matchingProcessor:null,sourceFetch:async u=>new Response(String(u)===url?'<div class="detailContent">中国证券登记结算有限责任公司2026年度招聘公告<br>一、校招岗位<br>二、社招岗位<br>应用系统开发岗：北京、硕士以上<br>简历接收截止时间为北京时间2025年11月28日17:00</div>':`<title>工作机会</title><a href="${url}">中国证券登记结算有限责任公司2026年度招聘公告</a>`)});t.after(()=>app.close());const run=await app.checkExpanded_chinaclear_notices({articleUrls:[url]});assert.equal(run.status,'success');assert.equal(run.listingWindowVerified,true);assert.equal(run.listComplete,false);assert.match(run.details[0].originalText,/二、社招岗位/);assert.equal(run.details[0].evidenceUse,'historical');assert.equal(models,0);
});
test('Moka公开社招完整分页与详情校验，范围外子公司和非北京岗位不进入模型',async t=>{
 let models=0;const row={id,orgId:'jsfund',title:'算法工程师',status:'open',hireMode:1,department:{name:'嘉实基金管理有限公司'},locations:[{cityId:110000,address:'北京'}]};
 const init={org:{id:'jsfund',name:'嘉实基金管理有限公司'},siteId:'44123',mode:'social',aesIv:'1234567890123456'};
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:{process:async()=>{models++;throw Error('测试未配置加工');}},matchingProcessor:null,sourceFetch:async(url,options)=>String(url).includes('/api/')?Response.json({code:0,success:true,data:String(url).endsWith('/job')?{...row,jobDescription:'岗位职责：开发算法\n任职要求：硕士以上'}:{jobs:[row],jobStats:{orgId:'jsfund',total:1}}}):new Response(`<input id="init-data" value="${JSON.stringify(init).replaceAll('"','&quot;')}">`)});t.after(()=>app.close());
 const run=await app.checkExpanded_jsfund_social({postIds:[id],processJobs:false});assert.equal(run.status,'success');assert.equal(run.listComplete,true);assert.equal(run.listCount,1);assert.match(run.details[0].originalText,/硕士以上/);assert.equal(run.details[0].applicationOpen,true);assert.equal(models,0);
 row.locations=[{cityId:310000,address:'上海'}];await app.checkExpanded_jsfund_social({postIds:[id]});assert.equal(models,0);
 row.department={name:'嘉实财富管理有限公司'};const outside=await app.checkExpanded_jsfund_social({postIds:[],listOnly:true});assert.equal(outside.scopeListCount,0);
});
test('邮储空社招栏目有明确模板和完整分页依据，结构变化不能冒充零岗位',async t=>{
 let empty=true;const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async()=>new Response(empty?'<meta name="ColumnName" content="社会招聘"><div class="col_list"><ul></ul></div><script>var countPage = 1;var currentPage = 0;</script>':'<div>系统错误</div>')});t.after(()=>app.close());
 const run=await app.checkExpanded_psbc_notices({articleUrls:[]});assert.equal(run.status,'success');assert.equal(run.listCount,0);assert.equal(run.listComplete,true);empty=false;assert.equal((await app.checkExpanded_psbc_notices()).status,'failed');
});
test('光大使用官方社招类别完整分页，报名截止而非网页展示期限决定跳过模型',async t=>{
 let models=0;const row={postId:123,recruitType:2,postName:'软件工程师',orgName:'总行',workPlace:'北京市',workConcet:'开发软件',serviceCondition:'硕士以上',signUpDeadline:'2025-10-01',endDate:'2027-10-01'};
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-11T12:00:00Z'),matchingProcessor:null,announcementProcessor:{process:async()=>{models++;throw Error('不可调用');}},sourceFetch:async url=>String(url).includes('/json/')?Response.json(String(url).endsWith('/detail')?{req_state:9200,postInfo:row}:{req_state:9200,page:1,rowSize:100,rowCount:1,pageCount:1,postList:[row]}):new Response('<title>中国光大银行社会招聘</title>')});t.after(()=>app.close());const run=await app.checkExpanded_cebbank_social({postIds:['123']});assert.equal(run.status,'success');assert.equal(run.listComplete,true);assert.equal(run.details[0].evidenceUse,'historical');assert.match(run.details[0].originalText,/2025-10-01/);assert.equal(models,0);
});
test('招商完整社招列表保留实际分支机构，子公司不混为银行，详情不含北京不调用模型',async t=>{
 let models=0,listOrganization;const row={publishGID:id.toUpperCase(),jobDisplay:'算法工程师',branchCodeName:'深圳分行',locationName:'深圳市',expiredOn:'2027-01-01',jobResponsibility:'开发算法',jobRequirement:'硕士以上'};
 const app=createApplication({databasePath:':memory:',expandedSources:true,matchingProcessor:null,announcementProcessor:{process:async()=>{models++;throw Error('不得调用');}},sourceFetch:async url=>String(url).includes('/api/')?Response.json({returnCode:'SUC0000',body:String(url).includes('getDetail')?row:{total:1,data:[{...row,branchCodeName:listOrganization??row.branchCodeName}]}}):new Response('<title>招商银行人才招聘</title>')});t.after(()=>app.close());const run=await app.checkExpanded_cmb_social({postIds:[row.publishGID]});assert.equal(run.status,'success');assert.equal(run.listComplete,true);assert.equal(run.details[0].unit,'招商银行 深圳分行');assert.equal(models,0);row.branchCodeName='招商银行研究院';listOrganization='总行招商银行研究院';assert.equal((await app.checkExpanded_cmb_social({postIds:[row.publishGID]})).status,'success');listOrganization=undefined;row.branchCodeName='招银金融租赁有限公司';assert.equal((await app.checkExpanded_cmb_social({postIds:[]})).scopeListCount,0);
});
test('扩展来源使用公共检查入口，持久发现去重，暂停停止请求，失败不清空',async()=>{
 let calls=0,fail=false;
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async(...args)=>{calls++;if(fail)throw Error('模拟网络失败');return sourceFetch(...args);}});
 try {
  assert.equal(app.listMonitoringObjects().find(x=>x.id==='seed-12').integrationStatus,'implemented');
  const r=await app.checkExpanded_bob_social({postIds:[],listOnly:true});assert.equal(r.status,'success');assert.equal(r.listCount,1);assert.equal(app.listSourceCandidates('bob-social').length,1);assert.equal(app.listJobs().length,0);
  // A selected detail/model failure never erases the already discovered candidate.
  fail=true;const failed=await app.checkExpanded_bob_social({postIds:[],listOnly:true});assert.equal(failed.status,'failed');assert.equal(app.listSourceCandidates('bob-social').length,1);
  app.updateMonitoringObject('seed-12',{monitoringStatus:'paused'});const before=calls;assert.equal((await app.checkExpanded_bob_social({postIds:[],listOnly:true})).status,'paused');assert.equal(calls,before);
 }finally{app.close();}
});
test('国家能源社招分页的同页重复链接与缺kinds参数按已核验栏目归一，跨页仍核对总数',async()=>{
 const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async(url,options)=>new Response(`<b>社会招聘</b><input name="kinds" value="3">共<b>2</b>条，共<b>2</b>页<a href="/annc/showgw?id=${options?.method==='POST'?second:first}${options?.method==='POST'?'':'&kinds=3'}">数据工程师</a>${options?.method==='POST'?`<a href="/annc/showgw?id=${second}">数据工程师</a>`:''}`,{status:200})});
 try{const run=await app.checkExpanded_energy_social({articleUrls:[],listOnly:true});assert.equal(run.status,'success');assert.equal(run.listCount,2);assert.equal(run.listComplete,true);assert.equal(app.listSourceCandidates('energy-social').length,2);}finally{app.close();}
});
test('共享平台保留真实主体，范围外不进入候选；未知日期和模型失败不造岗位',async()=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:{process:async()=>{throw Error('受控模型失败');}},matchingProcessor:null,sourceFetch:async url=>new Response(String(url).includes('GetJobAdInfo')?JSON.stringify({Code:200,Data:{Id:id,CategoryId:'1',JobAdName:'数据研发岗',Org:'投资银行业务线',Duty:'建设数据平台；任职要求：硕士以上',Require:'',EndTime:'2222-01-01',LocNames:['北京市']}}):String(url).includes('GetJobAdPageList')?JSON.stringify({Code:200,Count:1,Data:[{Id:id,CategoryId:'1',JobAdName:'数据研发岗',Org:'人保寿险有限公司'}]}):home,{status:200})});
 try {
  const outside=await app.checkExpanded_picc_social({postIds:[],listOnly:true});assert.equal(outside.listCount,1);assert.equal(outside.scopeListCount,0);assert.equal(app.listSourceCandidates('picc-social').length,0);
  const detail=await app.checkExpanded_csc_social({postIds:[id],processJobs:false});assert.equal(detail.status,'success');assert.equal(detail.details[0].unit,null);assert.equal(detail.details[0].department,'投资银行业务线');assert.equal(detail.details[0].applicationOpen,null);assert.doesNotMatch(detail.details[0].originalText,/2222/);assert.equal(detail.details[0].dateEvidence[0].raw,'2222-01-01');
  const fail=await app.checkExpanded_csc_social({postIds:[id]});assert.equal(fail.status,'partial');assert.match(fail.gaps.join(' '),/受控模型失败/);assert.equal(app.getSourcesOverview().sources.find(s=>s.id==='csc-social').latest.failureCategory,'processing');assert.equal(app.listJobs().length,0);assert.equal(app.listAnnouncements()[0].status,'failed');assert.equal(app.listNotificationAttempts().length,0);
 }finally{app.close();}
});
test('明确历史招聘批次的旧附件只留历史缺口，未知年份的附件缺失仍计当前失败',async t=>{
 let historical=true,modelCalls=0;
 const url='https://www.boc.cn/aboutboc/bi4/201907/t20190701_12345.html';
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-10T02:00:00Z'),matchingProcessor:null,announcementProcessor:{process:async()=>{modelCalls++;throw Error('不应加工附件不全的公告');}},sourceFetch:async target=>new Response(target===url?`<div class="TRS_Editor">中银金融科技招聘，详见附件<a href="/forms/old.xls">报名表.xls</a></div>`:`<script>createPageHTML(1,0,"index","html");</script><a href="${url}">中银金融科技有限公司${historical?'2019年':''}社会招聘公告</a>`,{status:200})});t.after(()=>app.close());
 const old=await app.checkExpanded_boc_fintech_notices({articleUrls:[url]});assert.equal(old.status,'success');assert.equal(old.details[0].evidenceUse,'historical');assert.match(old.businessGaps.join(' '),/历史.*附件/);assert.equal(old.gaps.length,0);assert.equal(modelCalls,0);assert.equal(app.listJobs().length,0);
 historical=false;const unknown=await app.checkExpanded_boc_fintech_notices({articleUrls:[url]});assert.equal(unknown.status,'partial');assert.equal(unknown.details[0].evidenceUse,'unverified');assert.match(unknown.gaps.join(' '),/格式未支持/);assert.equal(app.getSourcesOverview().sources.find(s=>s.id==='boc-fintech-notices').latest.failureCategory,'attachment');assert.equal(modelCalls,0);
});
test('浦发完整匿名分页保留社招范围，混合应届批次不进入候选',async()=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async url=>new Response(url.endsWith('socialJob')?'<script>var token="public-nonce";</script>':JSON.stringify({pageNo:1,totalRowCount:2,rowsDisplayed:10,rows:[{openningJobId:'123',positionName:'开发岗',recuitWay:'1',recuitType:'11'},{openningJobId:'456',positionName:'应届培养岗',recuitWay:'3',recuitType:'12'}]}),{status:200})});
 try{const r=await app.checkExpanded_spdb_social({postIds:[],listOnly:true});assert.equal(r.status,'success');assert.equal(r.listCount,2);assert.equal(r.scopeListCount,1);assert.deepEqual(app.listSourceCandidates('spdb-social').map(x=>x.externalId),['123']);}finally{app.close();}
});
test('新来源登记重启后生效，HTTP详情与设置共用入口，GET不采集，异步检查不发送',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{startServer}=await import('../src/server.mjs');const root=mkdtempSync(join(tmpdir(),'jh-expanded-')),databasePath=join(root,'db.sqlite');let calls=0;
 const initial=createApplication({databasePath,expandedSources:true,announcementProcessor:null,matchingProcessor:null});initial.close();
 const app=createApplication({databasePath,announcementProcessor:null,matchingProcessor:null,careerSource:null,sourceFetch:async(...args)=>{calls++;return sourceFetch(...args);}}),server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();rmSync(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+server.address().port;
 const overview=await(await fetch(base+'/api/operations')).json();assert.equal(overview.institutions.counts.implemented,41);assert.equal(overview.institutions.counts.pending,10);
 for(const path of ['/sources/bob-social','/api/sources/bob-social','/sources?integration=pending'])assert.equal((await fetch(base+path)).status,200);assert.equal(calls,0);
 const body=await(await fetch(base+'/sources?integration=pending')).text();assert.match(body,/本轮接入核验/);assert.match(body,/412访问校验/);assert.equal((await fetch(base+'/api/sources/not-real')).status,404);
 const started=await(await fetch(base+'/api/source-checks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceIds:['bob-social']})})).json();const finished=await app.waitForSourceCheck(started.id);assert.equal(finished.results[0].status,'success');assert.equal(app.listSourceCandidates('bob-social').length,1);assert.equal(app.listNotificationAttempts().length,0);
});
test('中移九天使用独立249目录与社招类型，不能用105九天研究院或校招代替',async()=>{
 const {readFileSync}=await import('node:fs');const contract=JSON.parse(readFileSync(new URL('./fixtures/cmri/public-query-contract.json',import.meta.url)));let mixed=false;
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,cmriFetch:async(url,input={})=>{
  const path=new URL(url).pathname;
  if(path==='/personal/job/index.html')return new Response('javascript:type(2); data["companyId"] data["type"] /js/job-center.js /js/job-module.js');
  if(path==='/js/job-center.js')return new Response(`prototype.pbkey="${contract.publicKey}";function getSecret(){var gs_str = '${contract.alphabet}';} curtime + secret`);
  if(path==='/js/job-module.js')return new Response('var recruitTypeJson = [{"code":"02","name":"社会招聘"}];');
  if(path.endsWith('getCompanyList.do'))return Response.json({code:'0000',data:{companyList:[{companyId:'249',shortName:'九天公司',type:3},{companyId:'105',shortName:'数智事业部（九天公司|九天研究院）',type:1}]}});
  const request=JSON.parse(input.body);assert.equal(request.data.companyId,249);assert.equal(request.data.type,2);return Response.json({code:'0000',data:{total:mixed?1:0,jobList:mixed?[{id:'campus',companyId:105,type:'1',name:'九天校招'}]:[]}});
 }});
 try{const r=await app.checkExpanded_jiutian_social({postIds:[],listOnly:true});assert.equal(r.status,'success');assert.equal(r.company.companyId,'249');assert.equal(r.listCount,0);mixed=true;const bad=await app.checkExpanded_jiutian_social({postIds:[],listOnly:true});assert.equal(bad.status,'failed');assert.equal(bad.listComplete,false);assert.equal(app.listJobs().length,0);}finally{app.close();}
});

test('官方JSON公告标题在正文之外时进入模型原文，不能把平台名补成雇主',async()=>{
 const title='模拟跨境工程师',url='https://www.nucc.com/article/123.json';let calls=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,matchingProcessor:null,sourceFetch:async target=>Response.json(target.endsWith('webGlobal.json')?{requestUrl:''}:target.endsWith('/article/join.json')?{code:0,data:{articleList:[{id:123,title,categoryId:1}]}}:target===url?{code:0,data:{article:{title,content:'<p>岗位职责：开发支付系统</p><p>任职要求：本科</p>'}}}:{}),announcementProcessor:{process:async({documents})=>{calls++;assert.match(documents[0].text,/官方栏目列示标题：模拟跨境工程师/);return {commonConditions:[],inputGaps:[],jobs:[{title,recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:[],duties:'开发支付系统',conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:title}],applicationPath:null,unknownFields:['雇主未披露'],dateEvidence:[]}]};}}});
 try{const run=await app.checkExpanded_nucc_recruitment({articleUrls:[url]});assert.equal(run.status,'success');assert.equal(app.listJobs().length,1);assert.equal(app.listJobs()[0].recruitmentUnit,null);assert.equal(calls,1);await app.checkExpanded_nucc_recruitment({articleUrls:[url]});assert.equal(calls,1);}finally{app.close();}
});
