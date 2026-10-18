const categories = new Set(['acquisition','pagination','detail','attachment','processing']);
export function sourceFailureCategory(run) {
  if(run.status==='success')return null;
  if(categories.has(run.failureCategory))return run.failureCategory;
  const stage={official_chain:'acquisition',list:'pagination',catalog:'pagination',detail:'detail',announcement:'detail',attachment:'attachment',attachments:'attachment',attachment_scoping:'attachment',processing:'processing'}[run.stage];
  if(stage)return stage;
  const reason=[run.error,...(run.gaps??[])].filter(Boolean).join(' ');
  if(/Codex|模型加工|岗位加工|本地加工/.test(reason))return 'processing';
  if(/附件/.test(reason))return 'attachment';
  return 'unknown';
}
function reasonFor(issue) {
  const reason=[issue.error,...(issue.gaps??[])].filter(Boolean).join(' '),category=sourceFailureCategory({...issue,status:issue.checkStatus??'partial'});
  if(category==='processing'){
    if(/使用额度|额度不足|rate.limit|quota/i.test(reason))return '岗位分析未完成（模型额度不足）';
    if(/登录|认证/.test(reason))return '岗位分析未完成（模型登录失效）';
    if(/模型不可用/.test(reason))return '岗位分析未完成（模型不可用）';
    if(/连接中断|连接失败|网络/.test(reason))return '岗位分析未完成（模型连接中断）';
    if(/超时/.test(reason))return '岗位分析超时';
    if(/缺少成功完成|未成功返回/.test(reason))return '岗位分析未完成（模型未成功返回）';
    return '岗位分析未完成';
  }
  if(category==='attachment'){
    if(/无法唯一对应/.test(reason))return '岗位与附件未能唯一对应';
    if(/格式未支持|类型暂不支持/.test(reason))return '附件格式暂不支持';
    if(/附件.*未取得|附件.*缺失/.test(reason))return '招聘附件未取得';
  }
  if(/公众号.*访问验证/.test(reason))return '公众号正文需访问验证';
  if(/验证码|访问验证|登录/.test(reason))return '招聘入口需访问验证或登录';
  const status=reason.match(/HTTP\s*(\d{3})/)?.[1];
  if(status)return ['401','403'].includes(status)?'招聘入口访问受限（HTTP '+status+'）':'招聘入口返回 HTTP '+status;
  if(/超时/.test(reason))return '招聘入口访问超时';
  if(category==='pagination')return '招聘列表未完整取得';
  if(category==='detail')return '岗位详情未完整取得';
  return (issue.error??issue.gaps?.[0]??'招聘检查未完成').replace(/[\r\n]+/g,' ').slice(0,90);
}
export function summarizeSourceIssues(issues) {
  const groups=new Map();
  for(const issue of issues){
    const reason=reasonFor(issue),category=sourceFailureCategory({...issue,status:issue.checkStatus??'partial'}),key=category+'\0'+reason;
    const group=groups.get(key)??{category,reason,sourceIds:[],names:[]};
    if(!group.sourceIds.includes(issue.sourceId)){group.sourceIds.push(issue.sourceId);group.names.push((issue.sourceName??issue.name??'未命名来源').replace(/官方(?:社会招聘|社招平台|社招|招聘公告|招聘)(?:（主体分别核验）)?$/,'').trim());}
    groups.set(key,group);
  }
  return [...groups.values()].map(group=>({...group,text:group.names.slice(0,3).join('、')+(group.names.length>3?'等'+group.names.length+'个来源':'')+'：'+group.reason}));
}
export function sourceSystemStatus(sources) {
  const active=sources.filter(x=>x.implemented&&x.monitoring?.enabled!==false);
  if(!active.some(x=>x.latest))return '尚无检查记录';
  if(active.some(x=>['partial','failed'].includes(x.latest?.status)))return '检查部分完成';
  if(active.some(x=>!x.latest||!['success','paused'].includes(x.latest.status)))return '部分来源待检查';
  return '检查正常';
}
