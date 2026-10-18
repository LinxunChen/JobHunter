import {page,escapeHtml} from './web.mjs';
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)+28800000).toISOString().slice(0,16).replace('T',' '):'未记录';
const labels={success:'完成',completed:'完成',partial:'部分完成',failed:'失败',running:'检查中',checking:'检查中',interrupted:'中断',unknown:'结果未知',accepted:'接口已接受',service_reported_sent:'服务报告已发送',final_failed:'明确失败',retry_wait:'等待重试',cancelled:'已取消'};

export function historyPage({kind,sourceId,cursor},result) {
 const query=new URLSearchParams({kind,...(sourceId?{sourceId}:{}),...(cursor?{cursor}:{})});
 const next=new URLSearchParams(query);if(result.nextCursor)next.set('cursor',result.nextCursor);
 return page('检查历史',`<p><a href="/sources">来源与设置</a> · <a href="/runs">后台运行</a></p><section class="panel"><p class="muted">每页${result.limit}条 · 北京时间</p><div class="history-scroll" tabindex="0" aria-label="历史记录表格"><table class="history-table"><thead><tr><th>时间</th><th>来源／记录</th><th>结果</th><th>详情</th></tr></thead><tbody>${result.items.map(item=>`<tr><td>${time(item.checkedAt??item.startedAt??item.observedAt??item.createdAt)}</td><td>${escapeHtml(item.sourceId??item.id)}</td><td>${escapeHtml(labels[item.status]??item.status??'已记录')}</td><td><a href="/api/history/${encodeURIComponent(kind)}/${encodeURIComponent(item.id)}/raw" target="_blank" rel="noopener noreferrer">原始证据</a></td></tr>`).join('')}</tbody></table></div>${result.nextCursor?`<p><a href="/history?${escapeHtml(next.toString())}">下一页</a></p>`:'<p class="muted">已到最后一页。</p>'}</section>`,{activePage:'/sources'});
}
