import { escapeHtml, readableFacts } from './web.mjs';

const fields = { title: '岗位标题', recruitmentUnit: '招聘单位', contractingEntity: '签约主体', department: '部门', batch: '招聘批次', location: '已确认工作城市', knownConditions: '公开条件（完整列表，每行一条）', publishedAt: '原始发布日期' };
const inputValue = (field, value) => field === 'knownConditions' ? value.join('\n') : field === 'location' ? value.confirmed ?? '' : value ?? '';
const form = (job, correction) => `<form method="post" action="/jobs/${encodeURIComponent(job.id)}/corrections">${correction ? `<input type="hidden" name="field" value="${escapeHtml(correction.field)}"><p>重新核对 ${escapeHtml(fields[correction.field] ?? correction.field)}</p>` : `<label>纠正字段<select name="field">${Object.entries(fields).map(([field, label]) => `<option value="${field}">${label}</option>`).join('')}</select></label>`}<label>纠正后的值（条件每行一条；城市只填确认城市）<textarea name="value" rows="3">${escapeHtml(correction ? inputValue(correction.field, correction.value) : '')}</textarea></label><label>本人核对依据<textarea name="reason" required>${escapeHtml(correction?.basis.reason ?? '')}</textarea></label><label>依据链接（未知留空）<input name="sourceUrl" type="url" value="${escapeHtml(correction?.basis.sourceUrl ?? '')}"></label><label>依据定位／确认记录<input name="locator" value="${escapeHtml(correction?.basis.locator ?? '')}"></label><label>依据原文引用<textarea name="quote">${escapeHtml(correction?.basis.quote ?? '')}</textarea></label><button>保存纠正及适用证据</button></form>`;

export function correctionFromForm(formData, job) {
  const field = formData.get('field');
  const value = formData.get('value') ?? '';
  return { field, value: field === 'knownConditions' ? value.split(/\r?\n/).map(text => text.trim()).filter(Boolean) : field === 'location' ? { ...job.location, confirmed: value } : value, basis: { reason: formData.get('reason'), sourceUrl: formData.get('sourceUrl'), locator: formData.get('locator'), quote: formData.get('quote') } };
}

export function correctionsPanel(job) {
  const history = (job.manualCorrections ?? []).map(record => `<article><h3>${escapeHtml(fields[record.field] ?? record.field)}</h3><p>${record.superseded ? '已被后续本人纠正替代，历史保留' : record.needsReview ? '原文实质变化，需核对适用性；暂停应用此纠正，当前显示来源值' : '当前有效的本人纠正，来源值仍保留'}</p><div><h4>原值</h4>${readableFacts(record.originalValue)}<h4>纠正值</h4>${readableFacts(record.value)}</div><p>依据：${escapeHtml(record.basis.reason)}</p><p>定位：${escapeHtml(record.basis.locator ?? '未知')} · 引用：${escapeHtml(record.basis.quote ?? '未提供')}</p>${record.basis.sourceUrl ? `<p><a href="${escapeHtml(record.basis.sourceUrl)}" target="_blank" rel="noopener noreferrer">纠正依据来源</a></p>` : ''}<p>记录：${escapeHtml(record.recordedAt)} · 适用证据：${escapeHtml(record.applicableEvidenceVersion)}</p>${!record.superseded && record.needsReview && fields[record.field] ? `<details><summary>核对当前原文后重新确认</summary>${form(job, record)}</details>` : ''}</article>`).join('');
  return `<section><h2>人工纠正</h2><p>仅保存本人有依据的纠正，不改写来源原文、身份或实际投递。来源实质变化后旧纠正保留，核对适用性前暂停用于当前判断。</p>${history || '<p>尚无人工纠正。</p>'}<details><summary>新增本人纠正</summary>${form(job)}</details></section>`;
}

export function applicationLinksPanel(application) {
  const links = application.links ?? [];
  const candidates = application.priorCandidates ?? [];
  return `<section><h4>新批次申请关联</h4><p>本次批次：${escapeHtml(application.jobSnapshot.batch ?? '未知')} · 本次申请编号：${escapeHtml(application.id)}</p>${links.map(link => `<p>新申请 ${escapeHtml(link.applicationId)} ↔ 旧申请 ${escapeHtml(link.priorApplicationId)}；本人依据：${escapeHtml(link.reason)}；记录 ${escapeHtml(link.recordedAt)}</p>`).join('') || '<p>尚未明确关联旧申请；不会自动继承已投递、备注或简历。</p>'}${candidates.length ? `<form method="post" action="/applications/${encodeURIComponent(application.id)}/links"><label>关联旧批次的实际申请<select name="priorApplicationId">${candidates.map(prior => `<option value="${escapeHtml(prior.id)}">${escapeHtml(prior.jobSnapshot.batch)} · ${escapeHtml(prior.appliedAt)} · ${escapeHtml(prior.id)}</option>`).join('')}</select></label><label>本人关联依据<textarea name="reason" required></textarea></label><button>保存新旧申请关联</button></form>` : ''}</section>`;
}
