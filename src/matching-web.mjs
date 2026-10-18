import { careerRefreshPanel } from './career-refresh-web.mjs';
import { escapeHtml, page } from './web.mjs';
const levels = { high: '高', medium: '中', low: '低', unknown: '无法判断' };
const items = values => values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : '<p>未记录</p>';
const pairs = values => values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value.explanation)}<p>职业资料引文：${escapeHtml(value.profileQuote)}</p><p>岗位引文：${escapeHtml(value.jobQuote)}</p></li>`).join('')}</ul>` : '<p>没有足够直接依据</p>';
export function matchingSummary(match) {
  const current = match?.status === 'completed' ? match : match?.previousResult;
  return current?.output ? `专业：${levels[current.output.technical.level]} · 业务：${levels[current.output.business.level]} · 职责层级：${levels[current.output.scope.level]}${match.status !== 'completed' ? '（此前结果）' : current.stale || current.profileStale ? '（依据已更新，待重新核验）' : ''}` : '匹配尚未完成';
}
export function matchingPanel(job) {
  const match = job.matching;
  const current = match?.status === 'completed' ? match : match?.previousResult;
  const failure = match?.status === 'failed' ? `<p>本次匹配失败：${escapeHtml(match.gaps.join('；'))}。${current ? '保留此前已完成结果及其版本，请勿当作本次新结论。' : '保留原文，未补造匹配结论。'}</p>` : match?.status === 'deferred' ? `<p>匹配尚未执行，等待额度或模型恢复：${escapeHtml(match.gaps.join('；'))}。原文与已有结果保留。</p>` : match?.status === 'processing' ? '<p>匹配加工中，原文及个人操作仍可读。</p>' : '';
  const details = current?.output ? `<p>${current.stale || current.profileStale ? '岗位证据或职业资料已变化，此结果需重新核验。' : ''}</p><p>职业资料版本：${escapeHtml(current.profileVersion)} · 岗位版本：${escapeHtml(current.jobVersion)} · 判断版本：${escapeHtml(current.matchVersion)}</p>${[['technical', '专业匹配'], ['business', '业务匹配'], ['scope', '职责层级匹配']].map(([key, label]) => `<article><h3>${label}：${levels[current.output[key].level]}</h3><p>${escapeHtml(current.output[key].explanation)}</p><h4>直接经历</h4>${pairs(current.output[key].directExperiences)}<h4>可迁移能力</h4>${pairs(current.output[key].transferableAbilities)}<h4>专业差距／待核对</h4>${items(current.output[key].gaps)}<h4>岗位依据</h4>${items(current.output[key].jobQuotes)}</article>`).join('')}<p>路线：${({ expert: '资深专家', leader: '技术负责人／管理', both: '专家及负责人', uncertain: '职责不足以判断' })[current.output.route]} · ${escapeHtml(current.output.routeExplanation)}</p>${items(current.output.uncertainties)}<p>${match?.qualificationAllowsAction ? '资格仅符合已核验条件，不保证审核或录用。' : '资格尚未核验、存在待核验或明确不符，专业匹配不重新放行报名推荐。'}</p>` : '<p>尚无可采用的三维匹配结果。</p>';
  return `<section><h2>岗位匹配</h2>${failure}${details}<p>只用已保存的指定职业概览或本人手动资料，通过Codex GPT加工。<a href="/career">查看档案版本／补录</a></p><form method="post" action="/jobs/${encodeURIComponent(job.id)}/match"><button>使用最新职业档案匹配／重算</button></form></section>`;
}
export function careerPage(profiles, refreshes = []) {
  return page('职业资料版本', `${careerRefreshPanel(refreshes)}<p><a href="/qualification-profile">个人资格事实与版本</a></p><p>仅指定SiYuan-Life职业概览或本人手动档案。此页面不扫描思源，也不读取原始简历附件。</p>${items(profiles.map(profile => `${profile.version} · 来源${profile.sourceId} · hash${profile.hash} · 读取${profile.readAt}`))}<details><summary>手动保存有依据的职业档案</summary><form method="post" action="/career"><label>明确版本<input name="version" required></label><label>职业事实（不填联系方式或地址）<textarea name="text" rows="8" required></textarea></label><button>本机保存版本</button></form></details>`);
}
