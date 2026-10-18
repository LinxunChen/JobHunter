import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const originalText = '模拟公告。招聘单位：示例研究院。公共条件：硕士及以上。岗位A：算法专家，地点北京，职责推荐排序。岗位B：技术负责人，地点北京，职责团队管理。按公告到指定入口报名。';
const attachmentText = '附件岗位条件：算法专家须3年推荐经验；技术负责人须5年管理经验。';
const evidence = (documentId, quote) => ({ documentId, locator: documentId === 'announcement' ? '正文' : '全文', quote });
const modelOutput = {
  commonConditions: [{ text: '硕士及以上', evidence: [evidence('announcement', '硕士及以上')] }],
  jobs: [
    { title: '算法专家', recruitmentUnit: '示例研究院', department: null, batch: null, contractingEntity: null, locations: ['北京'], duties: '推荐排序', conditions: [{ text: '3年推荐经验', evidence: [evidence('attachment-1', '3年推荐经验')] }], evidence: [evidence('announcement', '岗位A：算法专家，地点北京，职责推荐排序')], applicationPath: { kind: 'announcement', url: null, email: null, steps: '按公告到指定入口报名', loginRequired: false }, unknownFields: [], dateEvidence: [] },
    { title: '技术负责人', recruitmentUnit: '示例研究院', department: null, batch: null, contractingEntity: null, locations: ['北京'], duties: '团队管理', conditions: [{ text: '5年管理经验', evidence: [evidence('attachment-1', '5年管理经验')] }], evidence: [evidence('announcement', '岗位B：技术负责人，地点北京，职责团队管理')], applicationPath: null, unknownFields: ['实际申请入口未披露'], dateEvidence: [] },
  ], inputGaps: [],
};
function setup(t, processor) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-announcement-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'data.sqlite'), announcementProcessor: processor, now: () => new Date('2026-10-07T02:00:00Z') };
}

