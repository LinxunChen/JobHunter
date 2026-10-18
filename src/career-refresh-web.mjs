import { escapeHtml } from './web.mjs';
export function careerRefreshPanel(records) {
  const status = { completed: '检查完成', partial: '资料已保存，部分匹配待完成', failed: '检查失败', processing: '检查中' };
  const changes = { initial: '初次读取', material: '实质变化，更新匹配', unchanged: '无实质变化' };
  return `<section><h2>检查指定职业概览</h2><p>仅只读SiYuan-Life指定职业概览，不扫描其他笔记或原始简历附件。每周入口在最近成功检查满7天后执行；此页面不会安装常驻任务。没有实质变化且无失败加工待补时不重复调用模型，重算不新增岗位，实际投递资料版本保持原记录。</p><form method="post" action="/career/refresh"><input type="hidden" name="trigger" value="manual"><button>手动检查指定职业概览</button></form>${records.map(record => `<article><p>${escapeHtml(status[record.status] ?? record.status)} · ${escapeHtml(record.checkedAt)} · ${record.trigger === 'weekly' ? '周检查' : '手动检查'}</p><p>${escapeHtml(changes[record.change] ?? '未取得完整结果')} · ${escapeHtml(record.profileVersion ?? '旧版本保留')}</p>${record.gaps.map(gap => `<p>${escapeHtml(gap)}</p>`).join('')}<p>匹配加工：${record.recomputed.length}个已有岗位；读取窗口：${record.windows.length}</p></article>`).join('') || '<p>尚未检查，既有档案可继续回看。</p>'}</section>`;
}
