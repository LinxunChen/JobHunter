import {sourceProcessingKey} from './local-settings.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.mjs';
import { readHtmlTables } from './boc-html.mjs';
import {jobRelevance,targetLocation} from './job-relevance.mjs';

const sourceId = 'ccb-social';
const site = 'https://job.ccb.com';
const socialUrl = `${site}/cn/job/plan_index.html?planType=SH`;
const hash = raw => createHash('sha256').update(raw).digest('hex');
const plain = html => String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(?:p|div|tr|li)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const endpoint = (code, params) => `${site}/tran/WCCMainPlatV5?${new URLSearchParams({ CCB_IBSVersion: 'V5', isAjaxRequest: 'true', SERVLET_NAME: 'WCCMainPlatV5', TXCODE: code, ...params })}`;

/** Normal certificate verification, anonymous GET only; no login or application transaction. */
export async function fetchCcbPublic(url, { signal, timeoutMs = 20000 } = {}) {
  const session = await createCcbPublicSession();
  try { return await session.fetch(url, {signal, timeoutMs}); }
  finally { await session.close(); }
}

// NHR104 establishes anonymous query context needed by NHR107. Keep only this
// check's cookies, never read a browser profile, and remove them on completion.
export async function createCcbPublicSession() {
  const dir = await mkdtemp(join(tmpdir(), 'jh-ccb-read-'));
  return {close:()=>rm(dir,{recursive:true,force:true}),fetch:async (url,{signal,timeoutMs=20000}={})=>{
  const parsed = new URL(url);
  if (parsed.origin !== site || parsed.username || parsed.password || (!parsed.pathname.startsWith('/cn/job/') && !parsed.pathname.startsWith('/tran/')) || (parsed.pathname.startsWith('/tran/') && !['NHR101', 'NHR104', 'NHR105', 'NHR106', 'NHR107'].includes(parsed.searchParams.get('TXCODE')) && parsed.pathname !== '/tran/FileDownloadZPServlet')) throw new Error('仅允许已核对的建行公开只读请求');
    const body = join(dir, 'body');
    const result = await runProcess('curl', ['--noproxy', '*', '--silent', '--show-error', '--max-time', String(timeoutMs / 1000), '--max-filesize', '8388608', '--cookie',join(dir,'anonymous.cookies'),'--cookie-jar',join(dir,'anonymous.cookies'),'--header', `Referer: ${socialUrl}`, '--header', 'X-Requested-With: XMLHttpRequest', '--user-agent', 'Mozilla/5.0', '--output', body, '--write-out', '%{http_code}', url], { timeoutMs: timeoutMs + 1000 });
    signal?.throwIfAborted();
    if (result.code !== 0) throw new Error(`建行公开读取失败：${result.stderr.trim() || result.code}`);
    return new Response(await readFile(body), { status: Number(result.stdout.trim()) });
  }};
}

