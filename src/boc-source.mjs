import {sourceProcessingKey} from './local-settings.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { bocAssociationRules, matchBocAssociation, hasBocPlatformLink } from './boc-associations.mjs';
import { readHtmlTables,readHtmlContentDiv } from './boc-html.mjs';

const sourceId = 'boc-social';
const indexUrl = 'https://www.boc.cn/aboutboc/bi4/';
const platformUrl = 'https://chrcmp.chinahr.com/pages/boc-social/';
const digest = raw => createHash('sha256').update(raw).digest('hex');
const decode = text => text.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
const plain = html => decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(?:p|div|tr|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<\/(?:td|th)>/gi, ' | ').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();

export function createBocOperations({ db, now, application, sourceFetch = fetch, sourceTimeoutMs = 20000, associationRules = bocAssociationRules }) {
  db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL, checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL, announcement_id TEXT NOT NULL, PRIMARY KEY(source_id,external_id,content_hash))');
  const save = run => db.prepare('INSERT INTO source_checks(id,source_id,body,checked_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, sourceId, JSON.stringify(run), run.checkedAt);
  let checking = false;
  const register = () => application.registerSource?.({ id: sourceId, name: '中国银行', monitoringObjectIds: ['seed-01'], kind: 'recruitment', scope: '官网全部栏目及选中公告／附件；指定平台公开项目列表及选中申请路径，有用当前机会依证据' });
  register();
  async function request(url, binary = false) {
    application.assertSourceRequestAllowed(sourceId);
    const response = await sourceFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(sourceTimeoutMs) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new Error('中行来源响应超过8MiB读取边界');
    return { url, status: response.status, location: response.headers.get('location'), readAt: now().toISOString(), rawHash: digest(bytes), ...(binary ? { bytes } : { raw: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }) };
  }
  async function jsonp(endpoint, parameters) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ ...parameters, callback: 'bocReadOnly' });
    const response = await request(url.href);
    if (response.status !== 200) throw new Error(`中行公开平台HTTP ${response.status}`);
    const match = response.raw.match(/^\s*(?:\/\*\*\/)?\s*bocReadOnly\(([\s\S]*)\);?\s*$/);
    if (!match) throw new Error('中行公开JSONP结构变化，不执行返回脚本');
    let data;
    try { data = JSON.parse(match[1]); } catch { throw new Error('中行公开JSONP内容无效'); }
    if (data.code !== 1 || !Array.isArray(data.retMsg) || !Number.isInteger(data.totalCount) || data.totalCount < 0 || data.totalCount > 10000) throw new Error('中行公开平台列表数量或返回状态无效');
    return { ...response, data };
  }
  return {
    getBocSourceCoverage() {
      const coverage=application.getSourceCoverageHistory(sourceId);
      return { sourceId, implemented: true, scope: '官网全部招聘栏目分页；选中公告／附件；指定社招平台公开列表及选中申请路径', ...coverage };
    },
    async checkBocSource({ announcementUrls = [], postIds = [], platformPageSize = 20, processAnnouncements = true, announcementScopes = {}, trigger = 'manual', scheduledFor = null } = {}) {
      if (!['manual','scheduled'].includes(trigger) || (trigger === 'scheduled' && (typeof scheduledFor !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor) || !Number.isFinite(Date.parse(scheduledFor))))) throw new Error('来源计划检查需有效触发方式及含时区计划时刻');
      if (checking) throw new Error('中行来源检查正在进行，请勿重叠运行');
      if (!Number.isInteger(platformPageSize) || platformPageSize < 1 || platformPageSize > 100) throw new Error('中行公开平台每页数量必须为1—100');
      if (!Array.isArray(announcementUrls) || announcementUrls.length > 10 || announcementUrls.some(url => typeof url !== 'string' || !/^https:\/\/www\.boc\.cn\/aboutboc\/bi4\/\d{6}\/t\d+_\d+\.html$/.test(url))) throw new Error('公告必须为不超过10项官方栏目详情URL');
      if (!Array.isArray(postIds) || postIds.length > 20 || postIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))) throw new Error('选中平台岗位必须为不超过20项公开岗位ID');
      if (!announcementScopes || typeof announcementScopes !== 'object' || Array.isArray(announcementScopes) || Object.entries(announcementScopes).some(([url, scope]) => !announcementUrls.includes(url) || !scope || !scope.targetJob || Object.keys(scope).some(key => !['targetJob','documentScopes'].includes(key)) || Object.keys(scope.targetJob).some(key => !['title','recruitmentUnit','department','batch'].includes(key)) || typeof scope.targetJob.title !== 'string' || !scope.targetJob.title.trim() || ['recruitmentUnit','department','batch'].some(key => scope.targetJob[key] != null && (typeof scope.targetJob[key] !== 'string' || !scope.targetJob[key].trim())) || (scope.documentScopes != null && !Array.isArray(scope.documentScopes)))) throw new Error('公告选中范围必须含可核对的唯一岗位及附件段落');
      register();
      checking = true;
      const run = { id: randomUUID(), sourceId, checkedAt: now().toISOString(), trigger, scheduledFor, status: 'checking', catalogPages: [], catalog: [], catalogComplete: false, catalogCount: 0, officialChain: [], platformPages: [], platformListComplete: false, platformJobs: [], currentOpportunityConfirmedCount: 0, announcements: [], platformDetails: [], applicationPaths: [], jobIds: [], gaps: [], businessGaps: [], error: null };
      save(run);
      try {
        let count = 1;
        for (let page = 0; page < count; page++) {
          const response = await request(indexUrl + (page ? `index_${page}.html` : ''));
          run.catalogPages.push(response); save(run);
          if (response.status !== 200) throw new Error(`中行栏目第${page + 1}页HTTP ${response.status}`);
          const pagination = response.raw.match(/createPageHTML\(\s*(\d+)\s*,\s*(\d+)\s*,\s*"index"\s*,\s*"html"\s*\)/);
          if (!pagination || Number(pagination[2]) !== page || Number(pagination[1]) < 1 || Number(pagination[1]) > 100 || (page && Number(pagination[1]) !== count)) throw new Error('中行栏目分页结构变化，未确认完整覆盖');
          count = Number(pagination[1]);
          const items = [...response.raw.matchAll(/<a\s+href="(\.\/\d{6}\/t[^" ]+\.html)"\s+title="([^"]+)"/g)].map(match => ({ url: new URL(match[1], response.url).href, title: decode(match[2]), kind: /社会招聘/.test(match[2]) ? 'social' : /校园|实习/.test(match[2]) ? 'campus' : /高层次/.test(match[2]) ? 'high_level' : 'other' }));
          if (!items.length) throw new Error('中行栏目页没有可核对公告条目，不视作无新增');
          run.catalog.push(...items); run.catalogCount = run.catalog.length; save(run);
        }
        if (new Set(run.catalog.map(item => item.url)).size !== run.catalog.length) throw new Error('中行栏目跨页重复，未确认完整覆盖');
        run.catalogComplete = true;
        for (const url of [...new Set(announcementUrls)]) {
          try {
            if (!run.catalog.some(item => item.url === url)) throw new Error('选中公告未在本次完整栏目中，需核对来源关系');
            (run.detailAttempts??=[]).push({externalId:url,at:now().toISOString()});save(run);
            const response = await request(url);
            const entry = { url, response, attachments: [], announcementId: null, cached: false }; run.announcements.push(entry); save(run);
            if (response.status !== 200) throw new Error(`中行公告HTTP ${response.status}`);
            const bodyMatch = readHtmlContentDiv(response.raw,['trs_editor_view','TRS_Editor']);
            const body = bodyMatch?.html;
            const title = plain(response.raw.match(/<h2 class="title">([\s\S]*?)<\/h2>/)?.[1] ?? '');
            if (!body || !title) throw new Error('中行公告正文结构变化，保留原始响应不假称读取完整');
            entry.originalPlainText = plain(body); save(run);
            if(/https?:\/\/campus\.chinahr\.com\//.test(entry.originalPlainText)&&/应届毕业生/.test(entry.originalPlainText)&&!/社会招聘|社会在职/.test(entry.originalPlainText)) {
              entry.processingSkipped='原文确认纯校招，不进入社会招聘自动加工';
              run.businessGaps.push(title+'：'+entry.processingSkipped);save(run);continue;
            }
            entry.tables = readHtmlTables(body, { plain, sourceOffset: bodyMatch.sourceStart });
            const originalText = entry.originalPlainText + entry.tables.map(table => `\n\n【官网表格${table.tableIndex}：原HTML合并单元格展开，列次序与表头一致】\n${table.expandedText}`).join('');
            const chain = originalText.match(/https?:\/\/chrcmp\.chinahr\.com\/pages\/boc-social\/?/);
            if (chain) run.officialChain.push({ fromUrl: url, url: platformUrl, quote: chain[0], status: 200, readAt: response.readAt });
            const attachments = [];
            for (const match of body.matchAll(/<a\b[^>]*href="([^"]+\.(?:pdf|docx|xlsx))"[^>]*>([\s\S]*?)<\/a>/gi)) {
              const attachmentUrl = new URL(decode(match[1]), url).href;
              const name = plain(match[2]);
              const mediaType = attachmentUrl.endsWith('.pdf') ? 'application/pdf' : attachmentUrl.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
              const info = { url: attachmentUrl, name, status: null }; entry.attachments.push(info);
              try {
                if (new URL(attachmentUrl).protocol !== 'https:' || !['pic.bankofchina.com', 'www.boc.cn'].includes(new URL(attachmentUrl).hostname)) throw new Error('附件指向未核验域');
                const content = await request(attachmentUrl, true);
                Object.assign(info, { status: content.status, readAt: content.readAt, rawHash: content.rawHash, bytes: content.bytes.length });
                if (content.status !== 200) throw new Error(`附件HTTP ${content.status}`);
                attachments.push({ name, mediaType, contentBase64: content.bytes.toString('base64') });
              } catch (error) { info.error = error.message; attachments.push({ name, mediaType }); run.gaps.push(`${name}：${error.message}`); }
              save(run);
            }
            const deadline = originalText.match(/(?:北京时间|截止时间[^\n]{0,10})(\d{4})年(\d{1,2})月(\d{1,2})日(?:24时|前|截止)/);
            const end = deadline ? `${deadline[1]}-${deadline[2].padStart(2, '0')}-${deadline[3].padStart(2, '0')}` : null;
            const historical = end && end < now().toISOString().slice(0, 10);
            entry.evidenceUse = historical ? 'historical' : 'unverified';
            entry.deadlineEvidence = deadline ? { field: 'announcementDeadline', raw: deadline[0], meaning: 'explicit_deadline' } : null;
            const scope = announcementScopes[url] ?? null;
            const target = scope ? Object.fromEntries(['title','recruitmentUnit','department','batch'].map(field => [field, scope.targetJob[field] ?? null])) : null;
            if (target && Object.values(target).some(value => value != null && !originalText.includes(value))) throw new Error('选中岗位身份原文不存在，拒绝加工');
            entry.processingScope = scope ? { targetJob: target, documentScopes: scope.documentScopes ?? null } : null;
            const hash = digest(originalText.replace(/\s+/g, ' ') + JSON.stringify(entry.attachments.map(item => ({ url: item.url, rawHash: item.rawHash ?? null, status: item.status }))) + (scope ? JSON.stringify(entry.processingScope) : ''));
            const sourceIdentity = target ? { sourceId, externalId: url + '#selected-' + digest(JSON.stringify(target)) } : null;
            const identity = target ? { ...target, sourceIdentity, observedAt: run.checkedAt, recruitmentStatus: 'unverified', sourceEvidence: { sourceId, announcementUrl: url, identityOrigin: 'derived_from_selected_announcement_fields', checkedAt: run.checkedAt, deadlineRaw: entry.deadlineEvidence?.raw ?? null } } : null;
            // Only associate a prior output of this exact announcement, never a same-name unrelated job.
            const prior = target ? application.listAnnouncements().filter(item => item.sourceUrl === url).flatMap(item => item.jobIds.map(id => application.getSourceJob(id))).filter(job => job && ['title','recruitmentUnit','department','batch'].every(field => (job[field] ?? null) === target[field])) : [];
            const priorIds = [...new Set(prior.map(job => job.id))];
            if (identity && priorIds.length === 1) {
              identity.associationEvidence = { jobId: priorIds[0], kind: 'official_link', url, quote: target.title };
              const existing = prior[0].sourceIdentities?.find(item => item.sourceId === sourceId && item.externalId.startsWith(url + '#'));
              if (existing) identity.sourceIdentity = structuredClone(existing);
            }

            const cached = db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId, url, sourceProcessingKey(hash));
            let announcement = cached && application.getAnnouncement(cached.announcement_id);
            entry.cached = Boolean(announcement);
            if (!announcement) {
              announcement = await application.createAnnouncement({ title, originalText, sourceUrl: url, evidenceUse: entry.evidenceUse, publishedAt: response.raw.match(/class="(?:time|date)"[^>]*>(\d{4}-\d{2}-\d{2})/)?.[1] ?? null, attachments, ...(target ? { targetJobs: [target], jobIdentities: [identity] } : {sourceIdentityContext:{sourceId,externalId:url,observedAt:run.checkedAt,sourceEvidence:{sourceId,announcementUrl:url,checkedAt:run.checkedAt,identityOrigin:'derived_from_announcement_fields',scope:'已取得完整公告与附件；具体岗位身份仍按主体、部门、批次区分'}}}) });
              db.prepare('INSERT OR REPLACE INTO source_processing VALUES(?,?,?,?)').run(sourceId, url, sourceProcessingKey(hash), announcement.id);
            }
            entry.announcementId = announcement.id; save(run);
            if (processAnnouncements) announcement = await application.processAnnouncement(announcement.id, { documentScopes: scope?.documentScopes });
            if (identity?.associationEvidence && ['processed','partial'].includes(announcement.status) && !entry.cached) for (const jobId of announcement.jobIds) {
              const snapshot = application.getJobHistory(jobId).observations.at(-1)?.snapshot;
              if (snapshot?.announcementId === announcement.id) application.importJob({ ...snapshot, ...identity, associationEvidence: undefined });
            }
            entry.jobIds = [...announcement.jobIds];
            entry.processingStatus = announcement.status;
            entry.processingDecision=announcement.sourceProcessingDecision;
            entry.processingSkipped=announcement.processingSkipped??null;
            entry.processingReceipt = announcement.processingReceipt ?? null;
            run.jobIds.push(...announcement.jobIds);
            run.businessGaps.push(...announcement.gaps);
            run.gaps.push(...announcement.attachments.filter(item => item.status !== 'read').map(item => `${item.name}：${item.error ?? '附件未取得'}`));
            if (processAnnouncements && ['processed','partial'].includes(announcement.status) && !announcement.jobIds.length) run.gaps.push('加工未保存具体岗位，保留原文待处理');
            if (announcement.status === 'failed') run.gaps.push(`公告加工失败，保留原文：${announcement.error}`);
          } catch (error) { run.gaps.push(`${url}：${error.message}`); }
        }
        const platform = await request(platformUrl);
        run.officialChain.push(platform); save(run);
        if (platform.status !== 200) throw new Error(`中行社招平台HTTP ${platform.status}`);
        const configMatch = platform.raw.match(/window\.chinahr_cmp_json_data\s*=\s*(\{[^\n]+\})/);
        const scriptMatch = platform.raw.match(/href="([^"]*\/boc-social\/js\/job[^" ]+\.js)"/);
        if (!configMatch || !scriptMatch) throw new Error('中行社招平台项目配置或公开列表脚本未取得');
        const config = JSON.parse(configMatch[1]);
        const scriptUrl = new URL(scriptMatch[1], platformUrl).href;
        if (new URL(scriptUrl).hostname !== 'j1.58cdn.com.cn') throw new Error('中行公开脚本域变化，停止获取');
        const script = await request(scriptUrl); run.platformScript = script; save(run);
        if (script.status !== 200) throw new Error('中行公开列表脚本取得失败');
        // The site's public campaign lookup values are not account credentials.
        const campaign = script.raw.match(/token:"([^"]+)"/)?.[1];
        if (!campaign || !Array.isArray(config.extendSubToken) || config.extendSubToken.length > 10 || config.extendSubToken.some(value => typeof value !== 'string')) throw new Error('中行公开项目标识结构变化');
        const campaigns = [...new Set([campaign, ...config.extendSubToken])];
        const companies = await jsonp('https://ats.chinahr.com/api/company/list', { token: campaigns.join(','), page: '1', pageSize: '10000' });
        run.companies = companies; save(run);
        if (companies.data.retMsg.length !== companies.data.totalCount || new Set(companies.data.retMsg.map(item => item.id)).size !== companies.data.totalCount) throw new Error('中行公开机构列表未完整取得');
        for (let project = 0; project < campaigns.length; project++) {
          const jobs = [];
          let total;
          for (let page = 1; page === 1 || jobs.length < total; page++) {
            if (page > 100) throw new Error('中行平台分页超出有界读取范围');
            const response = await jsonp('https://rms.chinahr.com/api/job/wxz/list', { token: campaigns[project], page: String(page), pageSize: String(platformPageSize) });
            run.platformPages.push({ ...response, project, page }); save(run);
            if (page > 1 && total !== response.data.totalCount) throw new Error('中行平台总数在分页间变化，未确认完整覆盖');
            total = response.data.totalCount;
            if (total > 0 && !response.data.retMsg.length) throw new Error('中行平台未到总数即空页，未确认完整覆盖');
            if (response.data.retMsg.some(item => typeof item.id !== 'string' || !item.name || !item.companyId || !item.companyName || typeof item.jobDesc !== 'string')) throw new Error('中行平台岗位身份或完整职责字段缺失');
            jobs.push(...response.data.retMsg);
          }
          if (jobs.length !== total || new Set(jobs.map(item => item.id)).size !== total) throw new Error('中行公开岗位跨页重复或数量不符，未确认完整覆盖');
          run.platformJobs.push(...jobs.map(job => ({ ...job, project })));
        }
        if (new Set(run.platformJobs.map(job => job.id)).size !== run.platformJobs.length) throw new Error('中行不同公开项目存在重复岗位，需核对关联');
        run.platformListComplete = true;
        for (const postId of [...new Set(postIds)]) {if(!application.isSourceSelectionAllowed(sourceId,postId))continue;
          const post = run.platformJobs.find(job => job.id === postId);
          if (!post) { run.businessGaps.push(`选中岗位${postId}不在本次完整公开列表，不关闭旧岗`); continue; }
          const sourceApplicationUrl = script.raw.match(/http:\/\/applyjob\.chinahr\.com\/apply\/job\/wish\//)?.[0];
          if (!sourceApplicationUrl) { run.gaps.push('平台公开申请路径脚本结构变化，未验证申请入口'); continue; }
          const path = { postId, title: post.name, recruitmentUnit: post.companyName, sourceApplicationUrl: sourceApplicationUrl + postId, url: sourceApplicationUrl.replace('http:', 'https:') + postId, responses: [], loginRequired: false, verified: false };
          run.applicationPaths.push(path);
          try {
            (run.detailAttempts??=[]).push({externalId:postId,at:now().toISOString()});save(run);
            let url = path.url;
            for (let hop = 0; hop < 6; hop++) {
              if (new URL(url).protocol !== 'https:' || !['applyjob.chinahr.com', 'user.chinahr.com'].includes(new URL(url).hostname)) throw new Error('申请路径跳转到未核验域，停止获取');
              const response = await request(url); path.responses.push(response); save(run);
              if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
                if (/login/i.test(response.location)) path.loginRequired = true;
                url = new URL(response.location, url).href;
                continue;
              }
              if (response.status !== 200) throw new Error(`申请页HTTP ${response.status}`);
              if (path.loginRequired && /login|登录/i.test(response.raw)) { path.verified = true; path.finalUrl = url; }
              else throw new Error('申请页未取得可核对登录流程，不称入口已验证');
              break;
            }
            if (!path.verified) throw new Error('申请跳转超出有界读取次数');
          } catch (error) { path.error = error.message; run.gaps.push(`岗位${postId}：${error.message}`); }
          try {
            const target = { title: post.name, recruitmentUnit: post.companyName, department: null, batch: null };
            const dateEvidence = ['applyBeginTime', 'applyEndTime', 'publishTime', 'createTime'].filter(field => post[field] != null).map(field => ({ field, raw: String(post[field]), meaning: 'unverified' }));
            const entry = { postId, target, raw: structuredClone(post), cached: false, announcementId: null, relatedAnnouncements: [] };
            run.platformDetails.push(entry); save(run);
            const association = matchBocAssociation(post, companies.data.retMsg, campaigns[post.project], platformUrl, associationRules);
            if (!association) run.businessGaps.push(`岗位${postId}公共公告关系未核验；当前岗位正文不代表全部公共条件齐全`);
            if (association) {
              const { rule, scope } = association;
              if (!run.catalog.some(item => item.url === rule.announcementUrl)) throw new Error('关联公共公告未在本次完整官方栏目中，拒绝套用条件');
              const response = await request(rule.announcementUrl);
              const related = { scope, response, originalText: null };
              entry.relatedAnnouncements.push(related); save(run);
              if (response.status !== 200) throw new Error(`关联公共公告HTTP ${response.status}，保留旧完整岗位`);
              const body = response.raw.match(/<div class="trs_editor_view[^" ]*[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
              if (!body || !plain(body).includes(rule.scopeQuote) || !hasBocPlatformLink(body, rule.announcementUrl, platformUrl)) throw new Error('关联公共公告适用范围或准确平台链无法核对，拒绝套用条件');
              related.originalText = plain(body); related.contentSha256 = digest(related.originalText.replace(/\s+/g, ' ')); related.scope.scopeQuote = rule.scopeQuote;
              save(run);
            }
            const originalText = `中行指定社招平台公开选中岗位\n岗位：${target.title}\n招聘单位：${target.recruitmentUnit}\n部门及招聘批次：未单独披露，不从项目或机构编号推断。\n岗位正文：\n${plain(post.jobDesc)}\n完整平台字段（原值／状态和日期语义待核验）：\n${JSON.stringify(post)}\n该岗位申请路径：${path.url}\n申请步骤：注册登录后依该岗位官方流程填写并提交。登录页可达不证明目前仍能申请。` + entry.relatedAnnouncements.map(item => `\n\n【官方关联公共公告：${item.response.url}】\n${item.originalText}`).join('');
            const identity = { ...target, sourceIdentity: { sourceId, externalId: post.id }, observedAt: run.checkedAt, dateEvidence, recruitmentStatus: 'unverified', sourceEvidence: { sourceId, externalId: post.id, companyId: post.companyId, project: post.project, listed: true, checkedAt: run.checkedAt, applicationUrl: path.url, applicationPathVerified: path.verified, isShow: post.isShow, isStart: post.isStart, relatedAnnouncements: entry.relatedAnnouncements, commonAnnouncementOriginalComplete: Boolean(association) } };
            const hash = digest(JSON.stringify({ target, originalText, associationScope: entry.relatedAnnouncements.map(item => ({ scope: item.scope, sha256: item.contentSha256 })), scopeVersion: 'boc-selected-platform-v1' }));
            const cached = db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId, post.id, sourceProcessingKey(hash));
            let announcement = cached && application.getAnnouncement(cached.announcement_id);
            entry.cached = Boolean(announcement);
            if (!announcement) {
              announcement = await application.createAnnouncement({ title: target.title, originalText, sourceUrl: platformUrl, evidenceUse: 'unverified', jobIdentities: [identity], targetJobs: [target] });
              db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId, post.id, sourceProcessingKey(hash), announcement.id);
            }
            entry.announcementId = announcement.id; save(run);
            if (processAnnouncements) announcement = await application.processAnnouncement(announcement.id);
            entry.jobIds = [...announcement.jobIds];
            entry.processingStatus = announcement.status; entry.processingReceipt = announcement.processingReceipt ?? null;entry.processingDecision=announcement.sourceProcessingDecision;
            entry.processingSkipped=announcement.processingSkipped??null;
            for (const jobId of announcement.jobIds) { const job = application.getSourceJob(jobId); application.importJob({ ...job, ...identity, unknownFields: [...job.unknownFields, ...(!association ? ['公共公告关系未核验，公共条件可能不完整'] : [])] }); }
            run.jobIds.push(...announcement.jobIds); run.businessGaps.push(...announcement.gaps);
            run.gaps.push(...announcement.attachments.filter(item => item.status !== 'read').map(item => `${item.name}：${item.error ?? '附件未取得'}`));
            if (processAnnouncements && ['processed','partial'].includes(announcement.status) && !announcement.jobIds.length) run.gaps.push('加工未保存具体岗位，保留原文待处理');
            if (announcement.status === 'failed') run.gaps.push(`岗位${postId}加工失败，保留原文：${announcement.error}`);
          } catch (error) {
            const entry = run.platformDetails.find(item => item.postId === postId);
            if (entry) {
              entry.error = error.message; entry.processingStatus = 'blocked';
              entry.retainedJobIds = application.listJobs().filter(job => job.title === post.name && job.recruitmentUnit === post.companyName && job.sourceIdentities?.some(identity => identity.sourceId === sourceId && identity.externalId === postId)).map(job => job.id);
            }
            run.gaps.push(`岗位${postId}加工：${error.message}`);
          }

        }
        run.businessGaps.push('当前有用机会未验证；公开列示、isShow／isStart或未核实平台时间不能单独证明当前可申请');
      } catch (error) { run.error = error.message; run.gaps.push(error.message); }
      finally {
        run.status = run.gaps.length ? 'partial' : 'success'; run.finishedAt = now().toISOString(); save(run); checking = false;

        for (const job of application.listJobs()) for (const identity of job.sourceIdentities ?? []) {
          if(identity.sourceId!==sourceId)continue;
          if(identity.externalId.startsWith('https://www.boc.cn/')) {
            const url=identity.externalId.split('#')[0],entry=run.announcements.find(item=>item.url===url&&(item.jobIds?.includes(job.id)||(item.processingScope?.targetJob&&['title','recruitmentUnit','department','batch'].every(field=>(item.processingScope.targetJob[field]??null)===(job[field]??null)))));
            const text=JSON.stringify(run),acquired=run.catalogComplete&&entry?.response.status===200;
            application.recordRecruitmentObservation(job.id,{id:run.id+':'+job.id+':'+identity.externalId,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:run.catalogComplete?'success':'failed',listComplete:run.catalogComplete,listed:run.catalogComplete?run.catalog.some(item=>item.url===url):null,detailAccessible:acquired?true:null,applicationOpen:null,evidence:{url,text,quote:run.id,locator:'选中公告及具体岗位加工范围'},sourceCheckId:run.id,trigger,scheduledFor,error:run.error});
            continue;
          }
          if(!/^[a-f0-9]{24}$/.test(identity.externalId))continue;
          const post = run.platformJobs.find(item => item.id === identity.externalId && item.name === job.title && item.companyName === job.recruitmentUnit);
          const detail = run.platformDetails.find(item => item.postId === identity.externalId);
          const text = JSON.stringify(run);
          application.recordRecruitmentObservation(job.id, { id: run.id + ':' + job.id + ':' + identity.externalId, sourceId, externalId: identity.externalId, observedAt: run.checkedAt, acquisition: run.platformListComplete ? 'success' : 'failed', listComplete: run.platformListComplete, listed: run.platformListComplete ? Boolean(post) : null, detailAccessible: detail ? true : null, applicationOpen: null, evidence: { url: platformUrl, text, quote: run.id, locator: '本次公开平台原始列表／选中岗位字段与申请路径' }, sourceCheckId: run.id, trigger, scheduledFor, error: run.error });
        }
        application.recordSourceCheck?.({ ...run, checkId: run.id, trigger, scheduledFor });
      }
      return structuredClone(run);
    },
  };
}
