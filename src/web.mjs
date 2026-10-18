import { jobDisplay, recommendationLabels } from './job-display.mjs';
import { recruitmentPanel } from './recruitment-web.mjs';
import { correctionsPanel, applicationLinksPanel } from './corrections-web.mjs';
import { matchingPanel } from './matching-web.mjs';
import { eligibilityPanel } from './eligibility-web.mjs';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const text = value => value == null || value === '' ? '未知' : escapeHtml(value);
const list = values => values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : '未知';
const recruitmentLabel = value => ({publicly_listed_open:'当前公开列示开放（不代表内部名额）',suspected_offline:'疑似下线，完整列表中未见，不等于明确结束',ended:'明确结束，有原文证据',unverified:'待核验'})[value] ?? '待核验';
const jobEvidenceLabel = job => job.sourceEvidence ? '自动取得的官方原文，当前招聘状态依独立检查证据判断；本人资格另验' : evidenceLabel(job.evidenceUse);
const evidenceLabel = value => ({ historical: '历史样本，仅作字段／资格回放，不代表当前机会', current: '手动保存的当前原文，公开招聘状态待核验', unverified: '原文时效待核验' })[value] ?? '未知';

// Retain every recorded field while making facts and evidence readable in the product.
export function readableFacts(value) {
  const labels = {
    birthday: '生日', minimumBirthDate: '最早出生日期', maximumBirthDate: '最晚出生日期',
    referenceDate: '年龄基准日', age: '核验年龄', maxAge: '年龄上限', profileEducation: '本人学历', suppliedEducation: '本人学历', requiredEducation: '要求学历', requiredCertificate: '要求证书', confirmedMonths: '有证据的经验月数', requiredMonths: '要求经验月数', domain: '经验领域',
    field: '字段', raw: '原始值', meaning: '日期含义', evidence: '原文依据', documentId: '原文文档', locator: '原文定位',
    quote: '原文引用', start: '引用起点', end: '引用终点', text: '原文', url: '来源链接', value: '核验值',
    precision: '日期精度', timeZone: '时区', date: '日期', gaps: '具体缺口', unverified: '尚未核验日期',
    previous: '此前记录', change: '变化', observedAt: '观察时刻', recordedAt: '记录时刻', acquisition: '取得结果',
    sourceId: '来源', externalId: '来源岗位编号', listComplete: '列表是否完整', listed: '列表是否列示',
    applicationOpen: '申请是否公开开放', detailChecked: '是否检查详情', explicitEnd: '明确结束依据',
    officialDeadline: '官方截止', published: '发布日期', platformRefreshed: '平台刷新', ageQualificationWindows: '年龄资格窗口',
    deadlineHistory: '截止变化历史', observations: '招聘观察历史', type: '事件类型', id: '记录编号', jobId: '岗位编号',
    appliedAt: '实际投递时间', notes: '备注', resumeVersion: '实际提交简历版本', corrected: '撤销误勾',
    options: '公开地点选项', confirmed: '已确认地点', note: '说明', scope: '适用范围', condition: '条件',
  };
  const values = { unverified: '含义待核验', explicit_publish_date: '明确发布日期', explicit_deadline: '明确报名截止',
    day: '日级，未补造时分', instant: '明确时刻', local_minute: '分钟级，时区未披露', success: '取得成功', failed: '取得失败',
    extended: '官方延期', changed: '已变更', confirmed_source_snapshot: '来源原文确认', common: '公共条件', job: '岗位条件', manual: '本人补录' };
  if (value == null || value === '') return '未知';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? `<ul>${value.map(item => `<li>${readableFacts(item)}</li>`).join('')}</ul>` : '未记录';
  if (typeof value === 'object') return `<dl>${Object.entries(value).map(([key, item]) => `<dt>${escapeHtml(labels[key] ?? key)}</dt><dd>${readableFacts(item)}</dd>`).join('')}</dl>`;
  return escapeHtml(values[value] ?? value);
}

export function evidenceList(evidence = []) {
  return evidence.length ? `<ul class="evidence-list">${evidence.map(item => `<li><p>原文 ${text(item.documentId)} / ${text(item.locator)}</p><blockquote class="preserve-lines">${text(item.quote)}</blockquote>${item.start != null || item.end != null ? `<small>原文引用位置：${text(item.start)} 至 ${text(item.end)}</small>` : ''}</li>`).join('')}</ul>` : '<p>原文定位未知，需核对已保存原文。</p>';
}

