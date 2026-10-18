import { escapeHtml, readableFacts } from './web.mjs';

export const eligibilityLabel = result => result?.stale ? '证据变化需重新核验（历史结论保留）' : result ? ({ verified: '符合已核验条件', ineligible: '明确不符合', pending: '关键条件待核验' })[result.status] ?? '待核验' : '尚未核验';

export function eligibilityPanel(job) {
  const result = job.eligibility;
  const details = result ? `<p>${eligibilityLabel(result)}${result.stale ? ` · ${result.profileStale ? '资格资料已变化或来源待确认' : '岗位证据或核验规则已变化'}，历史判断需重新核验` : ''}</p><p>${escapeHtml(result.statement)}</p><p>个人资料版本：${escapeHtml(result.profileVersion)} · 判断版本：${escapeHtml(result.ruleVersion)} · 岗位版本：${escapeHtml(result.jobVersion)}</p><ul>${result.checks.map(check => `<li><strong>${escapeHtml(({ verified: '已核验', ineligible: '明确不符', pending: '待核验', information: '信息／偏好' })[check.status])}</strong> ${escapeHtml(check.condition)}<p>${escapeHtml(check.reason)}</p>${check.facts ? `${readableFacts(check.facts)}` : ''}${check.evidence.map(item => `<p>原文 ${escapeHtml(item.documentId)} / ${escapeHtml(item.locator)}：${escapeHtml(item.quote)}</p>`).join('')}</li>`).join('')}</ul><p>普通未披露：${result.unknownFields.map(escapeHtml).join('；') || '无额外记录'}</p>` : '<p>尚未核验个人条件；公开条件和技术相关不表示本人已经符合。</p>';
  return `<section><h2>投递资格</h2>${details}<p><a href="/qualification-profile">补充个人资格事实</a></p><form method="post" action="/jobs/${encodeURIComponent(job.id)}/eligibility"><button>使用当前资格档案重新核验</button></form><details><summary>高级：独立历史资料核验</summary><form method="post" action="/jobs/${encodeURIComponent(job.id)}/eligibility"><label>有来源的资格事实（JSON）<textarea name="profile" rows="5" required>${escapeHtml(JSON.stringify(result?.profileSnapshot ?? {version:'manual-v1'},null,2))}</textarea></label><button>保留独立版本核验</button></form></details></section>`;
}