test('一份公告拆成两个岗位，公共及附件条件各有原文定位，重启仍可读', async t => {
  const options = setup(t, { process: async () => structuredClone(modelOutput) });
  const app = createApplication(options);
  const saved = await app.createAnnouncement({ title: '模拟社招公告', originalText, attachments: [{ name: '岗位.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }] });
  const processed = await app.processAnnouncement(saved.id);
  assert.equal(processed.status, 'processed');
  assert.equal(processed.jobIds.length, 2);
  const jobs = processed.jobIds.map(id => app.getJob(id));
  assert.deepEqual(jobs.map(job => job.title), ['算法专家', '技术负责人']);
  assert.deepEqual(jobs[0].knownConditions, ['硕士及以上', '3年推荐经验']);
  assert.deepEqual(jobs[1].knownConditions, ['硕士及以上', '5年管理经验']);
  assert.equal(jobs[0].conditions[1].evidence[0].documentId, 'attachment-1');
  assert.equal(app.getAnnouncement(saved.id).attachments[0].text, attachmentText);
  assert.equal(app.getAnnouncement(saved.id).originalText, originalText);
  await app.processAnnouncement(saved.id);
  assert.equal(app.listJobs().length, 2);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.getJob(jobs[0].id), jobs[0]);
  assert.deepEqual(restarted.getAnnouncement(saved.id).jobIds, processed.jobIds);
});

test('模型编造附件引文时不保存任何候选岗位，原文与失败可重启读取', async t => {
  const bad = structuredClone(modelOutput);
  bad.jobs[0].conditions[0].evidence[0].quote = '原文根本没有的十年经验';
  const options = setup(t, { process: async () => bad });
  const app = createApplication(options);
  const saved = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '岗位.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }] });
  const failed = await app.processAnnouncement(saved.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /证据/);
  assert.equal(app.listJobs().length, 0);
  assert.deepEqual(failed.rejectedExtraction.output, bad);
  assert.equal(failed.rejectedExtraction.contentVersion, failed.contentVersion);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.equal(restarted.getAnnouncement(saved.id).originalText, originalText);
  assert.deepEqual(restarted.getAnnouncement(saved.id).rejectedExtraction.output, bad);
  assert.match(restarted.getAnnouncement(saved.id).error, /证据/);
  assert.equal(restarted.getAnnouncementAttachment(saved.id, 'attachment-1').toString(), attachmentText);
});

test('历史官方PDF附件保存原始字节并按页提取，缺失或不可读附件仍明确显示缺口', async t => {
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(new URL('./fixtures/boc-historical-202605.pdf', import.meta.url));
  const options = { ...setup(t, null), attachmentPython: process.env.JOBHUNTER_ATTACHMENT_PYTHON ?? new URL('../.runtime/attachment-venv/bin/python',import.meta.url).pathname };
  const app = createApplication(options);
  t.after(() => app.close());
  const saved = await app.createAnnouncement({ title: '中行历史附件回放', originalText: '2026年历史公告，附件列出岗位。', evidenceUse: 'historical', attachments: [
    { name: '岗位条件.pdf', mediaType: 'application/pdf', contentBase64: bytes.toString('base64') },
    { name: '缺失.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { name: '损坏.pdf', mediaType: 'application/pdf', contentBase64: Buffer.from('not a PDF').toString('base64') },
  ] });
  assert.equal(saved.attachments[0].status, 'read');
  assert.equal(saved.attachments[0].segments.length, 3);
  assert.match(saved.attachments[0].text, /人工智能/);
  assert.equal(saved.attachments[0].segments[0].locator, 'page:1');
  assert.equal(saved.attachments[1].status, 'missing');
  assert.equal(saved.attachments[2].status, 'failed');
  assert.equal(saved.gaps.length, 2);
  assert.deepEqual(app.getAnnouncementAttachment(saved.id, 'attachment-1'), bytes);
});

test('附件缺失和模型失败不冒充完整加工，模型等待时本人投递仍即时保存', async t => {
  let fail;
  const options = setup(t, { process: () => new Promise((resolve, reject) => { fail = reject; }) });
  const app = createApplication(options);
  t.after(() => app.close());
  const saved = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '公共条件.pdf', mediaType: 'application/pdf' }] });
  const pending = app.processAnnouncement(saved.id);
  assert.equal(app.getAnnouncement(saved.id).status, 'processing');
  const other = app.createJob({ title: '已存在岗位', originalText: '本人已有岗位原文' });
  assert.equal(app.setApplied(other.id, true).jobId, other.id);
  fail(new Error('模拟Codex网络失败'));
  const failed = await pending;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /网络失败/);
  assert.match(failed.gaps[0], /未取得/);
  assert.equal(app.getPersonalState(other.id).applied, true);
  assert.equal(app.listJobs().length, 1);
});