export function page(title, body, { activePage } = {}) {
  const navigation = [['/jobs', '岗位库'], ['/followed', '我的关注'], ['/applications', '我的投递'], ['/sources', '来源与设置']];
  const current = activePage ?? navigation.find(([, label]) => label === title)?.[0];
  const nav = navigation.map(([url, label]) => `<a href="${url}"${current === url ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · JobHunter</title><link rel="stylesheet" href="/assets/jobs.css"></head><body><header class="app-top"><div class="brand">JobHunter<small>CAREER OPPORTUNITIES</small></div><nav>${nav}</nav></header><main><h1>${escapeHtml(title)}</h1>${body}</main><script src="/assets/personal.js" defer></script></body></html>`;
}

const applicationKinds = { direct: '岗位直达', steps: '申请入口及步骤', email: '招聘邮箱', announcement: '公告规定流程' };
export function applicationPathView(path) {
  if (!path) return '<p>投递入口未知，需核对原文。</p>';
  return `${path.url ? `<a href="${escapeHtml(path.url)}" target="_blank" rel="noopener noreferrer">${applicationKinds[path.kind] ?? '官方申请入口'}</a>` : `<span>${applicationKinds[path.kind] ?? '官方申请方式'}</span>`}${path.email ? `<p><a href="mailto:${escapeHtml(path.email)}">${escapeHtml(path.email)}</a></p>` : ''}${path.steps ? `<p class="preserve-lines">${escapeHtml(path.steps)}</p>` : ''}<small>${path.loginRequired ? '需要登录' : '登录要求未标注，按官方要求操作'}</small>`;
}


const filterChoices = {
  recommendation: recommendationLabels,
  level: {expert:'专家',leader:'负责人／管理',dual:'双路线',unknown:'不确定'},
  eligibility: {verified:'满足',ineligible:'不满足',pending:'不确定'},
  status: {open:'在招',limited:'限时招聘',not_started:'未开始',unverified:'待确认',suspected_offline:'疑似下线',ended:'已结束',long_posted:'长期挂网'},
};
function tableHeader(key, label, fields, filters, action) {
  const hidden = Object.entries(filters).filter(([field]) => !fields.includes(field)).map(([name,value])=>`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
  const controls = fields.map(field => filterChoices[field] ? `<select aria-label="筛选${label}" name="${field}"><option value="">全部</option>${Object.entries(filterChoices[field]).map(([value,name])=>`<option value="${value}"${filters[field]===value?' selected':''}>${escapeHtml(name)}</option>`).join('')}</select>` : `<label>${field==='startFrom'?'开始不早于':field==='deadlineBefore'?'截止不晚于':label}<input aria-label="筛选${field==='startFrom'?'报名开始':field==='deadlineBefore'?'报名截止':label}" type="${['startFrom','deadlineBefore'].includes(field)?'date':'search'}" name="${field}" value="${escapeHtml(filters[field])}" placeholder="输入关键词"></label>`).join('');
  const query = new URLSearchParams({...filters,sort:key==='recommendation'?'recommendation':'deadline'});
  const sort = ['recommendation','registration'].includes(key)?`<a class="sort-link${filters.sort===(key==='recommendation'?'recommendation':'deadline')?' active':''}" href="${escapeHtml(action)}?${escapeHtml(query.toString())}" aria-label="按${key==='recommendation'?'推荐程度':'截止时间'}排序">↕</a>`:'';
  return fields.length?`<details class="header-filter${fields.some(field=>filters[field])?' active':''}"><summary>${label}</summary><form method="get" action="${escapeHtml(action)}">${hidden}${controls}<button>应用筛选</button></form></details>${sort}`:label;
}

export function jobsTable(jobs, { filters = {}, action = '/jobs', emptyMessage = '尚未入库。可以补录岗位，或在来源与设置查看采集进展。' } = {}) {
  const columns = [
    ['title','岗位',235,['direction'],job=>job.display.application.href?`<a class="job-title" href="${escapeHtml(job.display.application.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(job.display.application.label+(job.display.application.needsSteps&&job.display.application.steps?' · '+job.display.application.steps:''))}">${escapeHtml(job.title)}</a>`:`<span class="job-title" title="入口未披露">${escapeHtml(job.title)}</span>`,true],
    ['unit','招聘单位',145,['unit'],job=>`<span class="job-unit" title="${escapeHtml(job.display.unit.reason)}">${escapeHtml(job.display.unit.label)}</span>`,true],
    ['location','地点',120,['location'],job=>`<span class="job-location" title="${escapeHtml(job.display.location)}">${escapeHtml(job.display.location)}</span>`,true],
    ['recommendation','推荐程度',240,['recommendation'],job=>`<strong class="recommendation${job.display.recommendation.level==='priority'?' priority':''}" title="${escapeHtml(job.display.exclusionReason??job.display.recommendation.reason)}">${job.display.recommendation.label}</strong>${job.display.group==='pending'&&job.display.pendingReason?`<span class="subline pending-reason">${escapeHtml(job.display.pendingReason)}</span>`:''}${!job.matching||job.display.recommendation.needsUpdate||job.display.locationFit.status==='excluded'?`<span class="subline">${escapeHtml(job.display.recommendation.reason)}</span>`:''}${(job.display.recommendation.level==='excluded'||job.matching?.status!=='completed'||job.matching.stale||job.matching.profileStale?[]:job.display.dimensions).map(d=>`<div class="dimension" title="${escapeHtml(d.shortReason)}">${d.label}：${d.levelLabel} · ${escapeHtml(d.shortReason)}</div>`).join('')}`,true],
    ['route','职责路线',105,['level'],job=>`<span title="${escapeHtml(job.display.route.evidence.join('；'))}">${job.display.route.label}</span>`,true],
    ['eligibility','投递资格',100,['eligibility'],job=>`<span>${job.display.eligibility.label}</span>${job.display.eligibility.reason?`<span class="subline" title="${escapeHtml(job.display.eligibility.reason)}">${escapeHtml(job.display.eligibility.reason)}</span>`:''}`,true],
    ['status','招聘状态',100,['status'],job=>`<span class="badge">${job.display.recruitment.label}</span>${job.display.recruitment.longevityLabel?'<span class="subline">长期挂网</span>':''}`,true],
    ['registration','官方报名起止',200,['startFrom','deadlineBefore'],job=>`<div class="registration-line"><span class="label">开始</span>${escapeHtml(job.display.registration.startLabel)}</div><div class="registration-line${job.display.registration.urgent?' urgent':''}"><span class="label">截止</span>${escapeHtml(job.display.registration.deadlineLabel)}</div>${job.display.registration.urgent?`<span class="subline urgent">${job.display.registration.remainingDays===0?'今日截止':job.display.registration.remainingDays+'天内截止'}</span>`:''}`,true],
    ['personal','个人标记',90,[],job=>personalControls(job,{compact:true}),true],
    ['application','投递入口',200,[],job=>applicationPathView(job.applicationPath),false],
    ['contract','签约主体',160,[],job=>text(job.contractingEntity),false],
    ['department','部门／批次',160,[],job=>`${text(job.department)} / ${text(job.batch)}`,false],
    ['published','原始发布日期',140,[],job=>text(job.publishedAt),false],
    ['discovered','首次发现',140,[],job=>text(job.firstDiscoveredAt),false],
    ['checked','最近成功检查',140,[],job=>text(job.recruitment?.lastSuccessfulObservationAt),false],
  ];
  const table = (members, group) => `<div class="table-scroll" tabindex="0" aria-label="${group==='active'?'可考虑岗位':group==='pending'?'待核验岗位':'排除与历史'}，可横向滚动"><table class="jobs-table"><colgroup>${columns.map(([key,,, , ,visible])=>`<col data-job-column="${key}" style="width:${columns.find(c=>c[0]===key)[2]}px"${visible?'':' hidden'}>`).join('')}</colgroup><thead><tr>${columns.map(([key,label,,fields,,visible])=>`<th scope="col" data-job-column="${key}"${visible?'':' hidden'}>${tableHeader(key,label,fields,filters,action)}</th>`).join('')}</tr></thead><tbody data-job-group="${group}">${members.length ? members.map(job=>`<tr data-job-row data-job-id="${escapeHtml(job.id)}">${columns.map(([key,,,,render,visible])=>`<td data-job-column="${key}"${visible?'':' hidden'}>${render(job)}</td>`).join('')}</tr>`).join('') : `<tr><td class="empty-state" data-job-group-heading colspan="9">${escapeHtml(group==='active'&&jobs.length?'当前没有可考虑岗位，可展开“待核验岗位”或“排除与历史”查看。':Object.values(filters).some(Boolean)?'没有匹配岗位，可调整表头条件。':emptyMessage)}</td></tr>`}</tbody></table></div>`;
  const projected=jobs.map(job=>({...job,display:job.display??jobDisplay(job)})),active=projected.filter(job=>job.display.group==='active'),pending=projected.filter(job=>job.display.group==='pending'),history=projected.filter(job=>job.display.group==='history');
  return `<section data-job-table><div class="toolbar"><span class="muted">${jobs.length} 个岗位 · ${active.length} 个可考虑 · ${pending.length} 个待核验 · ${history.length} 个排除与历史</span><div class="actions"><a href="${escapeHtml(action)}">清除筛选</a><details class="column-picker"><summary>选择显示列</summary><fieldset><legend>岗位表格显示列</legend>${columns.map(([key,label,,,,visible])=>`<label><input type="checkbox" data-job-column-toggle="${key}"${visible?' checked':''}${key==='title'?' disabled':''}> ${label}</label>`).join('')}</fieldset></details><a href="/jobs/new">补录岗位</a></div></div><h2 class="table-section-heading">可考虑岗位 <span class="count">${active.length}</span></h2>${table(active,'active')}<details class="pending-jobs"><summary>待核验岗位 <span class="count">${pending.length}</span></summary><p class="muted">逐岗显示待核验原因；已完成的匹配结论与个人关注保留，确认在招后再进入可考虑。</p>${pending.length?table(pending,'pending'):'<p class="empty-state">暂无待核验岗位。</p>'}</details><details class="history-jobs"><summary>排除与历史 <span class="count">${history.length}</span></summary>${history.length?table(history,'history'):'<p class="empty-state">暂无排除或历史岗位。</p>'}</details><noscript>筛选、排序和链接仍可使用；即时保存与选择显示列需启用JavaScript。</noscript></section>`;
}

export function jobsPage(jobs, filters = {}) {
  return page('岗位库', jobsTable(jobs,{filters})+'<p class="muted"><a href="/qualification-profile">个人资格档案</a> · <a href="/announcements">公告与原始附件</a> · <a href="/notifications">消息预览与记录</a></p>');
}

export function jobPage(job, applications = []) {
  const display=job.display??jobDisplay(job);
  const conditions = job.conditions?.length ? job.conditions.map(item=>`<article><h3>${item.scope==='common'?'公共条件':'岗位条件'}</h3><p class="preserve-lines">${text(item.text)}</p>${evidenceList(item.evidence)}</article>`).join('') : list(job.knownConditions);
  const facts=[['招聘单位',display.unit.label],['地点',display.location],['职责路线',display.route.label],['投递资格',display.eligibility.label+(display.eligibility.reason?' · '+display.eligibility.reason:'')],['招聘状态',display.recruitment.label],['官方报名开始',display.registration.startLabel],['官方报名截止',display.registration.deadlineLabel],['部门／批次',[job.department,job.batch].filter(Boolean).join('／')],['签约主体',job.contractingEntity]];
  const body=`<p class="muted"><a href="/jobs">← 岗位库</a></p><section class="detail-card"><div class="detail-header"><div><strong class="recommendation${display.recommendation.level==='priority'?' priority':''}">${display.recommendation.label}</strong><p class="muted">${escapeHtml(display.recommendation.reason)}</p></div>${display.application.href?`<a class="apply-button" href="${escapeHtml(display.application.href)}" target="_blank" rel="noopener noreferrer">${display.application.label}</a>`:'<span class="muted">入口未披露</span>'}</div><dl class="detail-facts">${facts.map(([label,value])=>`<div><dt>${label}</dt><dd>${text(value)}</dd></div>`).join('')}</dl></section><div class="detail-grid"><section class="detail-card"><h2>岗位职责</h2><p class="preserve-lines">${text(job.duties)}</p><h2>任职要求</h2>${conditions}</section><section class="detail-card" id="application"><h2>如何申请</h2>${applicationPathView(job.applicationPath)}<h2>个人操作</h2>${personalControls(job)}<h2>匹配概览</h2>${display.dimensions.map(d=>`<p><strong>${d.label} · ${d.levelLabel}</strong><br><small>${escapeHtml(d.shortReason)}</small></p>`).join('')}</section></div><details><summary>资格核验与逐项证据</summary>${eligibilityPanel(job)}</details><details><summary>三维匹配与职责路线依据</summary>${matchingPanel(job)}</details><details><summary>日期依据与招聘观察</summary>${recruitmentPanel(job)}</details><details><summary>人工纠正及历史</summary>${correctionsPanel(job)}</details>${applications.length?`<details><summary>投递记录与补充信息</summary>${applications.map(applicationPanel).join('')}</details>`:''}<details><summary>原文证据与来源版本</summary><h2>原文证据</h2><p>${escapeHtml(jobEvidenceLabel(job))}</p><p>招聘状态依据：${escapeHtml(recruitmentLabel(job.recruitment?.status))}。</p>${readableFacts({地点依据:job.location,原始发布日期:job.publishedAt,首次发现:job.firstDiscoveredAt,最近成功检查:job.lastSuccessfullyCheckedAt})}${job.currentVersionId?`<p><a href="/jobs/${encodeURIComponent(job.id)}/history">来源与版本历史</a></p>`:''}${job.announcementId?`<p><a href="/announcements/${encodeURIComponent(job.announcementId)}">来源公告及原始附件</a></p>${evidenceList(job.evidence)}`:`<p class="preserve-lines">${text(job.originalText)}</p>`}${job.sourceUrl?`<p><a href="${escapeHtml(job.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方原文</a></p>`:''}${job.recruitmentUnitEvidence?`<h3>官网招聘单位依据</h3><p>采集补齐：${escapeHtml(job.recruitmentUnitEvidence.value)}；签约主体另按原文核验。</p>${job.recruitmentUnitEvidence.quotes.map(quote=>`<blockquote class="preserve-lines">${escapeHtml(quote)}</blockquote>`).join('')}<p>核对时间：${escapeHtml(job.recruitmentUnitEvidence.checkedAt)}</p>`:''}<h3>来源日期原值</h3>${readableFacts(job.dateEvidence??[])}</details>`;
  return page(job.title,body,{activePage:'/jobs'});
}

export function newJobPage() {
  return page('补录岗位', `<p>保留可核对原文。没有公开信息的字段留空；公开条件不等于已经核验本人符合。</p><form method="post" action="/jobs"><label>岗位标题<input name="title" required></label><label>招聘单位<input name="recruitmentUnit"></label><label>签约主体<input name="contractingEntity"></label><label>部门<input name="department"></label><label>招聘批次<input name="batch"></label><label>原文来源链接<input name="sourceUrl" type="url"></label><label>原文证据<textarea name="originalText" rows="8" required></textarea></label><label>原文用途<select name="evidenceUse"><option value="unverified">时效待核验</option><option value="historical">历史／过期样本</option><option value="current">当前原文（仍需核验招聘状态）</option></select></label><label>原始发布日期（按原文，未知留空）<input name="publishedAt"></label><label>地点公开选项（每行一个）<textarea name="locationOptions" rows="2"></textarea></label><label>已确认地点（没有依据留空）<input name="locationConfirmed"></label><label>地点缺口<input name="locationNote"></label><label>公开条件（每行一个）<textarea name="knownConditions" rows="3"></textarea></label><label>待补信息（每行一个）<textarea name="unknownFields" rows="2"></textarea></label><label>真实投递入口类型<select name="applicationKind"><option value="">未知</option><option value="direct">岗位直达</option><option value="steps">入口及查找步骤</option><option value="email">招聘邮箱</option><option value="announcement">公告规定流程</option></select></label><label>投递入口链接（首页须选“入口及查找步骤”）<input name="applicationUrl" type="url"></label><label>招聘邮箱<input name="applicationEmail" type="email"></label><label>岗位编号／查找及申请步骤<textarea name="applicationSteps" rows="3"></textarea></label><label><input name="loginRequired" type="checkbox"> 需要登录</label><button type="submit">保存岗位</button></form>`);
}

export function jobFromForm(form) {
  const lines = name => (form.get(name) ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const kind = form.get('applicationKind');
  return {
    title: form.get('title'), recruitmentUnit: form.get('recruitmentUnit'), contractingEntity: form.get('contractingEntity'),
    department: form.get('department'), batch: form.get('batch'), sourceUrl: form.get('sourceUrl'), originalText: form.get('originalText'),
    evidenceUse: form.get('evidenceUse') || 'unverified', publishedAt: form.get('publishedAt'),
    location: { options: lines('locationOptions'), confirmed: form.get('locationConfirmed'), note: form.get('locationNote') },
    knownConditions: lines('knownConditions'), unknownFields: lines('unknownFields'),
    applicationPath: kind ? { kind, url: form.get('applicationUrl'), email: form.get('applicationEmail'), steps: form.get('applicationSteps'), loginRequired: form.get('loginRequired') === 'on' } : null,
  };
}

const progressLabel = value => ({ none: '尚未投递', preparing: '准备投递', applied: '已投递', interview: '面试', ended: '申请结束（结果按本人记录）' })[value] ?? '未知';
const localTime = value => new Date(new Date(value).getTime() + 8 * 3600 * 1000).toISOString().slice(0, -1);

export function personalControls(job, { compact = false } = {}) {
  const state = job.personal ?? {};
  return `<section data-personal-controls><p>个人投递进度：${progressLabel(state.applicationProgress)}</p>${[
    ['followed', '关注'], ['applied', '已投递'], ['preparing', '准备投递'], ['viewed', '已看'], ['remindersPaused', '暂停提醒'], ['notInterested', '排除'],
  ].filter(([field]) => !compact || ['followed', 'applied', 'notInterested'].includes(field)).map(([field, label]) => `<label><input type="checkbox" data-action="${field}" data-job-id="${escapeHtml(job.id)}"${state[field] ? ' checked' : ''}> ${label}</label>`).join('')}<small>勾选即时保存；取消“已投递”记录撤销误勾，不代表撤回真实申请。关注与投递独立。</small><p role="status" aria-live="polite"></p><noscript>即时保存复选框需要启用JavaScript。</noscript></section>`;
}

export function applicationPanel(application) {
  const eventLabels = { applied: '记录已投递', updated: '补充／纠正投递信息', interview: '面试', ended: '本人确认申请结束', correction: '撤销误勾，不代表撤回真实申请' };
  return `<article><h3>${escapeHtml(application.jobSnapshot.title)}</h3><p>${application.corrected ? '已记录撤销误勾；原申请及面试事实保留' : '本人确认已投递'}</p><form method="post" action="/applications/${encodeURIComponent(application.id)}"><label>实际投递时间（北京时间）<input name="appliedAt" type="datetime-local" step="0.001" value="${localTime(application.appliedAt)}" required></label><label>备注<textarea name="notes">${escapeHtml(application.notes)}</textarea></label><label>实际提交简历版本（未知留空，不自动指定最新版）<input name="resumeVersion" value="${escapeHtml(application.resumeVersion)}"></label><button>保存补充信息</button></form>${applicationLinksPanel(application)}<h4>后续事件</h4><ul>${application.events.map(event => `<li>${text(event.occurredAt)} · ${eventLabels[event.type] ?? escapeHtml(event.type)} · ${text(event.note)}${event.changes ? readableFacts(event.changes) : ''}</li>`).join('')}</ul><form method="post" action="/applications/${encodeURIComponent(application.id)}/events"><label>本人确认事件<select name="type"><option value="interview">面试</option><option value="ended">申请结束</option></select></label><label>事件时间（北京时间，留空用当前时间）<input name="occurredAt" type="datetime-local" step="0.001"></label><label>实际进展／结果说明<textarea name="note"></textarea></label><button>记录事件</button></form></article>`;
}

export function followedPage(jobs, filters = {}) {
  return page('我的关注', jobsTable(jobs, { filters,action:'/followed', emptyMessage: '当前没有符合筛选条件的关注岗位。你可以到岗位库挑选并勾选关注。' }));
}

export function applicationsPage(jobs, filters = {}) {
  return page('我的投递', jobsTable(jobs, { filters,action:'/applications', emptyMessage: '当前没有符合筛选条件的已投递岗位。实际提交申请后，在岗位库或详情勾选已投递即可。' }));
}
