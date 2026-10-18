import {sourceProcessingKey} from './local-settings.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
const sourceId='beijing-sasac',indexUrl='https://gzw.beijing.gov.cn/yggq/gqzp/';
import {discoveryScope,discoveryDeadline,discoveryEvidenceText,discoveryReviewPolicy,discoveryPublication,discoveryMiniProgramAttachments} from './discovery-scope.mjs';
const mediaTypes={txt:'text/plain',csv:'text/csv',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel'};
 const hash=value=>createHash('sha256').update(value).digest('hex');
const decode=text=>text.replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&nbsp;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,code)=>String.fromCodePoint(code.startsWith('x')?parseInt(code.slice(1),16):Number(code)));
const plain=html=>decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<\/(?:p|div|tr|li|h[1-6])>|<br\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
function allowed(url,binary=false){let value;try{value=new URL(url);}catch{return false;}return value.protocol==='https:'&&!value.username&&!value.password&&(!value.port||value.port==='443')&&((value.hostname==='gzw.beijing.gov.cn'&&(value.pathname.startsWith('/yggq/gqzp/')||(binary&&/\.(pdf|docx?|xlsx?|csv|txt)$/i.test(value.pathname))))||(binary&&value.hostname==='mmbiz.qpic.cn'&&/^\/(?:sz_)?mmbiz_(?:jpg|png|gif|jpeg)\//.test(value.pathname))||(value.hostname==='mp.weixin.qq.com'&&/^\/(?:s\/|mp\/verify|mp\/wappoc_appmsgcaptcha(?:$|\?))/.test(value.pathname)));}
async function publicCurl(url,{signal}={}){
 if(!allowed(url,true))throw Error('北京国资委公开请求地址越界');
 const referer=new URL(url).hostname==='mmbiz.qpic.cn'?'https://mp.weixin.qq.com/':indexUrl;
 const args=['--noproxy','*','--user-agent','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36','--referer',referer,'--silent','--show-error','--connect-timeout','10','--max-time','20','--max-filesize',String(8*1024*1024),'--dump-header','-','--write-out','\n%{http_code}',url];
 return new Promise((resolve,reject)=>execFile('/usr/bin/curl',args,{encoding:null,signal,maxBuffer:8*1024*1024+4096,timeout:22000},(error,output)=>{
  if(error)return reject(Error(`北京国资委公开读取失败（curl exit=${error.code??'unknown'}）；保持正常证书校验`));
  const status=Number(output.subarray(-3).toString()),split=output.indexOf('\r\n\r\n');if(!Number.isInteger(status)||split<0)return reject(Error('公开响应缺HTTP状态或头部'));
  const headers=new Headers();for(const line of output.subarray(0,split).toString().split('\r\n').slice(1)){const at=line.indexOf(':');if(at>0)headers.append(line.slice(0,at),line.slice(at+1).trim());}
  resolve(new Response(output.subarray(split+4,-4),{status,headers}));
 }));
}
export function createSasacOperations({db,now,application,sasacFetch=publicCurl,sourceTimeoutMs=22000,ValidationError=Error}){
 db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,body TEXT NOT NULL,checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL,external_id TEXT NOT NULL,content_hash TEXT NOT NULL,announcement_id TEXT NOT NULL,PRIMARY KEY(source_id,external_id,content_hash))');
 application.registerSource({id:sourceId,name:'北京国资委招聘发现入口',kind:'discovery',monitoringObjectIds:[],scope:'完整国企招聘栏目分页；只选中正文/附件；公众号访问验证保留缺口，可人工补录，不计雇主或全部详情覆盖'});
 const save=run=>{db.prepare('INSERT INTO source_checks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,sourceId,JSON.stringify(run),run.checkedAt);return run;};
 const history=()=>db.prepare('SELECT body FROM source_checks WHERE source_id=? ORDER BY checked_at DESC,rowid DESC').all(sourceId).map(row=>JSON.parse(row.body));let checking=false;
 async function request(url,binary=false){
    application.assertSourceRequestAllowed(sourceId);let current=url;const chain=[];for(let redirects=0;redirects<4;redirects++){
  application.assertSourceRequestAllowed(sourceId);if(!allowed(current,binary))throw Object.assign(Error('公开链接转向未核验域，停止读取'),{chain});const controller=new AbortController();let timer;
  try{const {response,bytes}=await Promise.race([Promise.resolve().then(async()=>{const response=await sasacFetch(current,{redirect:'manual',signal:controller.signal});return {response,bytes:Buffer.from(await response.arrayBuffer())};}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('北京国资委公开请求超时'));},sourceTimeoutMs);})]);
   if(bytes.length>8*1024*1024)throw Error('来源原件超8MiB读取边界');
   const record={url:current,status:response.status,readAt:now().toISOString(),rawHash:hash(bytes),bytes:bytes.length,raw:binary?null:bytes.toString('utf8')};chain.push(record);
   if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');if(!location)throw Error('公开跳转没有Location');current=new URL(location,current).href;continue;}
   return {record,chain,content:bytes};
  }catch(error){error.chain=chain;throw error;}finally{clearTimeout(timer);}
 }throw Object.assign(Error('公开跳转超过3次读取边界'),{chain});}
 function page(raw,url,expected,total){const current=Number(raw.match(/\bcurrentPage\s*=\s*(\d+)/)?.[1]),count=Number(raw.match(/\bcountPage\s*=\s*(\d+)/)?.[1]);if(current!==expected||!Number.isInteger(count)||count<1||count>100||(total!=null&&count!==total))throw Error('目录分页元数据不一致，完整覆盖未确认');
  const list=raw.match(/class=["']public_list_team["'][^>]*>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1];if(!list)throw Error('目录列表结构未取得');
  const items=[...list.matchAll(/<li[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/li>/g)].map(match=>{const href=decode(match[1].match(/href=["']([^"']+)["']/)?.[1]??''),link=new URL(href,url).href,title=decode(match[1].match(/title=["']([^"']+)["']/)?.[1]??plain(match[2])),listDate=plain(match[3]);if(!allowed(link)||!title||!/^\d{4}-\d{2}-\d{2}$/.test(listDate))throw Error('目录条目字段或官方关联链接无效');return {url:link,title,listDate,page:current+1,recruitmentType:'unverified',titleTypeHint:/校园|校招|应届|优培|高校毕业生|20\d{2}届/.test(title)?(/社会|社招/.test(title)?'mixed':'campus'):/社会|社招/.test(title)?'social':'unverified',dateEvidence:[{field:'listDate',raw:listDate,meaning:'unverified',note:'栏目列示日期，不表示报名截止或正文社招资格'}]};});
  if(!items.length)throw Error('目录非空分页未取得条目');return {total:count,items};}
 function evidenceUseFor(text){return discoveryDeadline(text,now()).status==='expired'?'historical':'unverified';}
 function bodyOf(raw){const start=/<(?:div|section)\b[^>]*\bid=["'](?:div_zhengwen|js_content)["'][^>]*>/i.exec(raw);if(!start)return null;const tag=start[0].match(/^<([a-z]+)/i)[1],rest=raw.slice(start.index+start[0].length),tags=new RegExp('</?'+tag+'\\b[^>]*>','gi');let depth=1;for(const match of rest.matchAll(tags)){depth+=match[0].startsWith('</')?-1:1;if(!depth)return rest.slice(0,match.index).replace(/<div\b[^>]*id=["']qr_container["'][^>]*>[\s\S]*?<\/div>/gi,'');}return null;}
 async function processBody({run,detail,listing,originalText,attachments,manual=false,obtainedAt=null,evidenceUse,process=true,historicalReplay=false}){
  const semanticHash=hash(JSON.stringify({text:originalText.replace(/\s+/g,''),attachments:attachments.map(x=>({name:x.name,hash:x.contentBase64?hash(Buffer.from(x.contentBase64,'base64')):null}))}));
  const cached=db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId,detail.url,sourceProcessingKey(semanticHash));
  let announcement=cached&&application.getAnnouncement(cached.announcement_id);detail.cached=Boolean(announcement);detail.semanticHash=semanticHash;
  if(announcement&&!announcement.jobIds.length&&['saved','failed','scope_excluded'].includes(announcement.status)&&announcement.attachments.some(item=>item.status==='failed'||item.reader==='macOS Vision OCR'&&!item.imageFrames))announcement=await application.retryAnnouncementAttachments(announcement.id);
  if(!announcement){announcement=await application.createAnnouncement({title:listing.title,originalText,sourceUrl:detail.url,evidenceUse,attachments,sourceIdentityContext:{sourceId,externalId:detail.url,observedAt:run.checkedAt,sourceEvidence:{sourceId,articleUrl:detail.url,checkedAt:run.checkedAt,acquisitionMode:manual?'manual':'automatic',manuallyObtainedAt:obtainedAt,discovery:true,listedArticle:true,bodyAcquired:true,rawHash:detail.response?.rawHash??hash(originalText),bodyRecruitmentType:detail.bodyRecruitmentType??'unverified',scope:'选中公告正文/附件；栏目列示不能证明当前招聘开放'},dateEvidence:listing.dateEvidence??[]}});db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId,detail.url,sourceProcessingKey(semanticHash),announcement.id);}
  detail.announcementId=announcement.id;
  const text=discoveryEvidenceText(announcement),publication=discoveryPublication(detail.response?.raw,detail.url);
  const scope=historicalReplay?{status:'eligible',reason:'明确手动历史回放，不代表当前机会'}:discoveryReviewPolicy({decision:{...discoveryScope({text,title:listing.title,at:now(),publication,miniProgramAttachments:discoveryMiniProgramAttachments(detail.response?.raw),attachments:announcement.attachments.map(x=>({contentBase64:x.status==='read'?'read':null,ocrNeedsReview:x.ocrNeedsReview}))}),...(publication?{publication}:{})},text,title:listing.title,listDate:listing.listDate,at:now()});
  detail.processingDecision=scope;
  announcement=application.recordAnnouncementSourceDecision(announcement.id,scope);
  if(scope.deadline?.status==='expired'){detail.historicalGaps=[...detail.gaps,...announcement.gaps];detail.gaps=[];}
  else detail.gaps.push(...announcement.attachments.filter(x=>x.status!=='read').map(x=>x.name+'：'+(x.error??'附件未取得')));
  if(!process||scope?.status!=='eligible'){detail.processingStatus=scope?.status==='excluded'?'scope_excluded':'saved';detail.processingDecision=scope;if(scope?.status==='excluded')detail.processingSkipped=scope.reason;else if(scope)run.businessGaps.push(`${listing.title}：${scope.reason}`);return announcement;}
  run.stage='processing';save(run);announcement=await application.processAnnouncement(announcement.id);detail.processingStatus=announcement.status;
  if(announcement.status==='failed'){run.failureStages.push('processing');detail.gaps.push('正文加工失败：'+announcement.error);return announcement;}
  if(['deferred','scope_pending'].includes(announcement.status)){detail.processingDecision=announcement.sourceProcessingDecision;run.businessGaps.push(listing.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));return announcement;}
  detail.businessGaps=[...announcement.gaps];run.businessGaps.push(...announcement.gaps);detail.gaps.push(...announcement.attachments.filter(x=>x.status!=='read').map(x=>x.name+'：'+(x.error??'附件未取得')));if(!announcement.jobIds.length){detail.gaps.push('正文加工未保存具体岗位；完整原文保留');run.failureStages.push('processing');}if(detail.attachments.some(x=>x.status!==200)||announcement.attachments.some(x=>x.status!=='read')){run.stage='attachment';run.failureStages.push('attachment');}for(const id of announcement.jobIds){const job=application.getSourceJob(id),identity=job.sourceIdentities?.find(x=>x.sourceId===sourceId&&x.externalId.startsWith(detail.url+'#'));run.jobIds.push(id);if(!identity){run.businessGaps.push(`${job.title}：来源身份待人工核验，不派生开放观察`);continue;}
   if(detail.cached)application.importJob({...job,sourceIdentity:identity,observedAt:run.checkedAt,sourceEvidence:{...job.sourceEvidence,checkedAt:run.checkedAt,rawHash:detail.response?.rawHash??job.sourceEvidence?.rawHash},dateEvidence:[...(listing.dateEvidence??[]),...(job.dateEvidence??[]).filter(x=>x.field!=='listDate')]});
   const evidence={url:detail.url,text:originalText,quote:job.title,locator:manual?'本人补录正文':'选中正文'};application.recordRecruitmentObservation(id,{id:run.id+':'+id,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:'success',listComplete:run.listComplete,listed:null,detailAccessible:!manual,applicationOpen:null,evidence,sourceCheckId:run.id,acquisitionMode:manual?'manual':'automatic'});
  }return announcement;
 }
 return {
  async importSasacManual(input){
   if(!input||typeof input.sourceUrl!=='string'||!allowed(input.sourceUrl)||typeof input.obtainedAt!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.obtainedAt)||!Number.isFinite(Date.parse(input.obtainedAt)))throw new ValidationError('人工补录须为官方关联公开链接并明确本人取得时刻（含时区）');
   return application.createAnnouncement({...input,sourceIdentityContext:{sourceId,externalId:input.sourceUrl,observedAt:now().toISOString(),sourceEvidence:{sourceId,articleUrl:input.sourceUrl,checkedAt:now().toISOString(),acquisitionMode:'manual',manuallyObtainedAt:input.obtainedAt,discovery:true,bodyAcquired:true,scope:'本人补录原文/附件，未证明来源自动可读或当前招聘开放'}}});
  },
  getSasacCoverage(){const coverage=application.getSourceCoverageHistory(sourceId),records=coverage.history;return {sourceId,implemented:true,kind:'discovery',scope:'完整栏目与选中详情/附件分别计数；不是雇主或全部当前岗位覆盖',latest:coverage.latest,history:records,historyPage:coverage.historyPage,manualAnnouncements:application.listAnnouncements().filter(x=>x.sourceIdentityContext?.sourceId===sourceId&&x.sourceIdentityContext?.sourceEvidence?.acquisitionMode==='manual').map(x=>({id:x.id,title:x.title,status:x.status,obtainedAt:x.sourceIdentityContext.sourceEvidence.manuallyObtainedAt})),lastSuccessfulAt:coverage.lastSuccessfulAt};},
  async checkSasacSource({articleUrls=[],trigger='manual',scheduledFor=null,processAnnouncements=true,historicalReplay=false}={}){
   if(!['manual','scheduled'].includes(trigger)||(trigger==='scheduled'&&(typeof scheduledFor!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor)||!Number.isFinite(Date.parse(scheduledFor)))))throw new ValidationError('来源计划检查须含时区计划时刻');
   if(typeof historicalReplay!=='boolean')throw new ValidationError('历史回放选项必须为明确布尔值');
   if(historicalReplay&&trigger!=='manual')throw new ValidationError('历史回放须明确手动选择，不用于后台自动加工');
   if(!Array.isArray(articleUrls)||articleUrls.length>10||articleUrls.some(url=>typeof url!=='string'||!allowed(url)))throw new ValidationError('选中详情须为不超过10个栏目官方关联链接');if(checking)throw new ValidationError('发现入口正在检查，请勿重叠');checking=true;
   const run={id:randomUUID(),sourceId,kind:'discovery',checkedAt:now().toISOString(),trigger,scheduledFor,status:'checking',stage:'list',pages:[],listings:[],listCount:0,listComplete:false,details:[],bodyCount:0,attachmentsChecked:0,jobIds:[],currentOpportunityConfirmedCount:0,manualFallbacks:[],failureStages:[],gaps:[],businessGaps:[],error:null};save(run);
   try{let total=null;const seen=new Set();for(let i=0;i<(total??1);i++){run.stage='official_chain';const url=i===0?indexUrl:indexUrl+`index_${i}.html`,response=await request(url);run.pages.push(response.record);save(run);if(response.record.status!==200)throw Error(`目录HTTP ${response.record.status}`);run.stage='list';const parsed=page(response.record.raw,url,i,total);total=parsed.total;for(const item of parsed.items){if(seen.has(item.url))throw Error('目录跨页重复链接，完整快照未确认');seen.add(item.url);run.listings.push(item);}run.listCount=run.listings.length;save(run);}run.listComplete=true;save(run);
    for(const url of articleUrls){if(!application.isSourceSelectionAllowed(sourceId,url))continue;run.stage='detail';const listing=run.listings.find(item=>item.url===url);if(!listing){run.businessGaps.push(`${url}：不在本次完整目录，未读取选中详情`);continue;}
     const prior=application.listAnnouncements().find(item=>item.sourceUrl===url&&item.sourceIdentityContext?.sourceId===sourceId&&discoveryDeadline(discoveryEvidenceText(item),now()).status==='expired');
     const previous=application.listSourceCandidates(sourceId).find(item=>item.externalId===url),sameListing=!previous||previous.title===listing.title&&JSON.stringify(previous.raw)===JSON.stringify(listing);
     if(prior&&sameListing&&!historicalReplay){run.details.push({url,title:listing.title,acquisition:'not_requested',announcementId:prior.id,attachments:[],gaps:[],processingStatus:'scope_excluded',processingSkipped:'已保存正文明确截止日期已过，不重复读取或加工'});save(run);continue;}
     const titleScope=discoveryScope({text:'',title:listing.title,at:now()});
     if(titleScope.status==='excluded'&&!historicalReplay){run.details.push({url,title:listing.title,acquisition:'not_requested',attachments:[],gaps:[],processingStatus:'scope_excluded',processingSkipped:titleScope.reason});save(run);continue;}
     const detail={url,title:listing.title,acquisition:'unknown',chain:[],attachments:[],gaps:[]};run.details.push(detail);save(run);
     try{const response=await request(url);detail.chain=response.chain;detail.response=response.record;save(run);if(response.record.status!==200)throw Error(`选中详情HTTP ${response.record.status}`);
      if((/mmbizwap:secitptpage\/verify\.html|secitptpage\/template\/verify\.js/.test(response.record.raw)||/TCaptcha|TencentCaptcha|tcaptcha/.test(response.record.raw)&&/环境异常|完成验证后即可继续访问|访问过于频繁/.test(plain(response.record.raw)))&&(!bodyOf(response.record.raw)||plain(bodyOf(response.record.raw)).length<40)){detail.acquisition='captcha';run.failureStages.push('detail');detail.gaps.push('公众号访问验证，未取得正文/附件，不绕过验证码');run.manualFallbacks.push({url,title:listing.title,path:'/sources/sasac/manual',reason:detail.gaps[0]});}
      else if(!bodyOf(response.record.raw)&&/该内容已被发布者删除/.test(plain(response.record.raw))){detail.acquisition='unavailable';detail.processingDecision={status:'excluded',reason:'公众号明确显示内容已被发布者删除；原始响应保留，不作为当前机会'};detail.processingStatus='scope_excluded';detail.processingSkipped=detail.processingDecision.reason;}
      else{const body=bodyOf(response.record.raw),text=body&&plain(body);if(!text&&!/<img\b/i.test(body??''))throw Error('正文未取得可核对文字；图片或结构缺口须人工补录');detail.acquisition='success';detail.originalText=text;detail.bodyRecruitmentType=/面向社会|社会招聘|社招/.test(text)?(/校园招聘|应届毕业生/.test(text)?'mixed':'social'):/校园招聘|应届毕业生/.test(text)?'campus':'unverified';run.bodyCount++;const attachments=[];let totalAttachmentBytes=0;
       // Explicitly expired notices need no image/download/OCR work. The full
       // HTML response and attachment links remain evidence of what was skipped.
       if(!historicalReplay&&discoveryDeadline(text??'',now()).status==='expired'){
        detail.skippedAttachmentUrls=[...body.matchAll(/(?:data-src|src|href)=["']([^"']+)["']/gi)].map(match=>decode(match[1]));
        await processBody({run,detail,listing,originalText:text,attachments:[],evidenceUse:'historical',process:false});save(run);continue;
       }
       for(const [i,match] of [...body.matchAll(/<img\b[^>]*>/gi)].entries()){
        const path=decode(match[0].match(/(?:data-src|src)=["']([^"']+)["']/)?.[1]??''),name=`正文图片${i+1}`;
        if(attachments.length>=20)throw Error('附件数量超过20项读取边界，请按选中范围人工补录');
        const image={name,status:'missing'};detail.attachments.push(image);
        try{const link=new URL(path,response.record.url);link.hash='';image.url=link.href;if(!path||!allowed(link.href,true)||link.hostname!=='mmbiz.qpic.cn')throw Error('图片链接超出已核验公众号公开图片域');
         const file=await request(link.href,true);Object.assign(image,{status:file.record.status,rawHash:file.record.rawHash,bytes:file.content.length,chain:file.chain});run.attachmentsChecked++;totalAttachmentBytes+=file.content.length;
         if(image.status!==200||totalAttachmentBytes>8*1024*1024)throw Error('正文图片HTTP失败或总附件超过8MiB');
         const fmt=link.searchParams.get('wx_fmt'),mediaType=fmt==='png'?'image/png':fmt==='gif'?'image/gif':'image/jpeg';attachments.push({name:name+'.'+(fmt??'jpg'),mediaType,contentBase64:file.content.toString('base64')});
        }catch(error){image.error=error.message;attachments.push({name});detail.gaps.push('公众号图片正文尚未自动读取：'+name+'，'+error.message);run.failureStages.push('attachment');}
       }
       for(const match of body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const link=new URL(decode(match[1]),response.record.url).href,name=plain(match[2])||decode(new URL(link).pathname.split('/').at(-1));if(!/\.(pdf|docx?|xlsx?|csv|txt)(?:[?#]|$)/i.test(link)&&!/附件|下载/.test(name))continue;if(attachments.length>=20)throw Error('附件数量超过20项读取边界，请按选中范围人工补录');run.stage='attachment';const item={url:link,name,status:'missing'};detail.attachments.push(item);
        try{if(!allowed(link,true))throw Error('附件链接超出已核验公开域或格式');const file=await request(link,true);item.status=file.record.status;item.chain=file.chain;item.rawHash=file.record.rawHash;item.bytes=file.record.bytes;run.attachmentsChecked++;if(item.status!==200)throw Error(`附件HTTP ${item.status}`);totalAttachmentBytes+=file.content.length;if(totalAttachmentBytes>8*1024*1024)throw Error('选中附件总大小超过8MiB读取边界');const filename=decode(new URL(link).pathname.split('/').at(-1));attachments.push({name:filename,mediaType:mediaTypes[filename.split('.').at(-1).toLowerCase()]??'application/octet-stream',contentBase64:file.content.toString('base64')});}catch(error){item.error=error.message;detail.gaps.push(name+'：'+error.message);attachments.push({name});}save(run);}
       await processBody({run,detail,listing,originalText:text||listing.title,attachments,evidenceUse:historicalReplay?'historical':evidenceUseFor(text??''),process:processAnnouncements,historicalReplay});
       if(detail.gaps.length)run.manualFallbacks.push({url,title:listing.title,path:'/sources/sasac/manual',reason:detail.gaps.join('；')});}

     }catch(error){run.failureStages.push(run.stage);detail.chain=error.chain??detail.chain;detail.acquisition=detail.originalText?'success':'failed';detail.gaps.push(error.message);run.manualFallbacks.push({url,title:listing.title,path:'/sources/sasac/manual',reason:error.message});}run.gaps.push(...detail.gaps);save(run);
    }
   }catch(error){run.failureStages.push(run.stage);run.error=error.message;run.gaps.push(error.message);}finally{run.failureStages=run.gaps.length?[...new Set(run.failureStages)]:[];run.stage=run.failureStages[0]??(run.gaps.length?run.stage:'completed');run.status=run.gaps.length?'partial':'success';run.finishedAt=now().toISOString();save(run);checking=false;application.recordSourceCheck({...run,checkId:run.id});}return structuredClone(run);
  },
 };
}
