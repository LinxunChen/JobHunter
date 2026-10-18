import test from 'node:test';import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
const header='<tr><td>职位名称</td><td>部门</td><td>工作地点</td></tr>',rows='<tr><td>软件工程师</td><td>研发部</td><td>北京</td></tr><tr><td>软件工程师</td><td>研发部</td><td>上海</td></tr><tr><td>客户经理</td><td>销售部</td><td>北京</td></tr>';
const html=`<title>中国航信社会招聘</title><table><tr><td><table>${header}${rows}</table></td></tr></table>`;
test('官方岗位矩阵稳定区分同名异地岗位，保留原字段，缺材料不用模型',async t=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;throw Error('不能调用');}},sourceFetch:async()=>new Response(html)});t.after(()=>app.close());
 const list=await app.checkExpanded_travelsky_social({postIds:[]});assert.equal(list.status,'success');assert.equal(list.listCount,3);assert.equal(list.listComplete,true);assert.equal(new Set(list.listings.map(x=>x.externalId)).size,3);
 const candidate=app.listSourceCandidates('travelsky-social').find(x=>x.title==='软件工程师'&&x.raw.locations[0]==='北京');assert.ok(candidate);
 const run=await app.checkExpanded_travelsky_social({postIds:[candidate.externalId]});assert.equal(run.status,'success');assert.equal(run.details[0].dutiesVerified,false);assert.equal(run.details[0].applicationOpen,null);assert.equal(run.details[0].processingDecision.status,'needs_material');assert.equal(calls,0);assert.equal(app.listJobs().length,0);
 assert.equal(app.listSourceCandidates('travelsky-social').filter(x=>x.status==='excluded').length,2);
});
test('官方矩阵缺列或重复身份报明确结构错误，不伪装无岗位',async t=>{
 for(const table of ['<table><tr><td>职位名称</td><td>地点</td></tr></table>',`<table>${header}${rows}${rows}</table>`]){
  const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async()=>new Response('<title>中国航信社会招聘</title>'+table)});t.after(()=>app.close());
  const run=await app.checkExpanded_travelsky_social({postIds:[]});assert.equal(run.status,'failed');assert.match(run.error,/岗位表|重复/);
 }
});
