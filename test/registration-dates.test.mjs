import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

test('官方报名开始与发布分别保存，失败不覆盖日期，重启保留起止精度及延期历史', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-registration-'));
  const options = { databasePath: join(dir, 'jobs.sqlite'), matchingProcessor: null, announcementProcessor: null,
    now: () => new Date('2026-10-08T01:00:00Z') };
  let app = createApplication(options);
  t.after(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });
  const job = app.importJob({ title: '模拟算法岗', originalText: '模拟官方岗位', sourceIdentity: { sourceId: 'demo', externalId: 'one' }, observedAt: '2026-10-08T00:00:00Z' }).job;
  const evidence = { url: 'https://example.invalid/job', text: '报名开放', quote: '报名开放' };
  const date = raw => ({ raw, evidence: { ...evidence, text: `官方报名日期${raw}`, quote: raw } });
  const observation = { sourceId: 'demo', externalId: 'one', observedAt: '2026-10-08T00:00:00Z', acquisition: 'success', listComplete: true, listed: true, applicationOpen: true, evidence };
  app.recordRecruitmentObservation(job.id, { ...observation, start: date('2026-10-01T10:30:00+08:00'), deadline: date('2026-10-10'), published: date('2026-09-20') });
  let state = app.getRecruitmentState(job.id);
  assert.equal(state.dates.officialStart.value, '2026-10-01T02:30:00.000Z');
  assert.equal(state.dates.officialStart.precision, 'instant');
  assert.equal(state.dates.officialDeadline.precision, 'day');
  assert.equal(state.dates.published.value, '2026-09-20');
  app.recordRecruitmentObservation(job.id, { ...observation, observedAt: '2026-10-08T00:30:00Z', acquisition: 'failed', start: date('2026-10-07') });
  app.recordRecruitmentObservation(job.id, { ...observation, observedAt: '2026-10-08T00:40:00Z', deadline: date('2026-10-12') });
  app.close(); app = createApplication(options); state = app.getRecruitmentState(job.id);
  assert.equal(state.dates.officialStart.value, '2026-10-01T02:30:00.000Z');
  assert.equal(state.dates.officialDeadline.value, '2026-10-12');
  assert.equal(state.dates.deadlineHistory.at(-1).change, 'extended');
});

test('只有明确报名开始语义可展示，未核验平台起止和远年占位不参与日期判断', t => {
 const dir=mkdtempSync(join(tmpdir(),'jh-registration-evidence-'));const app=createApplication({databasePath:join(dir,'data.sqlite'),matchingProcessor:null,announcementProcessor:null});
 t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});
 const originalText='发布日期2026-09-01，报名开始2026-10-01，平台截止3000-01-01。';
 const ref=quote=>({documentId:'manual',locator:'正文',quote});
 const job=app.importJob({title:'模拟日期岗位',originalText,sourceUrl:'https://example.invalid/job',sourceIdentity:{sourceId:'demo',externalId:'dates'},observedAt:'2026-10-08T01:00:00Z',dateEvidence:[
 {field:'start',raw:'2026-10-01',meaning:'explicit_registration_start',evidence:[ref('报名开始2026-10-01')]},
 {field:'publish',raw:'2026-09-01',meaning:'explicit_publish_date',evidence:[ref('发布日期2026-09-01')]},
 {field:'endDate',raw:'3000-01-01',meaning:'unverified',evidence:[ref('平台截止3000-01-01')]}]}).job;
 const dates=app.getRecruitmentState(job.id).dates;assert.equal(dates.officialStart.value,'2026-10-01');assert.equal(dates.published.value,'2026-09-01');assert.equal(dates.officialDeadline,null);
 const evidence={url:'https://example.invalid/job',text:'截止3000-01-01',quote:'3000-01-01'};
 assert.throws(()=>app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:'dates',observedAt:'2026-10-08T01:00:00Z',acquisition:'success',evidence,deadline:{raw:'3000-01-01',evidence}}),/占位/);
});

test('明确截止已过且官方投递关闭显示已结束，来源失败不推翻；后续开放与过期冲突仍待确认',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jh-deadline-closed-'));const app=createApplication({databasePath:join(dir,'data.sqlite'),announcementProcessor:null,matchingProcessor:null,now:()=>new Date('2026-10-08T01:00:00Z')});t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});
 const job=app.importJob({title:'模拟已截止岗位',originalText:'模拟官方原文',sourceIdentity:{sourceId:'demo',externalId:'expired'},observedAt:'2026-10-08T00:00:00Z'}).job;
 const evidence={url:'https://example.invalid/expired',text:'报名截止2026-10-07',quote:'2026-10-07'},base={sourceId:'demo',externalId:'expired',observedAt:'2026-10-08T00:00:00Z',acquisition:'success',listComplete:true,listed:true,evidence};
 app.recordRecruitmentObservation(job.id,{...base,applicationOpen:false,deadline:{raw:'2026-10-07',evidence}});assert.equal(app.listJobView()[0].display.recruitment.label,'已结束');assert.equal(app.listJobView()[0].display.group,'history');
 app.recordRecruitmentObservation(job.id,{...base,observedAt:'2026-10-08T00:10:00Z',acquisition:'failed'});assert.equal(app.getRecruitmentState(job.id).status,'ended');
 app.recordRecruitmentObservation(job.id,{...base,observedAt:'2026-10-08T00:20:00Z',applicationOpen:true});assert.equal(app.listJobView()[0].display.recruitment.label,'待确认');assert.equal(app.getRecruitmentState(job.id).dates.deadlineConflict,true);
});
