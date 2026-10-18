import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { startServer } from '../src/server.mjs';

async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jh-presentation-'));
  const unavailable = async () => { throw new Error('本票测试禁止真实外部接入'); };
  const app = createApplication({ databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null,
    matchingProcessor: null, careerSource: null, sourceFetch: unavailable, ccbSourceFetch: unavailable,
    icbcFetch: unavailable, cmriFetch: unavailable, sasacFetch: unavailable, notificationTransport: null,
    now: () => new Date('2026-10-08T01:00:00Z'), ...overrides });
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}

test('岗位库以可选择列的表格展示已取得岗位，行内真实申请入口和个人选择独立可用', async t => {
  const { app, base } = await setup(t);
  const direct = app.createJob({ title: '模拟算法专家<script>', recruitmentUnit: '模拟研究院', originalText: '模拟岗位完整原文。',
    location: { options: ['北京', '上海'], note: '最终城市待确认' }, applicationPath: { kind: 'direct', url: 'https://example.invalid/jobs/1', loginRequired: true } });
  const steps = app.createJob({ title: '模拟技术负责人', originalText: '仅有手动原文，招聘状态未知。',
    applicationPath: { kind: 'steps', url: 'https://example.invalid/jobs', steps: '登录后搜索岗位编号S2', loginRequired: true } });
  app.setPersonalState(direct.id, { followed: true });
  const html = await (await fetch(base + '/jobs')).text();
  assert.match(html, /<table[^>]*[\s\S]*<thead>[\s\S]*<tbody\b[^>]*>/);
  assert.match(html, /选择显示列/);
  for (const label of ['推荐程度', '投递资格', '招聘状态', '官方报名起止', '个人标记', '投递入口', '签约主体']) assert.ok(html.includes(label), label);
  assert.match(html, /模拟算法专家&lt;script&gt;/);
  assert.match(html, /北京、上海/);
  assert.match(html, /href="https:\/\/example.invalid\/jobs\/1"[^>]*>岗位直达/);
  assert.match(html, /href="https:\/\/example.invalid\/jobs"[^>]*>申请入口及步骤/);
  assert.match(html, /登录后搜索岗位编号S2/);
  assert.match(html, /data-action="followed"[^>]*checked/);
  assert.match(html, /data-action="applied"/);
  assert.equal(app.getPersonalState(direct.id).applied, false);
  assert.equal(app.getPersonalState(steps.id).applied, false);
});

