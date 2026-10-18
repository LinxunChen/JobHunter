import {createHash} from 'node:crypto';
// Provider messages can contain credentials or source text. Persist only
// counters, enum codes, one-way signatures and words from a fixed vocabulary.
export function isRetryNotice(event) {
 const message=event.message??event.error?.message;
 return event.type==='error'&&typeof message==='string'&&/^Reconnecting\.\.\. (?:\d+\/\d+|waiting for network)\.?(?: \([^\r\n]+\))?$/.test(message);
}

export function inspectCodexResult(result) {
 let events;try{events=result.stdout.trim().split('\n').filter(Boolean).map(line=>{const event=JSON.parse(line);if(!event||typeof event!=='object'||Array.isArray(event))throw Error();return event;});}catch{events=null;}
 const list=events??[],counts={threadStarted:0,turnStarted:0,turnCompleted:0,turnFailed:0,retryErrors:0,otherErrors:0,agentMessages:0,reasoningItems:0,warningItems:0,toolItems:0,unknownItems:0};
 const tools=new Set(['todo_list','command_execution','mcp_tool_call','web_search','file_change','collab_agent_tool_call']);
 const safeType=value=>typeof value==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(value)?value:'unknown';
 const codes=new Set(['rate_limit_exceeded','insufficient_quota','invalid_api_key','invalid_request_error','server_error','internal_error','model_not_found','context_length_exceeded','authentication_error','connection_error','timeout']);
 let terminalEvent='missing';const itemTypes={},errorEvents=[];
 for(const event of list) {
  const counters={'thread.started':'threadStarted','turn.started':'turnStarted','turn.completed':'turnCompleted','turn.failed':'turnFailed'};if(Object.hasOwn(counters,event.type))counts[counters[event.type]]++;
  if(event.type==='turn.completed')terminalEvent='completed';if(event.type==='turn.failed')terminalEvent='failed';
  if(event.type==='error'){
   const retry=isRetryNotice(event),message=String(event.message??event.error?.message??'');
   const vocabulary=new Set('tool function error failed execute reconnect request not found output field type unknown disabled timeout invalid rate limit exceeded internal server authentication insufficient quota json schema connection network read file shell command unsupported configuration model stream transport retry'.split(' '));
   const terms=[...new Set((message.toLowerCase().match(/[a-z]+/g)??[]).filter(x=>vocabulary.has(x)))].slice(0,16);
   const code=event.error?.code??event.code;
   counts[retry?'retryErrors':'otherErrors']++;errorEvents.push({index:list.indexOf(event),retry,code:codes.has(code)?code:'unknown',signature:createHash('sha256').update(message).digest('hex'),terms});
  }
  if(event.item){const type=safeType(event.item.type);counts[type==='agent_message'?'agentMessages':type==='reasoning'?'reasoningItems':type==='error'?'warningItems':tools.has(type)?'toolItems':'unknownItems']++;itemTypes[type]=(itemTypes[type]??0)+1;}
 }
 const text=list.filter(event=>['error','turn.failed'].includes(event.type)).map(event=>JSON.stringify(event.error??event.message??event)).join(' ')+' '+result.stderr;
 const reasons=[
  [/usage.limit|insufficient.quota|quota.exceeded|使用额度/i,'quota','使用额度不足'],
  [/rate.limit|too many requests/i,'rate_limit','请求受限'],
  [/unauthorized|authentication|not.logged.in|login.required|invalid.api.key/i,'authentication','登录失效'],
  [/model.not.found|unsupported.model|model.*not.*supported/i,'model','模型不可用'],
  [/invalid.json.schema|invalid.schema|invalid.response.format|invalid_request_error/i,'configuration','请求或输出结构配置无效'],
  [/context.length.exceeded|maximum.context.length|input.too.large/i,'input','输入超出模型限制'],
  [/stream.disconnected|connection|network|failed.to.fetch|error.sending.request/i,'connection','连接中断'],
  [/overload|service.unavailable|internal.server.error|server_error|internal_error/i,'service','服务暂不可用'],
 ];
 const matched=reasons.find(([pattern])=>pattern.test(text));
 return {events,reason:matched?{category:matched[1],label:matched[2]}:{category:'unknown',label:null},diagnostics:{version:2,eventStreamReadable:events!==null,eventCounts:counts,terminalEvent,itemTypes,errorEvents}};
}