export function createCcbOperations({ db, now, application, sourceFetch = fetchCcbPublic, sourceTimeoutMs = 20000 }) {
  db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL, checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL, announcement_id TEXT NOT NULL, PRIMARY KEY(source_id,external_id,content_hash))');
  const save = run => db.prepare('INSERT INTO source_checks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, sourceId, JSON.stringify(run), run.checkedAt);
  application.registerSource?.({ id: sourceId, name: '中国建设银行', monitoringObjectIds: ['seed-04'], kind: 'recruitment', scope: 'SH公开社招全列表分页与选中岗位／所属公告及附件；申请路径依证据，匿名读取受限时保留缺口' });
  let checking = false, activeFetch = sourceFetch;
  async function request(url, binary = false) {
    application.assertSourceRequestAllowed(sourceId);
    const response = await activeFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(sourceTimeoutMs), timeoutMs: sourceTimeoutMs });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new Error('建行响应超过8MiB边界');
    return { url, status: response.status, readAt: now().toISOString(), rawHash: hash(bytes), ...(binary ? { bytes } : { raw: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }) };
  }
  function decode(response) {
    if (response.status !== 200) throw new Error(`建行公开查询HTTP ${response.status}`);
    if (!response.raw.trim()) throw new Error('建行公开查询HTTP200空响应；动态数据未取得，不能宣称无岗位或无新增');
    let data; try { data = JSON.parse(response.raw); } catch { throw new Error('建行公开查询不是完整JSON；可能占位或结构变化'); }
    if (data.SUCCESS === 'false' || data.SUCCESS === false) throw new Error(`建行公开查询失败：${data.ERRORMSG ?? data.ERRORCODE ?? '状态异常'}`);
    return data;
  }
  async function readAnnouncement(candidate, run) {
    const existing = run.announcements.find(item => item.id === String(candidate.annoId));
    if (existing) return existing;
    const response = await request(endpoint('NHR106', { annoId: String(candidate.annoId) }));
    const entry = { id: String(candidate.annoId), response, attachments: [], matched: false }; run.announcements.push(entry); save(run);
    const data = decode(response);
    if (!data.annoTitle || !data.annoContent || (data.attachList != null && !Array.isArray(data.attachList))) throw new Error('建行公共公告正文或附件清单结构无效');
    entry.data = data; entry.attachmentListDisclosure = data.attachList == null ? '未列示附件字段，页面不显示附件' : '已列示附件清单';
    entry.tables = readHtmlTables(data.annoContent, { plain });
    entry.originalText = plain(data.annoContent) + entry.tables.map(table => `\n【公告表格${table.tableIndex}，合并单元格展开】\n${table.expandedText}`).join('');
    entry.attachmentInputs = [];
    for (const attachment of data.attachList ?? []) {
      if (typeof attachment.filePath !== 'string' || !attachment.file_Name) throw new Error('公告附件身份不完整');
      const url = `${site}/tran/FileDownloadZPServlet?${new URLSearchParams({ param: attachment.filePath })}`;
      const evidence = { name: attachment.file_Name, url, status: null }; entry.attachments.push(evidence);
      try {
        const content = await request(url, true); Object.assign(evidence, { status: content.status, rawHash: content.rawHash, byteCount: content.bytes.length, readAt: content.readAt });
        if (content.status !== 200 || !content.bytes.length) throw new Error('附件为空或HTTP失败');
        const mediaTypes = { pdf: 'application/pdf', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };
        entry.attachmentInputs.push({ name: attachment.file_Name, mediaType: mediaTypes[attachment.file_Name.split('.').at(-1).toLowerCase()], contentBase64: content.bytes.toString('base64') });
      } catch (error) { evidence.error = error.message; entry.attachmentInputs.push({ name: attachment.file_Name }); run.gaps.push(`附件${attachment.file_Name}未取得：${error.message}`); }
    }
    const contentHash = hash(JSON.stringify({ text: entry.originalText, attachments: entry.attachmentInputs })), externalId = `announcement:${entry.id}`;
    const cached = db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId, externalId, sourceProcessingKey(contentHash));
    let announcement = cached ? application.getAnnouncement(cached.announcement_id) : null;
    if (!announcement) {
      announcement = await application.createAnnouncement({ title: data.annoTitle, originalText: entry.originalText, sourceUrl: `${site}/cn/job/announcement.html?annoId=${encodeURIComponent(entry.id)}`, evidenceUse: 'unverified', attachments: entry.attachmentInputs });
      db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId, externalId, sourceProcessingKey(contentHash), announcement.id);
    }
    entry.originalAnnouncementId = announcement.id; entry.cached = !!cached;
    run.gaps.push(...entry.tables.flatMap(table => table.gaps ?? [])); run.businessGaps.push(...announcement.gaps);
    const unread = announcement.attachments.filter(item => item.status !== 'read');
    run.gaps.push(...unread.map(item => `${item.name}：${item.error ?? '附件未完整读取'}`));
    if (unread.length) run.attachmentReadFailed = true;
    save(run); return entry;
  }
  return {
    getCcbSourceCoverage() {
      const coverage=application.getSourceCoverageHistory(sourceId);
      return { sourceId, implemented: true, scope: '公开SH社招全部分页；仅选中岗位、关联公共公告与附件及申请路径', ...coverage };
    },
    async checkCcbSource({ postIds = [], announcementIds = [], trigger = 'manual', scheduledFor = null, processJobs = true, listOnly = false } = {}) {
      if (!['manual', 'scheduled'].includes(trigger) || (trigger === 'scheduled' && (typeof scheduledFor !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor) || !Number.isFinite(Date.parse(scheduledFor))))) throw new Error('来源计划检查需有效触发方式及含时区的计划时刻');
      if (!Array.isArray(postIds) || postIds.length > 20 || postIds.some(id => typeof id !== 'string' || !/^[\w-]+:[\w-]+:[\w-]+$/.test(id))) throw new Error('选中岗位身份需为不超过20项计划:岗位:二级机构ID');
      if (!Array.isArray(announcementIds) || announcementIds.length > 20 || announcementIds.some(id => typeof id !== 'string' || !/^[\w-]+$/.test(id))) throw new Error('选中公告需为不超过20项官方公告ID');
      if (checking) throw new Error('建行来源检查正在进行，请勿重叠运行');
      checking = true;
      const run = { id: randomUUID(), sourceId, checkedAt: now().toISOString(), trigger, scheduledFor, status: 'checking', stage: 'official_chain', officialChain: [], pages: [], listings: [], listCount: 0, listComplete: false, details: [], announcements: [], applicationPaths: [], jobIds: [], gaps: [], businessGaps: [], error: null };
      save(run);
      let publicSession;
      try {
        if(sourceFetch===fetchCcbPublic){publicSession=await createCcbPublicSession();activeFetch=publicSession.fetch;}
        const page = await request(socialUrl); run.officialChain.push(page); save(run);
        if (page.status !== 200 || !page.raw.includes('/cn/job/v3/js/job_list.js') || !page.raw.includes('社会招聘')) throw new Error('建行官方社招页面未取得或结构变化');
        run.stage = 'list';
        let totalPages = 1, totalRecords;
        for (let page = 1; page <= totalPages; page++) {
          const response = await request(endpoint('NHR104', { keyWord: '', planType: 'SH', orgId: '', planPostId: '', planId: '', PAGE_JUMP: String(page), REC_IN_PAGE: '10' }));
          run.pages.push(response); save(run);
          const data = decode(response); const count = Number(data.TOTAL_PAGE);
          if (count === 0 && data.TOTAL_REC === '0' && data.planPostList == null) data.planPostList = [];
          if (!Array.isArray(data.planPostList) || !Number.isInteger(count) || count < 0 || count > 100 || (page > 1 && count !== totalPages) || (!count && data.planPostList.length)) throw new Error('建行社招分页结构或总页数异常');
          if (data.CURR_TOTAL_PAGE != null && Number(data.CURR_TOTAL_PAGE) !== page) throw new Error('建行社招响应页号与请求不同');
          if (data.TOTAL_REC != null) {
            const records = Number(data.TOTAL_REC);
            if (!Number.isInteger(records) || records < 0 || records > 10000 || (totalRecords != null && totalRecords !== records)) throw new Error('建行社招总数无效或检查中变化');
            totalRecords = records;
          } else if (totalRecords != null) throw new Error('建行社招后续页丢失总数');
          totalPages = count;
          for (const item of data.planPostList) {
            if (item.planType !== 'SH' || !item.planId || !item.planPost || !item.secondOrgId || !item.orgId || !item.planPostName) throw new Error('建行列表岗位身份／社招类型未确认，校招不能冒充社招');
            run.listings.push(item);
          }
          run.listCount = run.listings.length; save(run);
        }
        if ((totalRecords != null && totalRecords !== run.listCount) || new Set(run.listings.map(item => `${item.planId}:${item.planPost}:${item.secondOrgId}`)).size !== run.listCount) throw new Error('建行列表总数不符或跨页身份重复，完整覆盖未确认');
        run.listComplete = true;
        run.stage = 'announcements';
        run.announcementPages = []; run.announcementList = [];
        let annoPages = 1;
        for (let page = 1; page <= annoPages; page++) {
          const response = await request(endpoint('NHR105', { planType: 'SH', isHomePageDisplay: '0', PAGE_JUMP: String(page), REC_IN_PAGE: '15' }));
          run.announcementPages.push(response); save(run); const data = decode(response), count = Number(data.TOTAL_PAGE);
          if (count === 0 && data.TOTAL_REC === '0' && data.annoList == null) data.annoList = [];
          if (!Array.isArray(data.annoList) || !Number.isInteger(count) || count < 0 || count > 100 || (page > 1 && count !== annoPages) || (!count && data.annoList.length)) throw new Error('建行社招公共公告分页结构异常');
          annoPages = count; run.announcementList.push(...data.annoList);
        }
        if (run.announcementList.some(item => !item.annoId) || new Set(run.announcementList.map(item => item.annoId)).size !== run.announcementList.length) throw new Error('建行公告列表ID缺失或跨页重复');
        run.announcementListComplete = true;
        for (const annoId of [...new Set(announcementIds)]) {
          const candidate = run.announcementList.find(item => String(item.annoId) === annoId);
          if (!candidate) { run.gaps.push(`选中公告${annoId}未在完整SH公告列表中，未绕过类型核验`); continue; }
          await readAnnouncement(candidate, run);
        }
        if (postIds.length) {
          run.statusMapping = await request(`${site}/cn/job/v3/js/job_detail.js`); save(run);
          const mapping = run.statusMapping.raw.match(/planStatus:\s*\{\s*1:\s*['"]正在报名['"]\s*,\s*2:\s*['"]报名结束['"]\s*\}/);
          if (run.statusMapping.status !== 200 || !mapping) throw new Error('建行报名状态公开映射变化，不能推断开放或结束');
          run.statusMapping.mappingQuote = mapping[0];
        }
        const announced = new Map();
        for (const externalId of [...new Set(postIds)]) {if(!application.isSourceSelectionAllowed(sourceId,externalId))continue;
          const item = run.listings.find(item => `${item.planId}:${item.planPost}:${item.secondOrgId}` === externalId);
          if (!item) { run.businessGaps.push(`选中岗位${externalId}未在本次SH列表中；不关闭旧岗位`); continue; }
          run.stage = 'detail';
          const response = await request(endpoint('NHR107', { planId: item.planId, planPost: item.planPost, planType: 'SH', orgId: item.secondOrgId }));
          const entry = { externalId, response, attachments: [], announcementId: null }; run.details.push(entry); save(run);
          const detail = decode(response);
          if (detail.planPostName !== item.planPostName || !detail.orgName || !detail.secondOrgName || !detail.cityName || !detail.postDesc || !detail.PostRequest || !detail.planName || !['1', '2'].includes(String(detail.planStatus)) || (detail.planType != null && detail.planType !== 'SH')) throw new Error('建行选中详情关键字段不完整或社招身份不一致');
          entry.validated = true;
          const parameters = new URLSearchParams({ planId: item.planId, planPost: item.planPost, planType: 'SH', orgId: item.orgId, secondOrgId: item.secondOrgId });
          const applicationUrl = `${site}/cn/job/job_detail.html?${parameters}`;
          entry.applicationPage = await request(applicationUrl); run.applicationPaths.push({ externalId, url: applicationUrl, status: entry.applicationPage.status, loginRequired: true, submitted: false }); save(run);
          if (entry.applicationPage.status !== 200 || !entry.applicationPage.raw.includes('/cn/job/v3/js/job_detail.js')) throw new Error('岗位申请详情页未取得或结构变化');
          const exactTitleMatches=run.announcementList.filter(anno=>anno.annoTitle===detail.planName);
          const candidates = run.announcementList.filter(anno => String(anno.planId ?? '') === String(item.planId) || announcementIds.includes(String(anno.annoId)) || (exactTitleMatches.length===1&&anno===exactTitleMatches[0]));
          let commonText = '', attachmentInputs = [];
          for (const candidate of candidates) {
            const saved = await readAnnouncement(candidate, run);
            announced.set(candidate.annoId, saved);
            const data = saved.data;
            if (String(data.planId ?? '') !== String(item.planId) || String(data.orgId ?? '') !== String(item.orgId) || (data.planType != null && data.planType !== 'SH')) { run.gaps.push(`公告${candidate.annoId}与选中社招计划关联未确认，未附到岗位`); continue; }
            saved.matched = true;
            commonText += `\n【关联公共公告：${data.annoTitle}】\n${saved.originalText}`;
            attachmentInputs.push(...saved.attachmentInputs); entry.attachments.push(...saved.attachments);
          }
          const end = detail.endTime ?? null;
          const observedOpen = String(detail.planStatus) === '1' && !(typeof end === 'string' && /^\d{4}-\d{2}-\d{2}/.test(end) && end.slice(0, 10) < run.checkedAt.slice(0, 10));
          const identity = { title: detail.planPostName, recruitmentUnit: detail.orgName, department: detail.secondOrgName, batch: null, sourceIdentity: { sourceId, externalId }, observedAt: run.checkedAt, dateEvidence: end ? [{ field: 'endTime', raw: end, meaning: /^\d{4}-\d{2}-\d{2}$/.test(end) ? 'explicit_deadline' : 'unverified', evidence: [{ quote: end }], note: '平台标示网申截止；精确时区及端点时刻未核验' }] : [], recruitmentStatus: observedOpen ? 'publicly_listed_open' : 'unverified', sourceEvidence: { sourceId, listed: true, planType: 'SH', planId: item.planId, planPost: item.planPost, orgId: item.orgId, secondOrgId: item.secondOrgId, planStatus: detail.planStatus, planName: detail.planName, applicationUrl, checkedAt: run.checkedAt, commonAnnouncementIds: candidates.filter(c => announced.get(c.annoId)?.matched).map(c => c.annoId) } };
          const originalText = `建行公开社招选中岗位（SH，不保证内部名额或本人符合）\n岗位：${identity.title}\n招聘单位：${identity.recruitmentUnit}\n部门／二级机构：${identity.department}\n招聘计划：${detail.planName}\n批次：未披露；计划名称不自动作为批次\n地点：${detail.cityName}\n职责：\n${plain(detail.postDesc)}\n岗位要求：\n${plain(detail.PostRequest)}\n${commonText || '公共条件未取得，不代表没有公共条件。'}\n网申截止原值：${end ?? '未披露'}\n报名状态原值：${detail.planStatus}\n岗位申请页：${applicationUrl}\n在岗位详情点击应聘岗位，登录后依官方流程填写简历及申请。签约主体未披露。`;
          const contentHash = hash(JSON.stringify({ title: identity.title, unit: identity.recruitmentUnit, department: identity.department, batch: identity.batch, location: detail.cityName, duties: plain(detail.postDesc).replace(/\s+/g, ' '), conditions: plain(detail.PostRequest).replace(/\s+/g, ' '), common: commonText.replace(/\s+/g, ' '), attachments: attachmentInputs }));
          const cached = db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId, externalId, sourceProcessingKey(contentHash));
          let announcement = cached ? application.getAnnouncement(cached.announcement_id) : null;
          if (!announcement) {
            announcement = await application.createAnnouncement({ title: identity.title, originalText, sourceUrl: applicationUrl, evidenceUse: observedOpen ? 'current' : 'unverified', attachments: attachmentInputs, jobIdentities: [identity], targetJobs: [{ title: identity.title, recruitmentUnit: identity.recruitmentUnit, department: identity.department, batch: identity.batch }] });
            db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId, externalId, sourceProcessingKey(contentHash), announcement.id);
          }
          entry.announcementId = announcement.id; entry.cached = !!cached; save(run);
          const direction=jobRelevance({title:identity.title,duties:plain(detail.postDesc)}),location=targetLocation({location:{options:[detail.cityName]}});
          const skipped=!observedOpen?'官方报名已结束或截止日期已过':direction.status==='out_of_scope'?direction.reason:location.status!=='included'?location.reason:direction.status!=='relevant'?'尚无明确软件算法技术职责，保留原文，不调用模型':null;
          if(skipped){entry.processingStatus='scope_excluded';entry.processingSkipped=skipped;save(run);continue;}
          if (!commonText) run.gaps.push(`${externalId}所属公共公告／完整公共条件尚未核验`);
          if (!processJobs) { run.gaps.push(`${externalId}原文已取得但未加工`); continue; }
          run.stage = 'processing'; announcement = await application.processAnnouncement(announcement.id);
          if(announcement.status==='scope_excluded'){entry.processingStatus=announcement.status;entry.processingSkipped=announcement.processingSkipped;save(run);continue;}
          if(['deferred','scope_pending'].includes(announcement.status)){entry.processingStatus=announcement.status;entry.processingDecision=announcement.sourceProcessingDecision;run.businessGaps.push(announcement.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));save(run);continue;}
          if (announcement.status === 'failed' || !announcement.jobIds.length) throw new Error(`建行岗位加工失败：${announcement.error ?? '未生成可采用岗位'}`);
          for (const id of announcement.jobIds) {
            const job = application.getSourceJob(id);
            if (!job.sourceIdentities?.some(item => item.sourceId === sourceId && item.externalId === externalId)) throw new Error('选中岗位加工身份无法唯一对应，不能计入来源成功');
            run.jobIds.push(application.importJob({ ...job, ...identity, originalText: job.originalText }).job.id);
          }
          run.businessGaps.push(...announcement.gaps);
          const unread = announcement.attachments.filter(item => item.status !== 'read');
          run.gaps.push(...unread.map(item => `${item.name}：${item.error ?? '附件未完整读取'}`));
          if (unread.length) run.attachmentReadFailed = true;
        }
        if (!postIds.length) run.businessGaps.push('仅检查SH列表，未选择具体岗位；全部详情及公共条件未核验');
        run.status = run.gaps.length ? 'partial' : 'success'; run.stage = run.attachmentReadFailed ? 'attachment' : 'completed';
      } catch (error) { run.status = 'failed'; run.error = error.message; run.gaps.push(error.message); }
      finally {
        if(publicSession)await publicSession.close();activeFetch=sourceFetch;
        run.finishedAt = now().toISOString();
        const text = JSON.stringify(run);
        for (const row of db.prepare('SELECT id FROM jobs').all()) {
          const job = application.getSourceJob(row.id);
          for (const identity of job.sourceIdentities ?? []) {
            if (identity.sourceId !== sourceId) continue;
            const listing = run.listings.find(item => `${item.planId}:${item.planPost}:${item.secondOrgId}` === identity.externalId);
            const entry = run.details.find(item => item.externalId === identity.externalId && item.validated);
            const data = entry ? JSON.parse(entry.response.raw) : null;
            const evidence = { url: entry?.response.url ?? run.pages[0]?.url ?? socialUrl, text, quote: run.id, locator: '来源检查及完整SH分页' };
            const observation = { id: `${run.id}:${job.id}`, sourceId, externalId: identity.externalId, observedAt: run.checkedAt, acquisition: run.listComplete ? 'success' : 'failed', listComplete: run.listComplete, listed: run.listComplete ? !!listing : null, detailAccessible: entry ? true : null, applicationOpen: entry ? String(data.planStatus) === '1' : null, evidence, sourceCheckId: run.id, error: run.error };
            if (entry && /^\d{4}-\d{2}-\d{2}$/.test(data.endTime ?? '')) observation.deadline = { raw: data.endTime, evidence: { ...evidence, quote: data.endTime, locator: 'NHR107 endTime；页面标示网申截止日期，日级不补时刻' } };
            if (entry && String(data.planStatus) === '2' && run.statusMapping?.mappingQuote) observation.explicitEnd = { url: run.statusMapping.url, text, quote: run.statusMapping.mappingQuote, locator: 'NHR107 planStatus=2及公开页面映射' };
            try { application.recordRecruitmentObservation?.(job.id, observation); }
            catch (error) { run.gaps.push(`招聘状态证据未采用：${error.message}`); if (run.status === 'success') run.status = 'partial'; }
          }
        }
        save(run); checking = false; application.recordSourceCheck?.(run);
      }
      return structuredClone(run);
    },
  };
}
