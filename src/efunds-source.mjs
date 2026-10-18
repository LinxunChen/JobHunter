import {sourceProcessingKey} from './local-settings.mjs';
import { randomUUID, createHash } from 'node:crypto';
const tenant = 'SU67ac68866202cc7916aea66e';
const platform = 'https://wecruit.hotjob.cn';
const site = `${platform}/${tenant}/pb`;
const endpoint = action => `${platform}/wecruit/positionInfo/${action}/${tenant}?iSaJAx=isAjax&request_locale=zh_CN`;
const sourceId = 'efunds-social';
const defaultPostId = '62fd32a72f9d2421b983ae01';

export function createEfundsOperations({ db, now, application, sourceFetch = fetch, sourceTimeoutMs = 20000 }) {
  db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL, checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL, announcement_id TEXT NOT NULL, PRIMARY KEY(source_id,external_id,content_hash))');
  const save = run => db.prepare('INSERT INTO source_checks(id,source_id,body,checked_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, sourceId, JSON.stringify(run), run.checkedAt);
  const checks = () => db.prepare('SELECT body FROM source_checks WHERE source_id=? ORDER BY rowid DESC').all(sourceId).map(row => JSON.parse(row.body));
  let checking = false;
  async function request(url, options = {}) {
    application.assertSourceRequestAllowed(sourceId);
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await sourceFetch(url, { ...options, redirect: 'manual', signal: controller.signal });
          const raw = await response.text();
          if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('来源响应超过5MiB读取边界');
          return { url, status: response.status, location: response.headers.get('location'), readAt: now().toISOString(), rawHash: createHash('sha256').update(raw).digest('hex'), raw };
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`来源请求超时（${sourceTimeoutMs}ms）`)); }, sourceTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function json(action, params) {
    const encoded=new URLSearchParams(params).toString();
    // Give each public list page an explicit URL identity as well as form fields.
    const response = await request(endpoint(action)+(action==='listPosition'?'&'+encoded:''), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: encoded });
    if (response.status !== 200) throw new Error(`来源HTTP ${response.status}：${action}`);
    let data;
    try { data = JSON.parse(response.raw); } catch { throw new Error(`来源JSON解析失败：${action}`); }
    if (String(data.state) !== '200') throw new Error(`来源返回失败：${action} state=${data.state}`);
    return { ...response, requestParameters: params, raw: data };
  }
  return {
    getSourceCoverage(id = sourceId) {
      if (id !== sourceId) return null;
      const coverage=application.getSourceCoverageHistory(sourceId);
      return { sourceId, implemented: true, scope: '全部公开社招列表；仅选中岗位详情及申请页；附件未检索', ...coverage };
    },
    async checkEfundsSource({ postIds = application.getSourceSettings?.(sourceId).postIds ?? [defaultPostId], trigger = 'manual', scheduledFor = null, listOnly = false } = {}) {
      if (!['manual','scheduled'].includes(trigger) || (trigger === 'scheduled' && (typeof scheduledFor !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor) || !Number.isFinite(Date.parse(scheduledFor))))) throw new Error('来源计划检查需有效触发方式及含时区的计划时刻');
      if (checking) throw new Error('易方达来源检查正在进行，请勿重叠运行');
      if (!Array.isArray(postIds) || (!postIds.length && !listOnly) || postIds.length > 20 || postIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))) throw new Error('选中岗位必须为1—20项平台岗位ID');
      checking = true;
      const run = { id: randomUUID(), sourceId, checkedAt: now().toISOString(), trigger, scheduledFor, listOnly, selectedPostIds: [...new Set(postIds)], status: 'checking', stage: 'official_chain', officialChain: [], pages: [], listCount: 0, listComplete: false, details: [], attachmentsChecked: 0, jobIds: [], gaps: [], businessGaps: [], error: null };
      save(run);
      try {
        let url = 'https://job.efunds.com.cn/';
        for (let hop = 0; hop < 5; hop++) {
          const response = await request(url);
          run.officialChain.push(response); save(run);
          if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
            url = new URL(response.location, url).href;
            if (!['job.efunds.com.cn', 'wecruit.hotjob.cn'].includes(new URL(url).hostname) || new URL(url).protocol !== 'https:') throw new Error('官方跳转到未核验平台，停止导入');
            continue;
          }
          if (response.status !== 200 || !url.startsWith(site + '/')) throw new Error('官方链未到达已核验招聘站');
          break;
        }
        if (run.officialChain.at(-1)?.status !== 200) throw new Error('官方跳转链未完成');
        run.stage = 'list';
        const social = await request(site + '/social.html');
        run.socialPage = social;
        if (social.status !== 200 || !social.raw.includes('/pb/js/social.js')) throw new Error('社招页面结构变化，需重新核验');
        const listings = [];
        let totalPage = 1, dataCount, pageSize = 10;
        for (let currentPage = 1; currentPage <= totalPage; currentPage++) {
          const response = await json('listPosition', { isFrompb: 'true', recruitType: '2', pageSize: String(pageSize), currentPage: String(currentPage) });
          run.lastListResponse = response; save(run);
          const page = response.raw.data?.pageForm;
          if (!page || !Array.isArray(page.pageData) || page.currentPage !== currentPage || !Number.isInteger(page.totalPage) || page.totalPage < 1 || page.totalPage > 100 || !Number.isInteger(page.pageSize) || page.pageSize < 1 || !Number.isInteger(page.dataCount) || page.dataCount < 0) throw new Error('社招列表分页结构无效');
          if (currentPage > 1 && (totalPage !== page.totalPage || dataCount !== page.dataCount || pageSize !== page.pageSize)) throw new Error('社招列表分页数量在检查中变化，未确认完整覆盖');
          totalPage = page.totalPage; dataCount = page.dataCount; pageSize = page.pageSize;
          if (page.pageData.some(item => typeof item.postId !== 'string' || item.recruitType !== 2)) throw new Error('社招列表岗位身份或招聘类型无效');
          listings.push(...page.pageData); run.pages.push(response); run.listCount = listings.length; save(run);
        }
        if (new Set(listings.map(item => item.postId)).size !== dataCount || listings.length !== dataCount) throw new Error('社招列表数量不符或跨页重复，未确认完整覆盖');
        run.listComplete = true;
        for (const postId of [...new Set(postIds)]) {if(!application.isSourceSelectionAllowed(sourceId,postId))continue;
          const listing = listings.find(item => item.postId === postId);
          if (!listing) { run.businessGaps.push(`选中岗位${postId}未在本次完整公开列表中；不据此关闭旧岗位`); continue; }
          run.stage = 'detail';
          run.detailAttempts??=[];run.detailAttempts.push({externalId:postId,at:now().toISOString()});save(run);
          const response = await json('listPositionDetail', { postId, recruitType: '2' });
          const detail = response.raw.data;
          run.details.push(response); save(run);
          if (!detail || detail.postId !== postId || detail.recruitType !== 2 || detail.postName !== listing.postName || !detail.company || !detail.workContent || !detail.serviceCondition) throw new Error(`选中岗位${postId}详情关键字段不完整或不一致`);
          const applicationUrl = `${site}/posDetail.html?postId=${postId}&postType=society`;
          const applicationPage = await request(applicationUrl);
          run.details.at(-1).applicationPage = applicationPage;
          if (applicationPage.status !== 200 || !applicationPage.raw.includes('/pb/js/posDetail.js')) throw new Error('岗位申请页未取得或结构变化');
          if (detail.canDelivery !== true || detail.showDeliverButton !== 1) run.businessGaps.push(`岗位${postId}当前申请按钮未开放或状态待核验，继续更新条件，不据此判断招聘结束`);
          run.stage = 'processing';
          const dateEvidence = ['publishFirstDate', 'publishDate', 'endDate'].filter(field => detail[field]).map(field => ({ field, raw: detail[field], meaning: 'unverified' }));
          const sourceEvidence = { sourceId, officialChain: run.officialChain.map(({ url, status, location }) => ({ url, status, location })), listUrl: endpoint('listPosition'), detailUrl: endpoint('listPositionDetail'), applicationUrl, checkedAt: run.checkedAt, listed: true, canDelivery: detail.canDelivery, listCanDelivery: listing.canDelivery ?? null, postCode: detail.postCode, projectName: detail.projectName ?? null, projectId: detail.projectId ?? null, recruitType: 2 };
          const identity = { title: detail.postName, recruitmentUnit: detail.company, department: detail.department ?? null, batch: null, sourceIdentity: { sourceId, externalId: postId, stableCode: detail.postCode }, observedAt: run.checkedAt, refreshedAt: detail.publishDate ?? null, dateEvidence, sourceEvidence, recruitmentStatus: detail.canDelivery === true && detail.showDeliverButton === 1 ? 'publicly_listed_open' : 'unverified' };
          const facts = { title: detail.postName, company: detail.company, department: detail.department ?? null, batch: null, education: detail.education ?? null, locations: detail.workPlaceList?.map(item => item.name) ?? [], duties: detail.workContent, conditions: detail.serviceCondition, applicationUrl };
          const plainHash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
          const formatting = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : Array.isArray(value) ? value.map(formatting) : value;
          const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, formatting(value)])))).digest('hex');
          const cached = db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash IN (?,?)').get(sourceId, postId, sourceProcessingKey(hash), sourceProcessingKey(plainHash));
          if (cached) db.prepare('INSERT OR IGNORE INTO source_processing VALUES(?,?,?,?)').run(sourceId, postId, sourceProcessingKey(hash), cached.announcement_id);
          let announcement;
          if (cached) announcement = application.getAnnouncement(cached.announcement_id);
          if (!announcement) {
            const originalText = `官方当前社招岗位（公开列示不保证内部名额，不判本人全部符合）\n岗位：${facts.title}\n招聘单位：${facts.company}\n部门：${facts.department ?? '未披露'}\n招聘项目：${detail.projectName ?? '未披露'}\n招聘批次：未披露\n学历：${facts.education ?? '未披露'}\n地点公开选项：${facts.locations.join('、')}\n工作职责：\n${facts.duties}\n任职条件：\n${facts.conditions}\n岗位申请页：${applicationUrl}\n申请步骤：点击申请职位，登录后依官方流程填写简历并申请。\n平台原始日期（语义未核验，不能视为确定发布或报名截止）：${JSON.stringify(dateEvidence)}\n签约主体未披露。`;
            announcement = await application.createAnnouncement({ title: facts.title, originalText, sourceUrl: applicationUrl, evidenceUse: 'current', jobIdentities: [identity] });
            db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId, postId, sourceProcessingKey(hash), announcement.id);
          }
          announcement=application.recordAnnouncementProcessingObservation(announcement.id,{sourceUrl:applicationUrl,title:facts.title,checkedAt:run.checkedAt,applicationOpen:detail.canDelivery===true&&detail.showDeliverButton===1,locations:facts.locations});
          announcement = await application.processAnnouncement(announcement.id);
          response.externalId=postId;response.announcementId=announcement.id;
          if(announcement.status==='scope_excluded'){response.processingStatus=announcement.status;response.processingSkipped=announcement.processingSkipped;save(run);continue;}
          if(['deferred','scope_pending'].includes(announcement.status)){response.processingStatus=announcement.status;response.processingDecision=announcement.sourceProcessingDecision;run.businessGaps.push(announcement.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));save(run);continue;}
          if (announcement.status === 'failed') throw new Error(`岗位加工失败：${announcement.error}`);
          if (!announcement.jobIds.length) throw new Error('岗位加工未生成可采用岗位');
          for (const id of announcement.jobIds) {
            const job = application.getSourceJob?.(id) ?? application.getJob(id);
            if (!job.sourceIdentities?.some(item => item.sourceId === sourceId && item.externalId === postId)) throw new Error('岗位加工未关联来源身份；需核对加工字段');
            const updated = application.importJob({ ...job, ...identity, originalText: job.originalText });
            run.jobIds.push(updated.job.id);
          }
          run.businessGaps.push(...announcement.gaps);
          run.gaps.push(...announcement.attachments.filter(item=>item.status!=='read').map(item=>`${item.name}：${item.error??'附件未取得'}`));
        }
        run.status = run.gaps.length ? 'partial' : 'success';
        run.stage = 'completed';
      } catch (error) { run.status = 'failed'; run.error = error.message; }
      finally { run.finishedAt = now().toISOString(); save(run); checking = false; application.recordSourceCheck?.(run); }
      return structuredClone(run);
    },
  };
}