test('完整岗位详情可读展示职责、公共与岗位条件、匹配引文和日期原值，不默认输出原始JSON', async t => {
  const originalText = '模拟研究院招聘算法专家，北京、上海。招聘邮箱hiring@example.invalid，注明岗位名称。职责：负责推荐排序模型研发。公共条件：硕士及以上。年龄不超过40周岁，截至2026年10月8日。平台日期2030-01-01含义不明。';
  const evidence = quote => ({ documentId: 'announcement', locator: '正文', quote });
  const dimension = { level: 'high', explanation: '模拟解释：推荐排序研发与已记录经历相符',
    directExperiences: [{ profileQuote: '负责推荐排序研发', jobQuote: '负责推荐排序模型研发', explanation: '有直接研发经历依据' }],
    transferableAbilities: [], gaps: ['尚未披露具体团队规模'], jobQuotes: ['负责推荐排序模型研发'] };
  const { app, base } = await setup(t, { announcementProcessor: { process: async () => ({
    commonConditions: [{ text: '硕士及以上', evidence: [evidence('硕士及以上')] }],
    jobs: [{ title: '算法专家', recruitmentUnit: '模拟研究院', department: null, batch: null, contractingEntity: null,
      locations: ['北京', '上海'], duties: '负责推荐排序模型研发',
      conditions: [{ text: '年龄不超过40周岁，截至2026年10月8日', evidence: [evidence('年龄不超过40周岁，截至2026年10月8日')] }],
      evidence: [evidence('模拟研究院招聘算法专家')], applicationPath: { kind: 'email', url: null, email: 'hiring@example.invalid', steps: '注明岗位名称', loginRequired: false },
      unknownFields: ['最终工作城市待确认'], dateEvidence: [{ field: '平台日期', raw: '2030-01-01', meaning: 'unverified', evidence: [evidence('平台日期2030-01-01含义不明')] }] }], inputGaps: [] }) },
    matchingProcessor: { match: async () => ({ technical: dimension, business: dimension, scope: dimension, route: 'expert', routeExplanation: '负责模型研发的专家职责', uncertainties: ['团队规模待确认'] }) } });
  const announcement = await app.createAnnouncement({ title: '模拟公告', originalText });
  const processed = await app.processAnnouncement(announcement.id);
  assert.equal(processed.status, 'processed', processed.error);
  const job = app.getJob(processed.jobIds[0]);
  app.saveCareerProfile({ text: '模拟个人事实：负责推荐排序研发', version: '模拟v1', sourceId: 'manual' });
  app.evaluateEligibility(job.id, { profile: { version: '模拟v1', education: '硕士', birthday: '1990-01-01' } });
  assert.equal((await app.matchJob(job.id)).status, 'completed');
  const html = await (await fetch(base + '/jobs/' + job.id)).text();
  assert.match(html, /岗位职责/);
  assert.match(html, /公共条件/);
  assert.match(html, /负责推荐排序模型研发/);
  assert.match(html, /硕士及以上/);
  assert.match(html, /职业资料引文：负责推荐排序研发/);
  assert.match(html, /平台日期[\s\S]*2030-01-01/);
  assert.match(html, /生日[\s\S]*1990-01-01/);
  assert.match(html, /href="mailto:hiring@example.invalid"/);
  assert.doesNotMatch(html, /<pre>\s*[\[{]/);
  assert.doesNotMatch(html, /&quot;conditions&quot;|&quot;unverified&quot;/);
  assert.match(html, /原文证据[\s\S]*模拟研究院招聘算法专家/);
});

test('长资格待核验清单在岗位表格只显示简短结论，详情保留全部依据并转义', async t => {
  const { app, base } = await setup(t);
  const conditions = ['年龄不超过40周岁<em>模拟年龄</em>', '须为数学专业', '持有CFA证书',
    ...Array.from({ length: 44 }, (_, index) => `模拟公告条款${index + 4}<script>待核验</script>`)];
  const job = app.createJob({ title: '模拟长条件岗位', originalText: conditions.join('\n'), knownConditions: conditions });
  const result = app.evaluateEligibility(job.id, { profile: { version: '模拟未知资格v1' } });
  assert.equal(result.status, 'pending');
  assert.equal(result.checks.filter(check => check.status === 'pending').length, 47);

  app.setPersonalState(job.id, { followed: true });
  app.setApplied(job.id, true);
  for (const route of ['/jobs', '/followed', '/applications']) {
    const listing = await (await fetch(base + route)).text();
    const cell = listing.match(/<td data-job-column="eligibility">([\s\S]*?)<\/td>/)?.[1];
    assert.ok(cell, `${route}必须保留投递资格列`);
    assert.match(cell, /不确定/);
    assert.equal((cell.match(/<li>/g) ?? []).length, 0, '表格不展开长清单');
    assert.ok(cell.length < 200);
    assert.doesNotMatch(cell, /模拟公告条款|<em>|<script>/);
  }

  const detail = await (await fetch(base + '/jobs/' + job.id)).text();
  for (let number = 4; number <= 47; number++) assert.ok(detail.includes(`模拟公告条款${number}&lt;script&gt;待核验&lt;/script&gt;`));
  assert.match(detail, /所要求个人专业缺少明确资料/);
  assert.match(detail, /所要求证书缺少个人明确证据/);
  assert.doesNotMatch(detail, /<script>待核验<\/script>|<em>模拟年龄<\/em>/);
  assert.equal(app.getEligibility(job.id).checks.length, 47, '列表摘要不能改变完整资格结果');
});

test('三页资格摘要优先具体学历专业经验缺口，泛化条款仍保留完整详情', async t => {
  const {app,base}=await setup(t);
  const conditions=['遵守国家法律法规','具有坚定AGI信仰','保持研究热情','具有持续学习驱动力',
    '博士学历<em>明确学历</em>','须为数学专业<script>明确专业</script>','具有3年AI项目经验'];
  const job=app.createJob({title:'模拟关键资格靠后岗位',originalText:conditions.join('\n'),knownConditions:conditions});
  const result=app.evaluateEligibility(job.id,{profile:{version:'模拟缺资料v1'}});
  assert.equal(result.status,'pending');assert.equal(result.checks.length,7);
  app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);
  for (const route of ['/jobs','/followed','/applications']) {
    const html=await(await fetch(base+route)).text();
    const cell=html.match(/<td data-job-column="eligibility">([\s\S]*?)<\/td>/)?.[1];
    assert.ok(cell);assert.equal((cell.match(/<li>/g)??[]).length,0);
    assert.match(cell,/不确定/);assert.match(cell,/学历未确认/);
    assert.doesNotMatch(cell,/遵守国家法律法规|坚定AGI信仰|研究热情|学习驱动力|<em>|<script>/);
  }
  const detail=await(await fetch(base+'/jobs/'+job.id)).text();
  for (const condition of conditions.slice(0,4)) assert.ok(detail.includes(condition));
  assert.match(detail,/博士学历&lt;em&gt;明确学历&lt;\/em&gt;/);
  assert.match(detail,/须为数学专业&lt;script&gt;明确专业&lt;\/script&gt;/);
  assert.match(detail,/具有3年AI项目经验/);assert.doesNotMatch(detail,/<script>明确专业<\/script>|<em>明确学历<\/em>/);
  assert.deepEqual(await(await fetch(base+`/api/jobs/${job.id}/eligibility`)).json(),result,'摘要排序不能改写资格结果或原始条件顺序');
});
