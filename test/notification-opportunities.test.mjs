import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { startServer } from '../src/server.mjs';
const jobText = '模拟岗位负责推荐排序研发，制定技术路线，硕士及以上。';
const profileText = '模拟本人事实：负责推荐排序研发和技术路线设计。';
const pair = { profileQuote: '负责推荐排序研发和技术路线设计', jobQuote: '负责推荐排序研发', explanation: '有可核对的模拟直接研发事实' };
const dimension = { level: 'high', explanation: '模拟直接经历匹配', directExperiences: [pair], transferableAbilities: [], gaps: [], jobQuotes: [pair.jobQuote] };
function setup(t, transport = null) {
  const directory = mkdtempSync(join(tmpdir(), 'jh-notification-opportunities-'));
  let time = '2026-10-08T01:00:00Z';
  const noExternal = async () => { throw Error('本票禁止真实外部接入'); };
  const options = { databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null,
    matchingProcessor: { match: async () => ({ technical: dimension, business: dimension, scope: dimension, route: 'expert', routeExplanation: '模型研发与技术路线职责', uncertainties: [] }) },
    careerSource: null, sourceFetch: noExternal, ccbSourceFetch: noExternal, icbcFetch: noExternal,
    cmriFetch: noExternal, sasacFetch: noExternal, notificationTransport: transport, now: () => new Date(time) };
  let app = createApplication(options);
  app.saveCareerProfile({ text: profileText, version: '模拟20-v1', sourceId: 'manual' });
  t.after(() => { app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { options, get app() { return app; }, setTime(value) { time = value; }, restart() { app.close(); app = createApplication(options); } };
}
async function seed(s, index, applicationPath, { conditions = ['硕士及以上'], profile = { education: '硕士' } } = {}) {
  const source = { title: `模拟通知岗位${index}`, recruitmentUnit: '模拟研究院', originalText: jobText + conditions.join('；'),
    sourceUrl: 'https://example.invalid/original/' + index, sourceIdentity: { sourceId: 'simulated-notification-social', externalId: String(index) },
    observedAt: '2026-10-08T01:00:00Z', sourceEvidence: { listed: true, checkedAt: '2026-10-08T01:00:00Z' },
    recruitmentStatus: 'publicly_listed_open', evidenceUse: 'current', knownConditions: conditions, applicationPath };
  const { job } = s.app.importJob(source);
  s.app.evaluateEligibility(job.id, { profile: { version: '模拟20-v1', ...profile } });
  assert.equal((await s.app.matchJob(job.id)).status, 'completed');
  return { job, source };
}

test('当前开放且匹配有效的待核验候选首次提醒，关键资格优先并经HTTP和实际传输payload明确标注', async t => {
  const requests = [], s = setup(t, { enabled: true, simulated: true, send: async request => { requests.push(request); return { code: 200, shortCode: 'synthetic-candidate-code' }; } });
  const url = 'https://example.invalid/official-candidate?postId=20';
  const { job } = await seed(s, '候选', { kind: 'direct', url }, { conditions: ['遵守法律法规', '坚定信仰', '驱动力强', '博士学历', '计算机专业', '5年以上法务工作经验'], profile: {} });
  const qualification = s.app.getEligibility(job.id), match = s.app.getMatch(job.id);
  assert.equal(qualification.status, 'pending');
  assert.equal(match.status, 'completed');
  assert.equal(match.qualificationAllowsAction, false);
  const server = await startServer({ app: s.app, port: 0 });
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = await (await fetch(base + '/api/daily-actions/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(run.opportunities.length, 1);
  assert.equal(run.opportunities[0].registrationAllowed, false);
  assert.equal(run.opportunities[0].qualification.status, 'pending');
  assert.equal(run.dailyDigest.featuredJobs.length, 1);
  assert.match(run.dailyDigest.title, /求职日报/);
  assert.match(run.dailyDigest.content, /资格待核验 · 学历未确认/);
  assert.match(run.dailyDigest.content, /模拟研究院/);
  assert.doesNotMatch(run.dailyDigest.content, /另有.*项待核验|需核对：遵守法律法规|需核对：坚定信仰|需核对：驱动力强/);
  assert.ok(qualification.checks.some(check => /法务/.test(check.originalCondition)), '长依据保留在资格结果中');
  assert.doesNotMatch(run.dailyDigest.content, /重要截止与关注变化|需要处理的来源异常/);
  assert.ok(run.dailyDigest.content.includes(url));
  assert.deepEqual(s.app.getEligibility(job.id), qualification);
  assert.deepEqual(s.app.getMatch(job.id), match);
  assert.equal(s.app.getActionEvents().some(event => event.registrationPrompt), false);
  const drafts = await (await fetch(base + '/api/notification-drafts')).json();
  assert.equal(drafts[0].title, run.dailyDigest.title);
  assert.equal((await s.app.sendNotification(run.dailyDigest.id)).status, 'accepted');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, run.dailyDigest.title);
  assert.equal(requests[0].content, run.dailyDigest.htmlContent);
  assert.match((await (await fetch(base + '/notifications')).text()), /资格待核验候选也可首次提醒/);
});

test('未关注的首个有效机会正文保留完整官方直达、入口步骤、邮箱与公告流程，HTTP草稿可读', async t => {
  const s = setup(t);
  const direct = 'https://example.invalid/application/post?jobId=TX20&category=social';
  const entry = 'https://example.invalid/recruitment/search';
  const directJob = await seed(s, '直达', { kind: 'direct', url: direct, loginRequired: true });
  await seed(s, '步骤', { kind: 'steps', url: entry, steps: '登录后搜索编号S20，再选择社会招聘提交', loginRequired: true });
  await seed(s, '邮箱', { kind: 'email', email: 'hiring@example.invalid', steps: '邮件主题：算法专家＋姓名' });
  await seed(s, '公告', { kind: 'announcement', steps: '填写公告附件2后交到公告指定受理点' });
  await seed(s, '缺口', null);
  assert.ok(s.app.listJobView().every(job => !job.personal.followed));
  const run = s.app.prepareDailyActions();
  assert.equal(run.dailyDigest.featuredJobs.length, 5);
  const content = run.dailyDigest.content;
  assert.ok(content.includes(direct));
  assert.ok(content.includes(entry));
  assert.match(content, /登录后搜索编号S20，再选择社会招聘提交/);
  assert.match(content, /hiring@example.invalid/);
  assert.match(content, /邮件主题：算法专家＋姓名/);
  assert.match(content, /填写公告附件2后交到公告指定受理点/);
  assert.match(content, /官方原文：https:\/\/example.invalid\/original\/缺口/);
  assert.match(content, /https:\/\/example.invalid\/original\/缺口/);
  assert.doesNotMatch(content, /；\/jobs\/|localhost|127\.0\.0\.1/);
  const server = await startServer({ app: s.app, port: 0 });
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const drafts = await (await fetch(base + '/api/notification-drafts')).json();
  assert.equal(drafts[0].content, content);
  assert.equal(s.app.listNotificationAttempts().length, 0);
  const correctedUrl = 'https://example.invalid/application/corrected?jobId=TX20';
  s.app.importJob({ ...directJob.source, applicationPath: { kind: 'direct', url: correctedUrl }, observedAt: '2026-10-08T02:00:00Z' });
  const revised = s.app.prepareDailyActions();
  assert.equal(revised.dailyDigest.id, run.dailyDigest.id);
  assert.deepEqual(revised.events.map(event => event.id), run.events.map(event => event.id));
  assert.ok(revised.dailyDigest.content.includes(correctedUrl));
  assert.ok(!revised.dailyDigest.content.includes(direct));
  assert.equal(s.app.listNotificationDrafts().length, 1);
});

const observation = (source, at, deadline) => ({ sourceId: source.sourceIdentity.sourceId, externalId: source.sourceIdentity.externalId,
  observedAt: at, acquisition: 'success', listComplete: true, listed: true, applicationOpen: true, detailChecked: true,
  evidence: { url: source.sourceUrl, text: '当前公开列示且允许报名', quote: '允许报名' },
  ...(deadline ? { deadline: { raw: deadline, evidence: { url: source.sourceUrl, text: '报名截止' + deadline, quote: '报名截止' + deadline } } } : {}) });

test('候选首次提醒独立于报名门禁，明确不符／历史／失败／过时匹配和资格排除，临期仍只放行已核验', async t => {
  const s = setup(t), path = { kind: 'direct', url: 'https://example.invalid/candidate-gates' }, pending = { conditions: ['硕士及以上', '计算机专业'] };
  const valid = await seed(s, '有效待核', path, pending);
  const bad = await seed(s, '明确不符', path, { conditions: ['博士学历'] });
  const historical = await seed(s, '历史待核', path, pending);
  s.app.importJob({ ...historical.source, evidenceUse: 'historical' });
  const staleMatch = await seed(s, '匹配过时', path, pending);
  s.app.importJob({ ...staleMatch.source, duties: '模拟职责变化为供应商协调' });
  s.app.evaluateEligibility(staleMatch.job.id, { profile: { version: '模拟20-v1', education: '硕士' } });
  assert.equal(s.app.getEligibility(staleMatch.job.id).stale, false);
  assert.equal(s.app.getMatch(staleMatch.job.id).stale, true);
  const staleQualification = await seed(s, '资格过时', path, pending);
  s.app.importJob({ ...staleQualification.source, unknownFields: ['资格附件未取得'] });
  assert.equal(s.app.getMatch(staleQualification.job.id).stale, false);
  assert.equal(s.app.getEligibility(staleQualification.job.id).stale, true);
  const failed = await seed(s, '匹配失败', path, pending), matching = s.options.matchingProcessor.match;
  s.options.matchingProcessor.match = async () => { throw Error('模拟匹配外部故障'); };
  assert.equal((await s.app.matchJob(failed.job.id)).status, 'failed');
  s.options.matchingProcessor.match = matching;
  const otherVersion = await seed(s, '资格版本不同', path, pending);
  s.app.evaluateEligibility(otherVersion.job.id, { profile: { version: '独立资格v2', education: '硕士' } });
  s.app.recordRecruitmentObservation(valid.job.id, observation(valid.source, '2026-10-08T01:00:00Z', '2026-10-09'));
  const run = s.app.prepareDailyActions();
  assert.deepEqual(run.opportunities.map(item => item.jobId), [valid.job.id]);
  assert.equal(run.opportunities[0].registrationAllowed, false);
  assert.equal(s.app.getMatch(valid.job.id).qualificationAllowsAction, false);
  for (const item of [bad, historical, staleMatch, staleQualification, failed, otherVersion]) assert.ok(!run.events.some(event => event.jobId === item.job.id));
  assert.equal(run.events.some(event => event.registrationPrompt || event.type === 'deadline_node'), false);
  s.app.saveCareerProfile({ text: profileText + ' 新的模拟职责事实。', version: '模拟20-v2', sourceId: 'manual' });
  assert.equal(s.app.getMatch(valid.job.id).profileStale, true);
  assert.equal(s.app.prepareDailyActions().dailyDigest.report.counts.uniqueJobs, 0);
  assert.equal(s.app.getActionEvents().find(event => event.jobId === valid.job.id).status, 'suppressed');
});

test('发送前复核候选当前资格：明确不符取消，待核变符合更新未交接草稿，已交接历史不改', async t => {
  const requests = [], s = setup(t, { enabled: true, simulated: true, send: async request => { requests.push(request); return { code: 200, shortCode: 'synthetic-recheck-code' }; } });
  const path = { kind: 'direct', url: 'https://example.invalid/recheck-qualification' };
  const bad = await seed(s, '核验前未知学历', path, { conditions: ['博士学历'], profile: {} });
  const first = s.app.prepareDailyActions().dailyDigest, original = structuredClone(first);
  s.app.evaluateEligibility(bad.job.id, { profile: { version: '模拟20-v1', education: '硕士' } });
  assert.equal(s.app.prepareDailyActions().dailyDigest.report.counts.uniqueJobs, 0);
  assert.equal(requests.length, 0);
  assert.equal(s.app.listNotificationAttempts().length, 0);
  assert.equal(s.app.getNotificationDraft(first.id).status, 'pending');
  assert.ok(s.app.getActionEvents().some(event => event.jobId === bad.job.id && event.status === 'suppressed'));
  for (const reason of ['关闭', '匹配过时']) {
    const item = await seed(s, '交接前' + reason, path, { conditions: ['硕士及以上', '计算机专业'] });
    const pending = s.app.prepareDailyActions().dailyDigest;
    if (reason === '关闭') s.app.recordRecruitmentObservation(item.job.id, { ...observation(item.source, '2026-10-08T02:00:00Z'), explicitEnd: { url: item.source.sourceUrl, text: '招聘已结束', quote: '招聘已结束' } });
    else s.app.importJob({ ...item.source, duties: '模拟职责改变为供应商协调' });
    assert.equal(s.app.prepareDailyActions().dailyDigest.report.counts.uniqueJobs, 0);
    assert.equal(requests.length, 0);
    assert.equal(s.app.listNotificationAttempts().length, 0);
    assert.equal(s.app.getNotificationDraft(pending.id).status, 'pending');
  }
  const upgraded = await seed(s, '补齐专业', path, { conditions: ['硕士及以上', '计算机专业'] });
  const candidateDraft = s.app.prepareDailyActions().dailyDigest;
  assert.match(candidateDraft.title, /求职日报/);
  s.app.evaluateEligibility(upgraded.job.id, { profile: { version: '模拟20-v1', education: '硕士', major: '计算机' } });
  assert.equal((await s.app.sendNotification(candidateDraft.id)).status, 'accepted');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].title, /资格待核验/);
  assert.doesNotMatch(requests[0].content, /需核对：计算机专业/);
  assert.equal(s.app.getNotificationDraft(candidateDraft.id).featuredJobs[0].registrationAllowed, true);
  const held = s.app.getNotificationDraft(candidateDraft.id), delivery = s.app.getNotificationDelivery(candidateDraft.id);
  s.app.evaluateEligibility(upgraded.job.id, { profile: { version: '模拟20-v1', education: '硕士' } });
  assert.equal(s.app.prepareDailyActions().dailyDigest, null);
  assert.deepEqual(s.app.getNotificationDraft(candidateDraft.id), held);
  assert.deepEqual(s.app.getNotificationDelivery(candidateDraft.id), delivery);
  assert.match(original.title, /求职日报/);
  s.restart();
  assert.deepEqual(s.app.getNotificationDraft(candidateDraft.id), held);
  assert.deepEqual(s.app.getNotificationDelivery(candidateDraft.id), delivery);
});

test('待核候选共用5岗／每日一摘要和实际尝试预算，未知不盲发，跨日重启重算不重复首次事件', async t => {
  const requests = [], s = setup(t, { enabled: true, simulated: true, send: async request => { requests.push(request); return { code: 500 }; } });
  const jobs = [];
  for (let index = 0; index < 8; index++) jobs.push(await seed(s, '批量待核' + index, { kind: 'direct', url: 'https://example.invalid/bulk/' + index }, { conditions: ['硕士及以上', '计算机专业'] }));
  const first = s.app.prepareDailyActions(), ids = first.events.map(event => event.id);
  assert.equal(first.opportunities.length, 8);
  assert.equal(first.dailyDigest.featuredJobs.length, 5);
  assert.equal(first.dailyDigest.omittedEventIds.length, 0);assert.equal(first.dailyDigest.report.counts.uniqueJobs, 8);
  assert.ok(first.dailyDigest.featuredJobs.every(job => !job.registrationAllowed && job.qualification.status === 'pending'));
  await s.app.matchJob(jobs[0].job.id);
  assert.deepEqual(s.app.prepareDailyActions().events.map(event => event.id), ids);
  assert.equal((await s.app.sendNotification(first.dailyDigest.id)).status, 'unknown');
  assert.equal((await s.app.sendNotification(first.dailyDigest.id)).status, 'unknown');
  assert.equal(requests.length, 1);
  assert.equal(s.app.getNotificationStatus().usedAttempts, 1);
  assert.equal(s.app.prepareDailyActions().dailyDigest, null);
  assert.equal(s.app.prepareDailyActions().importantDraft, null);
  s.restart();
  s.setTime('2026-10-09T01:00:00Z');
  const second = s.app.prepareDailyActions().dailyDigest;
  assert.equal(second.featuredJobs.length, 0);assert.equal(second.report.counts.newConsiderable, 0);
  assert.ok(second.featuredJobs.every(job => !first.dailyDigest.featuredJobs.some(previous => previous.jobId === job.jobId)));
  assert.equal((await s.app.sendNotification(second.id)).status, 'unknown');
  // Synthetic verification messages use the same established delivery ledger and budget.
  for (let index = 0; index < 2; index++) assert.equal((await s.app.sendNotification(s.app.createNotificationVerification().id)).status, 'unknown');
  assert.equal((await s.app.sendNotification(s.app.createNotificationVerification().id)).status, 'budget_exhausted');
  assert.equal(s.app.getNotificationStatus().usedAttempts, 3);
  assert.equal(requests.length, 4);
  s.restart();
  s.setTime('2026-10-10T01:00:00Z');
  for (const item of jobs) { s.app.recordRecruitmentObservation(item.job.id, observation(item.source, '2026-10-10T01:00:00Z')); await s.app.matchJob(item.job.id); }
  assert.equal(s.app.prepareDailyActions().dailyDigest.report.counts.uniqueJobs, 0);
  assert.deepEqual(s.app.getActionEvents().map(event => event.id), ids);
  assert.equal((await s.app.sendNotification(first.dailyDigest.id)).status, 'unknown');
  assert.equal(requests.length, 4);
});

test('首次未关注机会交接后无变化不重推，未知不重发；关注入口变化和7／3／1日继续有官方申请路径', async t => {
  const requests = [];
  const transport = { enabled: true, simulated: true, send: async request => { requests.push(request); return { code: 500 }; } };
  const s = setup(t, transport);
  const { job, source } = await seed(s, '事件', { kind: 'direct', url: 'https://example.invalid/first-official-entry' });
  const first = s.app.prepareDailyActions();
  assert.equal(first.events.filter(event => event.type === 'opportunity').length, 1);
  assert.equal(s.app.getPersonalState(job.id).followed, false);
  const sent = await s.app.sendNotification(first.dailyDigest.id);
  assert.equal(sent.status, 'unknown');
  assert.ok(requests[0].content.includes('https://example.invalid/first-official-entry'));
  await s.app.sendNotification(first.dailyDigest.id);
  assert.equal(requests.length, 1);
  assert.equal(s.app.getNotificationStatus().usedAttempts, 1);
  s.restart();
  for (const time of ['2026-10-09T01:00:00Z', '2026-10-15T01:00:00Z']) {
    s.setTime(time);
    s.app.recordRecruitmentObservation(job.id, observation(source, time));
    const unchanged = s.app.prepareDailyActions();
    assert.equal(unchanged.dailyDigest.report.counts.newConsiderable, 0);assert.equal(unchanged.dailyDigest.featuredJobs.length, 0);
    assert.equal(unchanged.importantDraft, null);
    assert.equal(unchanged.events.filter(event => event.type === 'opportunity').length, 1);
  }
  s.app.setPersonalState(job.id, { followed: true });
  assert.equal(s.app.prepareDailyActions().dailyDigest.report.counts.followed, 1);
  const updatedUrl = 'https://example.invalid/updated-official-entry?jobId=20';
  s.setTime('2026-10-15T02:00:00Z');
  s.app.importJob({ ...source, observedAt: '2026-10-15T02:00:00Z', applicationPath: { kind: 'steps', url: updatedUrl, steps: '先登录，再搜索新编号EV20', loginRequired: true } });
  const changed = s.app.prepareDailyActions();
  const changedDraft = changed.dailyDigest ?? changed.importantDraft;
  assert.ok(changedDraft.content.includes(updatedUrl));
  assert.match(changedDraft.content, /先登录，再搜索新编号EV20/);
  assert.equal(changed.events.filter(event => event.type === 'opportunity').length, 1);
  assert.equal(changed.events.filter(event => event.type === 'watched_change' && event.status === 'pending').length, 1);
  assert.equal(s.app.getNotificationDraft(first.dailyDigest.id).content, first.dailyDigest.content);
  // Same-day later nodes stay in Web; only one daily report is handed off.
  for (const [at, node] of [['2026-10-15T03:00:00Z', 7], ['2026-10-19T01:00:00Z', 3], ['2026-10-21T01:00:00Z', 1]]) {
    s.setTime(at);
    s.app.recordRecruitmentObservation(job.id, observation(source, at, '2026-10-22'));
    const run = s.app.prepareDailyActions();
    const draft = run.dailyDigest ?? run.importantDraft;
    assert.ok(draft.content.includes(updatedUrl));
    assert.match(draft.content, /先登录，再搜索新编号EV20/);
    assert.ok(run.events.some(event => event.type === 'deadline_node' && event.node === node && event.status === 'pending'));
    const ids = run.events.map(event => event.id);
    assert.deepEqual(s.app.prepareDailyActions().events.map(event => event.id), ids);
  }
  s.app.setApplied(job.id, true);
  assert.ok(s.app.prepareDailyActions().events.filter(event => event.status === 'pending').every(event => !event.registrationPrompt));
  assert.equal(requests.length, 1);
  assert.equal(s.app.listNotificationAttempts().length, 1);
});

test('通知台账说明每日机会汇总和首次／变化／临期规则，返回来源设置', async t => {
  const s = setup(t);
  await seed(s, '台账', { kind: 'email', email: 'hiring@example.invalid' });
  s.app.prepareDailyActions();
  const server = await startServer({ app: s.app, port: 0 });
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/notifications`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /求职日报/);
  assert.match(html, /首次有效机会无需先关注/);
  assert.match(html, /没有新增也汇总/);
  assert.match(html, /7／3／1天/);
  assert.match(html, /href="\/sources">返回来源与设置/);
  assert.match(html, /hiring@example.invalid/);
  assert.equal(s.app.listNotificationAttempts().length, 0);
});

test('官方申请信息经公共发送入口保留在HTML消息中并提供文本兼容，传输仅受控替身', async t => {
  const { createPushplusTransport } = await import('../src/pushplus.mjs');
  const requests = [];
  const transport = createPushplusTransport({ enabled: true, simulated: true, token: 'synthetic-token-not-real',
    request: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ code: 200, data: 'simulated-code-20' })); } });
  const s = setup(t, transport);
  const url = 'https://example.invalid/application?postId=20&route=expert';
  await seed(s, 'txt传输', { kind: 'steps', url, steps: '登录后选择专家岗位20，再提交简历', loginRequired: true }, { conditions: ['硕士及以上', '计算机专业'] });
  const draft = s.app.prepareDailyActions().dailyDigest;
  assert.equal((await s.app.sendNotification(draft.id)).status, 'accepted');
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.template, 'html');
  assert.match(body.title, /求职日报/);
  assert.equal(body.content, draft.htmlContent);
  assert.ok(body.content.includes(url.replaceAll('&', '&amp;')));
  assert.match(body.content, /登录后选择专家岗位20，再提交简历/);
  assert.equal(s.app.getNotificationStatus().queryEnabled, false);
});

test('明确未接受后的有限重试不能把已核验旧正文用于现在资格待核验的候选', async t => {
  const requests = [], s = setup(t, { enabled: true, simulated: true, send: async request => { requests.push(request); return { outcome: 'not_accepted', category: 'connection_pre_submission', retryable: true }; } });
  const { job } = await seed(s, '重试资格变化', { kind: 'direct', url: 'https://example.invalid/retry-current' }, { conditions: ['硕士及以上', '计算机专业'], profile: { education: '硕士', major: '计算机' } });
  const first = s.app.prepareDailyActions().dailyDigest;
  assert.equal(first.featuredJobs[0].registrationAllowed, true);
  assert.equal((await s.app.sendNotification(first.id)).status, 'retry_wait');
  const held = s.app.getNotificationDraft(first.id);
  s.app.evaluateEligibility(job.id, { profile: { version: '模拟20-v1', education: '硕士' } });
  assert.equal(s.app.getToday().opportunities[0].registrationAllowed, false);
  s.setTime('2026-10-08T01:01:00Z');
  assert.equal((await s.app.sendNotification(first.id)).status, 'cancelled');
  assert.equal(requests.length, 1);
  assert.equal(s.app.getNotificationStatus().usedAttempts, 1);
  assert.deepEqual(s.app.getNotificationDraft(first.id), held);
  assert.equal(s.app.prepareDailyActions().dailyDigest, null);
  s.restart();
  assert.equal((await s.app.sendNotification(first.id)).status, 'cancelled');
  assert.equal(requests.length, 1);
});

test('尚未取得明确资格条件的候选明示原文证据缺口，不因没有check冒充符合', async t => {
  const s = setup(t);
  const { job } = await seed(s, '条件未取得', { kind: 'direct', url: 'https://example.invalid/missing-conditions' }, { conditions: [] });
  const qualification = s.app.getEligibility(job.id), run = s.app.prepareDailyActions();
  assert.equal(qualification.status, 'pending');
  assert.equal(qualification.checks.length, 0);
  assert.equal(run.opportunities[0].registrationAllowed, false);
  assert.match(run.dailyDigest.content, /资格待核验 · 资格条件未取得/);
  assert.deepEqual(s.app.getEligibility(job.id), qualification);
});