test('Web补录公告和附件、启动加工，详情显示岗位及具体附件缺口', async t => {
  const { startServer } = await import('../src/server.mjs');
  const partial = structuredClone(modelOutput);
  partial.jobs.forEach(job => { job.conditions = []; });
  const app = createApplication(setup(t, { process: async () => partial }));
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = await fetch(base + '/announcements/new');
  assert.equal(form.status, 200);
  assert.match(await form.text(), /附件/);
  const saved = await fetch(base + '/api/announcements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '模拟公告', originalText, attachments: [{ name: '岗位条件.pdf', mediaType: 'application/pdf' }] }) });
  assert.equal(saved.status, 201);
  const announcement = await saved.json();
  const processed = await fetch(base + `/api/announcements/${announcement.id}/process`, { method: 'POST' });
  assert.equal(processed.status, 200);
  assert.equal((await processed.json()).status, 'partial');
  const detail = await fetch(base + `/announcements/${announcement.id}`);
  const html = await detail.text();
  assert.match(html, /岗位条件.pdf/);
  assert.match(html, /未取得/);
  assert.match(html, /算法专家/);
  assert.match(html, /技术负责人/);
  assert.match(html, /不代表完整加工/);
  const job = app.listJobs()[0];
  assert.match(await (await fetch(base + `/jobs/${job.id}`)).text(), /来源公告/);
});

test('无效附件输入拒绝保存；跨岗位错配引文不能成为可采用岗位', async t => {
  const mismatch = structuredClone(modelOutput);
  mismatch.jobs[0].evidence = modelOutput.jobs[1].evidence;
  const app = createApplication(setup(t, { process: async () => mismatch }));
  t.after(() => app.close());
  await assert.rejects(app.createAnnouncement({ title: '公告', originalText, attachments: [{ name: '错误.txt', contentBase64: '%%% not base64' }] }), /附件/);
  assert.equal(app.listAnnouncements().length, 0);
  const saved = await app.createAnnouncement({ title: '公告', originalText, attachments: [{ name: '岗位.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }] });
  const processed = await app.processAnnouncement(saved.id);
  assert.equal(processed.status, 'failed');
  assert.match(processed.error, /岗位.*证据/);
  assert.equal(app.listJobs().length, 0);
});

test('加工期间重复启动被拒绝，原文及已保存个人历史可读', async t => {
  let complete;
  const options = setup(t, { process: () => new Promise(resolve => { complete = resolve; }) });
  const app = createApplication(options);
  const concurrent = createApplication(options);
  t.after(() => { concurrent.close(); app.close(); });
  const saved = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '岗位.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }] });
  const pending = app.processAnnouncement(saved.id);
  await assert.rejects(concurrent.processAnnouncement(saved.id), /加工|重叠/);
  assert.equal(concurrent.getAnnouncement(saved.id).originalText, originalText);
  complete(structuredClone(modelOutput));
  assert.equal((await pending).status, 'processed');
  assert.equal(concurrent.listJobs().length, 2);
});


test('外部附件读取的中文跨UTF-8字节块时，公告入口保留完整可定位文字', async t => {
  const { writeFileSync } = await import('node:fs');
  const options = setup(t, null);
  // Substitute only the external attachment-reader process, not application parsing or storage.
  const reader = join(options.databasePath, '..', 'chunked-reader');
  const result = { text: '中文附件条件：硕士及以上', segments: [{ locator: 'page:1', text: '中文附件条件：硕士及以上' }] };
  writeFileSync(reader, `#!/usr/bin/env node
const data=Buffer.from(${JSON.stringify(JSON.stringify(result))});
process.stdin.resume();
process.stdin.on('end',()=>{process.stdout.write(data.subarray(0,10));setTimeout(()=>process.stdout.write(data.subarray(10)),30);});
`, { mode: 0o700 });
  const app = createApplication({ ...options, attachmentPython: reader });
  t.after(() => app.close());
  const saved = await app.createAnnouncement({ title: '中文附件回放', originalText: '模拟公告，条件见附件。', attachments: [{ name: '模拟.pdf', mediaType: 'application/pdf', contentBase64: Buffer.from('external reader input fixture').toString('base64') }] });
  assert.equal(saved.attachments[0].status, 'read');
  assert.equal(saved.attachments[0].text, '中文附件条件：硕士及以上');
  assert.equal(saved.attachments[0].segments[0].text, '中文附件条件：硕士及以上');
  assert.equal(app.getAnnouncement(saved.id).attachments[0].text.includes('�'), false);
});


test('候选岗位保存事务失败时，公告不保留未落盘岗位关联，失败及原文可重启读取', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const options = setup(t, { process: async () => structuredClone(modelOutput) });
  const app = createApplication(options);
  const saved = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '岗位.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }] });
  // Real SQLite boundary fault fixture: force the storage provider to reject candidate inserts.
  const storage = new DatabaseSync(options.databasePath);
  storage.exec("CREATE TRIGGER reject_candidate BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, '模拟候选写入失败'); END");
  storage.close();
  const failed = await app.processAnnouncement(saved.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /候选写入失败/);
  assert.equal(app.listJobs().length, 0);
  assert.deepEqual(failed.jobIds, []);
  assert.equal(failed.steps.some(step => step.step === 'jobs_saved'), false);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.equal(restarted.getAnnouncement(saved.id).originalText, originalText);
  assert.deepEqual(restarted.getAnnouncement(saved.id).jobIds, []);
  assert.equal(restarted.listJobs().length, 0);
});
