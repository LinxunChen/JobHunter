export const issueCategoryLabels={source:'来源访问',model:'模型服务',project:'项目执行',review:'待核验'};

// Classify each reason separately: a source can have both access and model failures.
export function classifyOperationIssue(reason,entries=[]) {
 const item=(code,category,label,action,solution)=>({code,category,categoryLabel:issueCategoryLabels[category],label,action,solution});
 if(/已完成.*错误事件|未知事件类型/.test(reason)||entries.some(x=>x.diagnostics?.eventCounts?.turnCompleted>0)&&/Codex.*缺少成功完成/.test(reason))return item('model_protocol','project','模型已返回，回执校验拒收','核对事件与输出校验','完成事件已收到；检查安全错误码、未知事件类型及输出校验。仅认可已核实的恢复事件，致命错误与真实工具执行继续拒收，不要求本人重新登录。');
 if(/本批后续模型调用已暂停/.test(reason))return item('model_deferred','project','本批模型加工已暂停，未执行','先恢复前置调用','这些记录未实际调用模型，不是各来源分别故障。先用少量已保存原文验证前置失败恢复，再继续加工；无需逐条人工确认或删除来源。');
 if(/额度不足|使用额度|quota|usage.limit/i.test(reason))return item('model_quota','model','模型额度不足','等待额度恢复','等待额度恢复后重新检查；项目会暂停本批后续模型调用，保留已取得原文。无需删除来源。');
 if(/Codex.*登录|模型.*认证|模型.*登录/.test(reason))return item('model_auth','model','模型登录失效','本人登录','本人恢复 Codex 登录后重新检查；不需要登录招聘网站或移除来源。');
 if(/Codex.*模型不可用|模型不可用/.test(reason))return item('model_unavailable','model','模型不可用','核对模型配置','核对现有模型是否可用；调整配置需本人确认，之后重查已保存原文。');
 if(/Codex.*连接中断|模型.*连接中断|模型.*服务暂不可用|Codex.*请求受限/.test(reason))return item('model_connection','model','模型连接中断或服务受限','稍后重查','网络或服务恢复后重查；连续同类失败会暂停本批后续模型调用。来源原文保留，不据此剔除来源。');
 if(/本地加工进程超时|Codex.*超时|模型加工.*超时/.test(reason))return item('model_timeout','project','模型加工超时','检查代码与输入范围','检查单岗输入大小、模型耗时和子进程超时；缩小输入范围后复验，不能靠延长超时宣称解决。');
 if(/Codex.*缺少成功完成|Codex.*未成功返回/.test(reason))return item('model_incomplete','project','模型回执未通过，需核对诊断','重试并保留诊断','旧回执没有保存失败事件，属于项目诊断证据缺失，不能据此认定服务或来源故障。用已保存原文重试并核对新回执的事件统计；重试成功即恢复，无需本人逐条确认或删除来源。');
 if(/Codex.*请求或输出结构配置无效|Codex.*输入超出模型限制/.test(reason))return item('model_request','project','模型请求配置或输入不合要求','修改代码并复验','核对输出结构和输入大小，修正项目请求后用同一原文复验；不需要本人登录或移除来源。');
 if(/Codex.*进程失败/.test(reason)&&entries.some(x=>x.diagnostics?.terminalEvent==='failed'&&x.diagnostics?.eventCounts?.turnFailed>0))return item('model_execution','project','模型执行已返回失败回执','在额度内按退避策略重试','已收到模型执行失败事件，没有可采用输出；并非招聘来源访问失败。当前回执未提供可识别的底层错误类别，不能断言是服务故障或配置错误。保留原文和诊断，在每日额度内稍后重试；连续失败暂停本批，不需要本人确认岗位或删除来源。');
 if(/模型证据无法定位|投递入口.*缺少原文证据|本岗位名称未出现在岗位证据中|条件必须保留原文证据条款|duties缺少原文证据/.test(reason))return item('extraction_evidence','project','加工结果未保留原文证据','修正采集或抽取后复验','先核对模型是否有完成回执；有回执说明调用完成，但字段不能按原文核对。核对保存原文、引用段落及不可见字符差异，修正抽取后复验；不降低证据校验、不要求本人确认模型猜测。');
 if(/公众号图片正文尚未自动读取/.test(reason))return item('source_image','project','公众号招聘信息在图片中，项目尚未读全','补齐图片正文后按范围处理','页面已经可读；缺口是项目尚未提取图片内的岗位、资格和截止信息。仅当图片包含仍在招的北京软件算法岗位时，复制该岗位完整文字及报名说明到文章补录入口；无相关岗位无需操作。补录前保留原文，不调用模型、不推荐。');
 if(/公众号.*访问验证/.test(reason))return item('source_wechat','source','公众号正文需访问验证','微信打开后补录','本人在微信打开原文章、完成访问验证，复制完整正文并取得实际附件，再从该文章的人工补录入口保存。自动检查保留栏目线索；无需删除机构或逐条确认暂停加工记录。');
 if(/建行.*重新登录/.test(reason))return item('source_session','source','建行详情接口请求被拒绝','核对浏览器与程序读取差异','“请重新登录”是接口返回的错误文案，不能证明公开详情必须登录。先对照官方浏览器中的完整详情与程序请求参数、域名、页面上下文和匿名会话；浏览器能打开时由项目修适配，不要求本人重复登录或逐条补录。只有官方页面实际要求登录时，才由本人完成。公开列表及已有结果保留，不据此删除来源。');
 if(/建行.*公开查询失败/.test(reason))return item('source_session','source','建行公开接口拒绝请求','核对公开接口','核对官方社招公开接口、请求参数与匿名会话协议；本人可在官方入口打开岗位。不能仅凭查询失败认定需要账号，保留来源与已有结果。');
 if(/公众号.*访问验证|验证码|访问验证|重新登录|HTTP\s*(401|403|412)/i.test(reason))return item('source_verification','source','招聘入口访问受限','人工核验或修适配器','在官方入口人工核验；公众号可补录本人取得的原文，建行需核对公开接口／会话适配。验证码由本人处理。持续受限可暂停自动检查，保留入口。');
 if(/HTTP\s*\d{3}|网站.*超时|访问.*超时|查询失败|fetch failed|网络|ENOTFOUND|ECONN/i.test(reason))return item('source_network','source','来源请求失败','稍后重查或修适配器','先复查官方入口是否可达，再核对请求／分页适配；站点短暂故障等恢复，接口变更改代码，持续失效再评估暂停。');
 if(/结构变化|格式无效|分页|重复或|数量不符|身份.*不一致|附件.*对应|格式.*不支持|事件流|有效JSON|意外执行工具/.test(reason))return item('adapter_processing','project','解析或证据校验未通过','修改代码并复验','核对原始页面／附件与字段对应，修复适配或加工校验；保留原证据，未验证前不升级为成功。');
 if(/匹配尚未完成|职业资料|资格|待核验|尚无完整/.test(reason))return item('review_pending','review','资料或岗位判断待核验','补充依据或重查','在详情核对具体缺口；缺个人事实需本人确认，已有原文的待加工项待模型恢复后重查。');
 if(/周期未完成|手动检查未完成|进程.*中断|步骤未完成|备份/.test(reason))return item('execution_interrupted','project','执行未完成','检查运行记录','查看当前步骤与持久进度；进程确已中断才恢复未完成检查，不重复已完成步骤或旧通知。');
 return item('unclassified','review','原因待核验','检查详细证据','查看来源或运行详情定位原因；现有证据不足，暂不自动改配置或删除来源。');
}

export function groupOperationIssues(issues) {
 const groups=new Map();
 for(const issue of issues) {
  const diagnosis=classifyOperationIssue(issue.reason,issue.items),key=diagnosis.code+(diagnosis.code==='unclassified'?'|'+issue.reason:'');
  const group=groups.get(key)??{...diagnosis,count:0,details:[],sourceIds:[],names:[]};
  group.count++;group.details.push({...issue,...diagnosis});
  for(const entry of issue.items){if(entry.sourceId&&!group.sourceIds.includes(entry.sourceId))group.sourceIds.push(entry.sourceId);if(!group.names.includes(entry.name))group.names.push(entry.name);}
  groups.set(key,group);
 }
 return [...groups.values()];
}
