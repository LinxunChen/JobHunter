import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const fixedTime = '2026-10-07T02:00:00.000Z';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-personal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'jobs.sqlite'), now: () => new Date(fixedTime) };
}
const sample = { title: '算法专家', recruitmentUnit: '示例研究院', originalText: '可核对岗位原文', applicationPath: { kind: 'direct', url: 'https://example.org/job/1' } };

test('关注与勾选已投递独立即时保存，未填备注和简历仍可重启恢复', t => {
  const options = setup(t);
  const app = createApplication(options);
  const job = app.createJob(sample);
  assert.equal(app.getPersonalState(job.id).applied, false);
  app.setPersonalState(job.id, { followed: true });
  const application = app.setApplied(job.id, true);
  assert.equal(application.appliedAt, fixedTime);
  assert.equal(application.notes, null);
  assert.equal(application.resumeVersion, null);
  assert.equal(application.jobSnapshot.originalText, '可核对岗位原文');
  assert.equal(app.getPersonalState(job.id).followed, true);
  assert.equal(app.getPersonalState(job.id).applied, true);
  assert.equal(app.getPersonalState(job.id).registrationRemindersSuppressed, true);
  assert.equal(app.setApplied(job.id, true).id, application.id);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.equal(restarted.getPersonalState(job.id).followed, true);
  assert.equal(restarted.getPersonalState(job.id).applied, true);
  assert.equal(restarted.listApplications().length, 1);
  assert.deepEqual(restarted.getApplication(application.id), application);
});

test('投递时间、备注和实际简历版本可后补，事件有历史，撤销误勾保留面试事实', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const job = app.createJob(sample);
  app.setPersonalState(job.id, { followed: true, viewed: true, preparing: true });
  const application = app.setApplied(job.id, true);
  const updated = app.updateApplication(application.id, { appliedAt: '2026-10-06T03:00:00.000Z', notes: '通过官网提交', resumeVersion: '简历2026-10-06' });
  assert.equal(updated.appliedAt, '2026-10-06T03:00:00.000Z');
  assert.equal(updated.resumeVersion, '简历2026-10-06');
  assert.equal(updated.notes, '通过官网提交');
  app.recordApplicationEvent(application.id, { type: 'interview', occurredAt: '2026-10-08T03:00:00.000Z', note: '本人记录面试安排' });
  assert.equal(app.getPersonalState(job.id).applicationProgress, 'interview');
  app.setApplied(job.id, false);
  const corrected = app.getApplication(application.id);
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.events.filter(event => event.type === 'interview').length, 1);
  assert.equal(corrected.events.filter(event => event.type === 'correction').length, 1);
  assert.equal(corrected.events.filter(event => event.type === 'withdrawn').length, 0);
  assert.equal(app.getPersonalState(job.id).applied, false);
  assert.equal(app.getPersonalState(job.id).followed, true);
  assert.equal(app.getJob(job.id).recruitmentStatus, 'unverified');
  assert.equal(app.listApplications().length, 1);
  app.setApplied(job.id, false);
  assert.equal(app.getApplication(application.id).events.filter(event => event.type === 'correction').length, 1);
});

test('已看、准备投递、暂停提醒及不感兴趣独立，不从时间流逝推断申请结束', t => {
  const options = setup(t);
  const app = createApplication(options);
  const job = app.createJob(sample);
  app.setPersonalState(job.id, { viewed: true, preparing: true, remindersPaused: true, notInterested: true });
  const state = app.getPersonalState(job.id);
  assert.equal(state.applied, false);
  assert.equal(state.applicationProgress, 'preparing');
  assert.equal(state.registrationRemindersSuppressed, true);
  const application = app.setApplied(job.id, true);
  assert.throws(() => app.updateApplication(application.id, { appliedAt: '不是日期' }), /时间/);
  assert.throws(() => app.setPersonalState(job.id, { followed: '是' }), /布尔/);
  app.close();
  const afterLongWait = createApplication({ ...options, now: () => new Date('2027-10-07T02:00:00.000Z') });
  t.after(() => afterLongWait.close());
  assert.equal(afterLongWait.getPersonalState(job.id).applicationProgress, 'applied');
  assert.equal(afterLongWait.getApplication(application.id).events.some(event => event.type === 'ended'), false);
  afterLongWait.recordApplicationEvent(application.id, { type: 'ended', note: '本人确认申请结束，未说明结果' });
  assert.equal(afterLongWait.getPersonalState(job.id).applicationProgress, 'ended');
  assert.equal(afterLongWait.getPersonalState(job.id).applied, true);
  assert.equal(afterLongWait.getApplication(application.id).events.at(-1).note, '本人确认申请结束，未说明结果');
});
