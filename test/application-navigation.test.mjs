import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

async function setup(t){const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null});const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});return {app,base:`http://127.0.0.1:${server.address().port}`};}
function titleCell(html,id){return html.match(new RegExp(`<tr data-job-row data-job-id="${id}">[\\s\\S]*?<td data-job-column="title">([\\s\\S]*?)</td>`))?.[1];}
test('未取得独立投递链接的待匹配岗，三页标题统一打开该岗官方原文，浏览不改变个人标记',async t=>{
 const {app,base}=await setup(t),url='https://example.invalid/recruitment?jobId=123';
 const job=app.createJob({title:'算法开发岗',originalText:'负责算法开发',sourceUrl:url,location:{options:['北京']}});app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);
 const before=app.getPersonalState(job.id),applications=app.listApplications(job.id);
 for(const path of ['/jobs','/followed','/applications']){
  const html=await (await fetch(base+path)).text(),cell=titleCell(html,job.id);
  assert.match(cell,/href="https:\/\/example.invalid\/recruitment\?jobId=123"/);assert.doesNotMatch(cell,/href="\/jobs\//);assert.match(cell,/官方原文/);
 }
 assert.equal(app.getJob(job.id).applicationPath,null);assert.deepEqual(app.getPersonalState(job.id),before);assert.deepEqual(app.listApplications(job.id),applications);
});
test('申请直达、邮箱和步骤优先原文；全部入口缺失时标题不可假装可点击',async t=>{
 const {app,base}=await setup(t),sourceUrl='https://example.invalid/notice';
 const paths=[{kind:'direct',url:'https://example.invalid/apply'},{kind:'email',email:'jobs@example.invalid'},{kind:'steps',url:'https://example.invalid/portal',steps:'搜索算法工程师并申请。'},{kind:'announcement',steps:'按公告下载表格并线下报名。'}];
 const jobs=paths.map((applicationPath,i)=>app.createJob({title:'算法岗'+i,originalText:'负责算法研发',sourceUrl,applicationPath}));
 const missing=app.createJob({title:'未知入口算法岗',originalText:'算法研发'}),html=await(await fetch(base+'/jobs')).text();
 for(const [i,target] of ['https://example.invalid/apply','mailto:jobs@example.invalid','https://example.invalid/portal',sourceUrl].entries())assert.ok(titleCell(html,jobs[i].id).includes('href="'+target+'"'));
 assert.doesNotMatch(titleCell(html,missing.id),/<a\b/);assert.match(titleCell(html,missing.id),/入口未披露/);
});
