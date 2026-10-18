import test from 'node:test';import assert from 'node:assert/strict';import{createApplication}from'../src/application.mjs';import{readHtmlContentDiv}from'../src/boc-html.mjs';
test('公开正文合法属性与嵌套容器保持原字节和准确来源偏移',()=>{
 for(const attr of ['class=TRS_Editor','class="x TRS_Editor y"', "class='trs_editor_view'"]){
  const body='<p>正文</p><div><p>内层条件</p></div><table><tr><td>字段</td></tr></table>',html='<div class="nav">导航</div><div '+attr+'>'+body+'</div><footer>页脚</footer>';
  const r=readHtmlContentDiv(html,['TRS_Editor','trs_editor_view']);assert.equal(r.html,body);assert.equal(html.slice(r.sourceStart,r.sourceEnd),body);assert.doesNotMatch(r.html,/导航|页脚/);
 }
});
test('兴业分页漂移仅有限重读；恢复时完整，不恢复时保留覆盖缺口而不假称完整',async t=>{
 for(const recover of [true,false]){
  const row=n=>({positionId:String(1000000000000000000n+BigInt(n)),positionName:'软件开发岗',recruitType:'SR',positionStatus:'P',businessUnitDesc:'北京分行',firstBusinessUnitDesc:'北京分行'});
  let reads=0,models=0;
  const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:{process:async()=>{models++;throw Error('不可调用');}},matchingProcessor:null,sourceFetch:async(url,opt)=>{
   if(String(url).endsWith('/portal/'))return new Response('<title>兴业招聘官网</title>');
   const p=JSON.parse(opt.body).pagination.pageIndex,sweep=Math.floor(reads++/3);
   const start=p===1?1:p===2?101:201,list=Array.from({length:p===3?1:100},(_,i)=>row(start+i));
   if(p===2&&(!recover||sweep===0))list[0]=row(100);
   return Response.json({code:'0000',data:{total:201,list}});
  }});t.after(()=>app.close());const r=await app.checkExpanded_cib_social({postIds:[],processJobs:false});
  assert.equal(reads,6);assert.equal(models,0);assert.equal(r.paginationRecovery.complete,recover);assert.equal(r.listComplete,recover);assert.equal(r.listCount,recover?201:200);assert.equal(r.status,recover?'success':'partial');
  if(!recover)assert.match(r.gaps.join(''),/覆盖未完整/);
 }
});
test('中信组织名差异必须有官方父机构编码证明；不能只放宽字符串比较',async t=>{
 for(const proven of [true,false]){
  const rows=[{ID:5864,RELEASENAME:'软件开发岗',CONTENT:'镇江分行',WORKADDR:'江苏镇江市',BRANCH_DEPT_CODE:'1012',DEPT_CODE:'1012032'},...(proven?[{ID:5865,RELEASENAME:'产品岗',CONTENT:'南京分行',DEPT_CODE:'1012'}]:[])];
  const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async(url,opt)=>{
   if(String(url).includes('clubRecruit.html'))return new Response('/recruitportal/portal/recruitQuery recruitmentType: "01"');
   if(String(url).endsWith('recruitQuery'))return Response.json({IsSuc:true,pageCount:rows.length,tableData:{rows:rows.map(itemMap=>({itemMap}))}});
   return Response.json({IsSuc:true,data:{itemMap:{ID:5864,RELEASENAME:'软件开发岗',DEPT_ID:'南京分行',BRANCH_DEPT_CODE:'1012',SH_ZZ:'研发软件系统',SH_YQ:'本科'}}});
  }});t.after(()=>app.close());const r=await app.checkExpanded_citicbank_social({postIds:['5864'],processJobs:false});
  assert.equal(r.status,proven?'success':'partial');assert.equal(r.details.length,proven?1:0);
  if(proven)assert.equal(r.organizationRelations[0].parentCode,'1012');else assert.match(r.gaps[0],/机构身份不一致/);
 }
});
