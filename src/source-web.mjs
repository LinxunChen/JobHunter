import {sourceCapabilities,sourceAliases} from './source-capabilities.mjs';
import { page, escapeHtml } from './web.mjs';
export const sourceCheckLabel = run => {
  if (run?.status !== 'success') return ({ partial: '部分完成，有明确缺口', failed: '检查或加工失败', checking: '检查中' })[run?.status] ?? '尚未检查';
  const hasDetails = run.coverage ? ['details','platformDetails','announcements'].some(key=>run.coverage[key]>0) : [run.details, run.platformDetails, run.announcements].some(items => Array.isArray(items) && items.length);
  if (!run.listOnly && hasDetails && run.jobIds?.length) return '检查及选中岗位加工成功';
  if (!run.listOnly && hasDetails) return '检查成功，已取得选中详情，尚无已保存加工岗位';
  const counts = [run.listCount, run.catalogCount, run.coverage?.platformJobs??run.platformJobs?.length].filter(value => typeof value === 'number');
  if (!counts.length) return '检查成功，列表及详情加工覆盖未记录';
  return counts.length && counts.every(value => value === 0) ? '列表检查成功（列表0项，未选择详情）' : '列表检查成功，未选择详情';
};
export function sourcesPage(coverage) {
  const run = coverage.latest;
  return page('易方达详细来源证据', `<p><a href="/sources">返回来源与设置总览</a> · <a href="/career">职业资料版本与刷新</a> · <a href="/backups">完整备份与恢复核对</a> · <a href="/runs">后台检查与恢复</a></p><p>本页仅展示易方达官方社招的采集证据。成功范围按每次检查证据显示；全部来源与目标监控对象覆盖请返回总览核对。</p><p>${escapeHtml(coverage.scope)}</p><form method="post" action="/sources/efunds/check"><p>检查完整公开社招列表，并核验选中的岗位。新内容或实质变化会通过Codex加工，相同正文复用已有结果。</p><button>检查易方达社招</button></form>${run ? `<h2>${sourceCheckLabel(run)}</h2><p>最近检查：${escapeHtml(run.checkedAt)} · 最近完整成功：${escapeHtml(coverage.lastSuccessfulAt ?? '尚无')}</p><p>列表${run.listCount}项 / ${run.pages.length}页，${run.listComplete ? '分页数量核对完整' : '完整覆盖未确认'}；选中详情${run.details.length}项；附件未检索。未选中岗位的完整条件尚未核验。</p>${run.error ? `<p role="alert">${escapeHtml(run.stage)}：${escapeHtml(run.error)}</p>` : ''}${run.gaps.length ? `<ul>${run.gaps.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>` : ''}<p>当前公开列示不保证内部名额或本人全部符合。来源失败保留已有岗位和个人记录。</p><ul>${run.jobIds.map(id => `<li><a href="/jobs/${encodeURIComponent(id)}">查看已取得岗位</a></li>`).join('')}</ul><details><summary>原文与检查证据</summary><pre>${escapeHtml(JSON.stringify(run, null, 2))}</pre></details>` : '<p>尚无检查证据。</p>'}<h2>检查历史</h2><ul>${coverage.history.map(item => `<li>${escapeHtml(item.checkedAt)} · ${sourceCheckLabel(item)} · 列表${item.listCount}项 / 选中详情${item.details.length}项${item.error ? ' · ' + escapeHtml(item.error) : ''}</li>`).join('')}</ul>`,{activePage:'/sources'});
}

