import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCodexProcessor} from '../src/codex.mjs';
import {createApplication} from '../src/application.mjs';

function fixture() {
 const title='模拟基础设施研发专家';
 const clause='本科及以上， \ufeff\ufeff电子工程专业优先；';
 const originalText=`岗位：${title}\n工作职责：负责云平台研发\n任职条件：${clause}\n第二条：8年以上经验，原则上不得放宽。`;
 const ref=quote=>({documentId:'announcement',locator:'正文',quote});
 const output={commonConditions:[],inputGaps:[],jobs:[{title,recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:[],duties:'负责云平台研发',conditions:[{text:clause.replace(/\ufeff+/g,'\u0000'),evidence:[ref(clause.replace(/\ufeff+/g,'\u0000'))]}],evidence:[ref(title),ref('负责云平台研发')],applicationPath:null,unknownFields:[],dateEvidence:[]}]};
 return {title,clause,originalText,output};
}

test('公共加工入口恢复不可见字符变化的原文条件，offset仍指向未改动的原件',async t=>{
 const f=fixture(); const app=createApplication({databasePath:':memory:',announcementProcessor:{process:async()=>structuredClone(f.output)}});t.after(()=>app.close());
 const a=await app.createAnnouncement({title:f.title,originalText:f.originalText});
 const done=await app.processAnnouncement(a.id);
 assert.equal(done.status,'processed',done.error);
 assert.equal(done.originalText,f.originalText);
 const condition=app.getJob(done.jobIds[0]).conditions[0];
 assert.equal(condition.text,f.clause);
 assert.equal(condition.evidence[0].quote,f.clause);
 const {start,end}=condition.evidence[0];assert.equal(f.originalText.slice(start,end),f.clause);
});

test('不可见字符兼容仍拒绝实质文字改写、错误段落及原文映射歧义',async t=>{
 for(const mutate of [
  f=>{f.output.jobs[0].conditions[0].text='本科及以上， 电子工程专业必须；';f.output.jobs[0].conditions[0].evidence[0].quote=f.output.jobs[0].conditions[0].text;},
  f=>{f.output.jobs[0].conditions[0].evidence[0].locator='page:2';},
  f=>{f.originalText+='\n'+f.clause.replace(/\ufeff+/g,'\ufeff');},
 ]) {
  const f=fixture();mutate(f);
  const app=createApplication({databasePath:':memory:',announcementProcessor:{process:async()=>structuredClone(f.output)}});t.after(()=>app.close());
  const a=await app.createAnnouncement({title:f.title,originalText:f.originalText}),done=await app.processAnnouncement(a.id);
  assert.equal(done.status,'failed');assert.equal(app.listJobs().length,0);assert.ok(done.rejectedExtraction);
 }
});

test('同版本已完成的模型结果可通过公共入口复验，不调用模型或重复计用量，保留失败输出',async t=>{
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'jh-revalidation-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let calls=0;const databasePath=join(directory,'data.sqlite');
 const app=createApplication({databasePath,announcementProcessor:{process:async()=>{calls++;throw Error('不应调用模型');}}});t.after(()=>app.close());
 const a=await app.createAnnouncement({title:f.title,originalText:f.originalText});
 // Persist the historical failure shape at the real storage boundary.
 const failed={...a,status:'failed',error:'模型证据无法定位：announcement/正文',processingFailure:{stage:'validation'},processingReceipt:{completed:true,model:'synthetic'},rejectedExtraction:{contentVersion:a.contentVersion,output:f.output,error:'模型证据无法定位：announcement/正文'}};
 const db=new DatabaseSync(databasePath);t.after(()=>db.close());
 const seed=value=>db.prepare('UPDATE announcements SET body=? WHERE id=?').run(JSON.stringify(value),a.id);
 seed({...failed,rejectedExtraction:{...failed.rejectedExtraction,contentVersion:'stale'}});
 await assert.rejects(app.processAnnouncement(a.id,{revalidateSavedOutput:true}),/仅可复验/);
 seed({...failed,processingReceipt:{completed:false}});
 await assert.rejects(app.processAnnouncement(a.id,{revalidateSavedOutput:true}),/仅可复验/);
 seed(failed);const usage=app.getModelUsageSummary(),budget=app.getModelBudgetStatus();
 const done=await app.processAnnouncement(a.id,{revalidateSavedOutput:true});
 assert.equal(done.status,'processed',done.error);assert.equal(calls,0);
 assert.deepEqual(app.getModelUsageSummary(),usage);assert.deepEqual(app.getModelBudgetStatus(),budget);
 assert.deepEqual(done.processingReceipt,failed.processingReceipt);
 assert.deepEqual(done.savedOutputRevalidations[0].output,f.output);
 assert.equal(done.savedOutputRevalidations[0].newModelCall,false);
 assert.equal(done.steps.some(x=>x.step==='model_started'),false);
});

test('受控CLI只收到去掉BOM/NUL的证据视图，落盘条件及职责仍保留原件字符',async t=>{
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'jh-clean-evidence-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const command=join(directory,'synthetic-codex');
 f.originalText=f.originalText.replace('负责云平台研发','负责云平台\ufeff研发');
 f.output.jobs[0].conditions[0].text=f.clause.replace(/[\ufeff\u0000]/g,'');
 f.output.jobs[0].conditions[0].evidence[0].quote=f.output.jobs[0].conditions[0].text;
 writeFileSync(command,`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{if(/[\\ufeff\\u0000]/.test(input))process.exit(7);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(f.output))});console.log(JSON.stringify({type:'turn.completed'}));});
`,{mode:0o700});
 const app=createApplication({databasePath:join(directory,'data.sqlite'),announcementProcessor:createCodexProcessor({workingRoot:directory,command}),matchingProcessor:null});t.after(()=>app.close());
 const a=await app.createAnnouncement({title:f.title,originalText:f.originalText}),done=await app.processAnnouncement(a.id);
 assert.equal(done.status,'processed',done.error);const job=app.getJob(done.jobIds[0]);
 assert.equal(job.conditions[0].text,f.clause);assert.equal(job.duties,'负责云平台\ufeff研发');assert.equal(done.originalText,f.originalText);
});

test('证据定位失败归为项目抽取问题，页面给出可执行的修复说明',async()=>{
 const {classifyOperationIssue}=await import('../src/operation-issues.mjs');
 const issue=classifyOperationIssue('模型证据无法定位：announcement/正文');
 assert.equal(issue.category,'project');assert.equal(issue.code,'extraction_evidence');assert.match(issue.solution,/不可见字符/);
});
