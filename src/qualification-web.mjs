import { page, escapeHtml, readableFacts } from './web.mjs';

export function qualificationProfilePage(current, history = []) {
  return page('个人资格档案',qualificationProfileForm(current,history));
}
export function qualificationProfileForm(current, history = []) {
  const facts = current?.facts ?? {};
  return `<p class="muted">只填写已确认事实。保存后重新核验现有岗位，不改变职业匹配资料或投递记录。</p><section class="qualification-form"><form method="post" action="/qualification-profile"><div class="form-grid"><label>最高已取得学历<select name="education"><option value="">未确认</option>${['大专','本科','硕士','博士'].map(value=>`<option${facts.education===value?' selected':''}>${value}</option>`).join('')}</select></label><label>毕业专业<input name="major" value="${escapeHtml(facts.major)}" placeholder="按毕业证书或本人确认的名称"></label><label>出生日期<input name="birthday" type="date" value="${escapeHtml(facts.birthday)}"></label><label>已取得证书（每行一个）<textarea name="certificates" rows="2">${escapeHtml(facts.certificates?.join('\n'))}</textarea></label></div><label>相关经历（每行：领域 | 开始年月 | 结束年月）<textarea name="experiences" rows="3" placeholder="AI | 2021-01 | 2024-01">${escapeHtml(facts.experiences?.map(item=>`${item.domain} | ${item.startMonth} | ${item.endMonth}`).join('\n'))}</textarea></label><details><summary>本人声明条件</summary><label>已明确确认的完整条款（每行一条）<textarea name="declarations" rows="3">${escapeHtml(facts.declarations?.join('\n'))}</textarea></label><p class="muted">例如亲属回避条件；不确定的条款请留空。</p></details><button>保存事实并核验岗位</button></form></section><details><summary>来源与版本 · ${history.length} 个版本</summary>${history.map(profile=>`<article><h3>${escapeHtml(profile.version)}</h3><p>${escapeHtml(profile.savedAt)}</p>${readableFacts(profile.facts)}${readableFacts(profile.sources)}</article>`).join('')||'<p>尚无记录。</p>'}</details>`;
}

export function qualificationFromForm(form, current) {
  const facts = {}, sources = {};
  for (const key of ['education','major','birthday','certificates','experiences','declarations']) {
    const text = (form.get(key) ?? '').trim();
    if (!text) continue;
    if (['certificates','declarations'].includes(key)) facts[key] = text.split('\n').map(line=>line.trim()).filter(Boolean);
    else if (key==='experiences') facts[key] = text.split('\n').filter(line=>line.trim()).map(line=>{const[domain,startMonth,endMonth]=line.split('|').map(part=>part.trim());return{domain,startMonth,endMonth};});
    else facts[key] = text;
    sources[key] = JSON.stringify(facts[key])===JSON.stringify(current?.facts[key]) ? current.sources[key] : {kind:'user',reference:'本机个人资格表单',quote:text};
  }
  return { facts, sources };
}