export const failureLabel = category => ({acquisition:'获取异常',pagination:'分页异常',detail:'详情异常',attachment:'附件异常',processing:'加工异常',unknown:'异常类别未知'})[category] ?? '';
export function checkCoverage(run) {
  if (!run) return '<p>尚无检查证据，不计成功覆盖。</p>';
  const parts=[],counts=run.coverage;
  if ('listCount' in run) parts.push(`列表${run.listCount}项 / ${counts?.pages ?? run.pages?.length ?? 0}页，${run.listComplete ? '分页数量核对完整' : '完整覆盖未确认'}；选中详情${counts?.details ?? run.details?.length ?? 0}项；附件${run.attachmentsChecked ? `取得${run.attachmentsChecked}项` : '未检索'}`);
  if ('catalogCount' in run) parts.push(`栏目${run.catalogCount}项 / ${counts?.catalogPages ?? run.catalogPages?.length ?? 0}页，${run.catalogComplete ? '栏目分页完整' : '栏目完整覆盖未确认'}`);
  if ('platformListComplete' in run) parts.push(`指定平台列表${counts?.platformJobs ?? run.platformJobs?.length ?? 0}项 / ${counts?.platformPages ?? run.platformPages?.length ?? 0}页，${run.platformListComplete ? '平台分页完整' : '平台完整覆盖未确认'}`);
  if(counts?.announcements!==undefined)parts.push(`选中公告${counts.announcements}项；附件取得${counts.attachmentsObtained}项 / 选中公告列出${counts.attachments}项，未选中公告附件未核验`);
  else if (Array.isArray(run.announcements)) { const attachments=run.announcements.flatMap(item=>item.attachments??[]);parts.push(`选中公告${run.announcements.length}项；附件取得${attachments.filter(x=>x.status===200).length}项 / 选中公告列出${attachments.length}项，未选中公告附件未核验`); }
  return `<p>${parts.map(escapeHtml).join('；')}</p>`;
}
const monitoringLabel=value=>({active:'监控已启用',paused:'已暂停',removed:'已移出监控'})[value]??'待确认';
const localTime=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚无';
const runLabel=value=>({completed:'已完成',partial:'部分完成',running:'运行中',failed:'未完成',interrupted:'运行中断'})[value]??'尚无后台运行记录';
function monitoringForm(item) {
  return `<form method="post" action="${item?'/monitoring-objects/'+encodeURIComponent(item.id):'/monitoring-objects'}"><label>机构名称<input name="name" maxlength="200" required value="${escapeHtml(item?.name??'')}"></label><label>官方招聘入口（可后补）<input name="officialUrl" type="url" value="${escapeHtml(item?.officialUrl??'')}"></label><label>认可范围与备注<input name="note" maxlength="2000" value="${escapeHtml(item?.note??'')}"></label>${item?`<label>监控状态<select name="monitoringStatus">${Object.entries({active:'启用',paused:'暂停',removed:'移出监控'}).map(([value,label])=>`<option value="${value}" ${item.monitoringStatus===value?'selected':''}>${label}</option>`).join('')}</select></label>`:''}<button>${item?'保存机构设置':'新增目标机构'}</button></form>`;
}
const sourceEvidenceLabels={boc:'中国银行详细来源证据',ccb:'建设银行详细来源证据',icbc:'工行详细来源证据',cmri:'研究院详细来源证据',sasac:'北京国资委详细来源证据',efunds:'易方达详细来源证据'};
function sourceEvidenceLink(sourceId) {
  const alias=Object.entries(sourceAliases).find(([,id])=>id===sourceId)?.[0];
  return alias?`<p><a href="/sources/${alias}">${escapeHtml(sourceEvidenceLabels[alias]??'详细来源证据')}</a></p>`:'';
}
export function sourceOverviewPage(overview, allSettings, reviewPlan=[], operational={}) {
  const counts=overview.counts, names=Object.fromEntries(overview.sources.map(source=>[source.id,source.name]));
  const objects=overview.monitoringObjects;
  const targets=`<section id="monitoring-targets"><h2>目标机构管理</h2><p>已登记${objects.length}个机构。新增名称和官方入口仅保存监控意向，接通采集前显示待接入；集团认可不自动传给所有子公司。暂停或移出仅停止后续工作，岗位、个人记录和运行历史保留。</p><details><summary>新增目标机构</summary>${monitoringForm(null)}</details><table><thead><tr><th>机构</th><th>监控状态</th><th>来源接入</th><th>设置</th></tr></thead><tbody>${objects.map(item=>`<tr><td>${escapeHtml(item.name)}${item.officialUrl?`<br><a href="${escapeHtml(item.officialUrl)}" target="_blank" rel="noopener noreferrer">官方招聘入口（保存的线索）</a>`:''}</td><td>${monitoringLabel(item.monitoringStatus)}</td><td>${item.integrationStatus==='implemented'?`已实现采集入口：${item.sourceIds.map(id=>escapeHtml(names[id]??id)).join('、')}；实际覆盖见下方`:'待接入，未开始自动采集'}</td><td><details><summary>编辑／启停</summary>${monitoringForm(item)}</details></td></tr>`).join('')}</tbody></table></section>`;
  const recent=operational.latest;
  const notification=operational.notification;
  const runtime=`<section><h2>近期运行</h2><p>${runLabel(recent?.status)}${recent?` · 开始于${escapeHtml(localTime(recent.startedAt))} · 完成于${escapeHtml(localTime(recent.finishedAt))}`:''}</p><p>模型：gpt-6.1-sol，推理强度high。${notification?`微信提醒：${notification.sendEnabled?'已启用':'未配置真实发送或发送停用'}。`:''}没有运行记录不表示后台常驻已启用。</p><p><a href="#monitoring-targets">管理目标机构</a> · <a href="/runs">查看后台检查与恢复</a> · <a href="/notifications">通知记录与状态</a> · <a href="/career">职业资料版本与刷新</a> · <a href="/backups">备份与恢复核对</a></p></section>`;
  const sourceCards=overview.sources.map(source=>{
    const run=source.latest,blocked=reviewPlan.filter(item=>item.sourceId===source.id&&item.monitoringBlocked),pending=reviewPlan.filter(item=>item.sourceId===source.id&&!item.monitoringBlocked&&item.due);
    return `<article><h3>${escapeHtml(source.name)}</h3><p>${source.kind==='discovery'?'发现入口，不计雇主':'招聘信息来源'} · ${source.implemented?'已实现采集入口':'待接入'} · ${source.monitoring?.enabled===false?'目标已停用，不启动后续检查':source.monitoring?.scopeRestricted?'共享范围待核验：继续列表发现，无法核定的详情暂不加工':'监控已启用'}</p><p>${escapeHtml(source.scope)}</p><p>${sourceCheckLabel(run)} ${failureLabel(run?.failureCategory)} · 最近检查：${escapeHtml(localTime(run?.checkedAt))} · 最近完整成功：${escapeHtml(localTime(source.lastSuccessfulAt))}</p>${checkCoverage(run)}${run?.error?`<p role="alert">${escapeHtml(run.error)}</p>`:''}<p>待核验${pending.length}项；因机构启停或范围不明暂缓${blocked.length}项。${escapeHtml([...(run?.businessGaps??[]),...(run?.monitoringGaps??[])].join('；'))}</p>${(run?.gaps??[]).length?`<ul>${run.gaps.map(gap=>`<li>${escapeHtml(gap)}</li>`).join('')}</ul>`:''}<p>连续计划失败${source.health.consecutiveScheduledFailures}次；来源失败不等于岗位结束。</p><details><summary>原文与检查证据及检查历史（${source.history.length}次）</summary>${sourceEvidenceLink(source.id)}<ul>${source.history.map(check=>`<li>${escapeHtml(localTime(check.checkedAt))} · ${sourceCheckLabel(check)}${check.error?' · '+escapeHtml(check.error):''}</li>`).join('')}</ul></details></article>`;
  }).join('');
  const advanced=overview.sources.map(source=>{
    const capability=sourceCapabilities[source.id],saved=allSettings[source.id];if(!capability||!saved)return '';
    const alias=Object.entries(sourceAliases).find(([,id])=>id===source.id)?.[0];if(!alias)return '';
    return `<section><h3>${escapeHtml(source.name)}</h3><form method="post" action="/sources/${alias}/settings">${[capability.field,...(capability.urls?[capability.urls]:[])].map(field=>`<label>${field.endsWith('Urls')?'公告链接':'平台岗位编号'}（每行一项；保存不访问来源）<textarea name="${field}">${escapeHtml((saved[field]??[]).join('\n'))}</textarea></label>`).join('')}<button>保存采集选择</button></form><form method="post" action="/sources/${alias}/check"><button ${source.monitoring?.enabled===false?'disabled':''}>手动检查此来源</button></form></section>`;
  }).join('');
  return page('来源与设置', `${runtime}<section><h2>来源覆盖与健康</h2><p>纳入监控对象：${counts.included}；已接入来源：${counts.implemented}；最近检查成功来源：${counts.successful}。列表、详情和附件分别计数，不能代表全部对象完整覆盖。已确认起点：4个监控对象＋1个发现入口，易方达为扩展接入。</p>${sourceCards}</section>${targets}<section><h2>持续故障记录</h2><p>连续两个不同计划检查失败只产生一次合并提醒事件；这里有记录不表示微信已经发送。</p><ul>${overview.events.map(event=>`<li>${escapeHtml(names[event.sourceId]??event.sourceId)} · ${event.status==='recovered'?'已恢复':'持续检查异常'} · ${failureLabel(event.failureCategory)} · ${escapeHtml(localTime(event.createdAt))}</li>`).join('')}</ul></section><details><summary>高级采集选择</summary><p>平台编号与公告选择仅控制已经实现的采集器，不能接通新的机构或扩大其认可范围。未知范围的候选保留，暂停或移出的对象不启动详情和模型加工。</p>${advanced}</details>`);
}
