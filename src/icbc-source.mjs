import {sourceProcessingKey} from './local-settings.mjs';
import {reuseRunResource} from './run-resources.mjs';
import {targetLocation,jobRelevance} from './job-relevance.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
const origin='https://job.icbc.com.cn';
const sourceId='icbc-social';
const root=origin+'/icbc/trmo';
const defaultPostId='00000000000006161504';
const apiPaths=new Set(['/post/qryPostList','/post/qryPostById','/announ/qryAnnounList','/announ/qryAnnounListByPostId','/announ/qryAnnounById']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<\/?(?:p|div|br|tr|li|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,code)=>String.fromCodePoint(code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code))).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
function decoded(value){if(typeof value!=='string'||!value)throw Error('正文编码字段缺失');
    // The public API mixes literal HTML (sometimes starting with &nbsp; or
    // Chinese text) with base64-encoded URI text. Decode only the latter.
    if(/<\/?[a-z!]|&(?:nbsp|amp|lt|gt|quot|#\d+);|[^\x00-\x7f]/i.test(value))return value;
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length%4!==0)throw Error('工行正文编码格式无法确认');
    const text=Buffer.from(value,'base64').toString('utf8');
    if(text.includes('\uFFFD'))throw Error('工行正文编码不是有效UTF-8');
    try{return decodeURIComponent(text);}catch{throw Error('工行正文URI编码无效');}}

// Normal certificate verification through the existing macOS curl. This adapter has no login or write API.
async function publicCurl(url,options={}){
 const parsed=new URL(url);
    const path=parsed.pathname;
 if(parsed.origin!==origin||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('工行公开请求地址越界');
 const api=path.startsWith('/icbc/trmo/')&&apiPaths.has(path.slice('/icbc/trmo'.length));
 const asset=path==='/'||path==='/pc/index.html'||/^\/icbc\/trmo\/d\/pc\/(?:umi\.[a-f0-9]+\.js|p__main___layout\.[a-f0-9]+\.async\.js)$/.test(path)||/^\/api\/v1\/chunkserver\/TRM-default\/_\/[^/]+\.(xls|xlsx|pdf|docx)$/i.test(path);
 if(!api&&!asset)throw Error('未授权的工行公开路径');
 if((api&&options.method!=='POST')||(!api&&options.method&&options.method!=='GET'))throw Error('工行请求方法越界');
 const args=['--noproxy','*','--silent','--show-error','--connect-timeout','15','--max-time','40','--max-filesize',String(5*1024*1024),'--write-out','\n%{http_code}',url];
 if(api)args.push('--request','POST','--header','Content-Type: application/json','--data-binary','@-');
 return new Promise((resolve,reject)=>{
  const child=execFile('/usr/bin/curl',args,{encoding:null,maxBuffer:5*1024*1024+1024,timeout:45000,signal:options.signal},(error,stdout)=>{
   if(error)return reject(Error(`工行公开请求失败（curl exit=${error.code??'unknown'}）；未关闭证书校验`));
   const status=Number(stdout.subarray(-3).toString());
    if(!Number.isInteger(status)||status<100||status>599)return reject(Error('工行公开请求未返回HTTP状态'));
   resolve(new Response(stdout.subarray(0,-4),{status}));
  });child.stdin.on('error',()=>{});child.stdin.end(api?options.body:undefined);
 });
}

export function createIcbcOperations({db,now,application,icbcFetch,sourceTimeoutMs=45000,attachmentPython,isAutomatic,ValidationError=Error}){
 const sourceFetch=icbcFetch??publicCurl;
 db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL, checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL, announcement_id TEXT NOT NULL, PRIMARY KEY(source_id,external_id,content_hash))');
 application.registerSource({id:sourceId,name:'工商银行官方社招',kind:'recruitment',monitoringObjectIds:['seed-02'],scope:'全部公开社会招聘岗位和公告目录分页；仅选中岗位正文、关联公告和附件原件；附件是否完整依实际读取结果'});
 const save=run=>db.prepare('INSERT INTO source_checks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,sourceId,JSON.stringify(run),run.checkedAt);
 const history=()=>db.prepare('SELECT body FROM source_checks WHERE source_id=? ORDER BY rowid DESC').all(sourceId).map(row=>JSON.parse(row.body));
 let checking=false,activeRun=null;
 async function request(url,options={}){
    application.assertSourceRequestAllowed(sourceId);
  const controller=new AbortController();
    let timer;
  try{return await Promise.race([(async()=>{const response=await sourceFetch(url,{...options,redirect:'manual',signal:controller.signal});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>5*1024*1024)throw Error('来源响应超过5MiB读取边界');
    return {url,status:response.status,readAt:now().toISOString(),rawHash:hash(bytes),bytes};})(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error(`工行公开请求超时（${sourceTimeoutMs}ms）`));},sourceTimeoutMs);})]);}finally{clearTimeout(timer);}
 }
 async function json(path,params){
    application.assertSourceRequestAllowed(sourceId);
    return reuseRunResource('icbc-json',[root+path,params],async()=>{const response=await request(root+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({public:{call_app:'F-TRM'},private:params})});
    const raw=response.bytes.toString('utf8');
    const evidence={...response,bytes:undefined,raw,requestParameters:params};
    if(activeRun){activeRun.lastResponse=evidence;
    save(activeRun);}if(response.status!==200)throw Error(`工行来源HTTP ${response.status}：${path}`);
    let data;try{data=JSON.parse(raw);}catch{throw Error('工行来源JSON解析失败');}if(String(data.retCode)!=='0')throw Error(`工行来源查询失败：${path}`);
    return {...evidence,data:data.data};});}
 return {
  getIcbcCoverage(){const coverage=application.getSourceCoverageHistory(sourceId),records=coverage.history;
    return {sourceId,implemented:true,scope:'公开社会招聘全部列表与公告目录；仅选中详情、关联公告、原始附件及登录后投递路径；附件条件依实际读取及唯一行对应核验',latest:coverage.latest,lastSuccessfulAt:coverage.lastSuccessfulAt,history:records,historyPage:coverage.historyPage};},
  async checkIcbcSource({postIds=[defaultPostId],pageSize=10,listOnly=false,trigger='manual',scheduledFor=null}={}){
   if(!['manual','scheduled'].includes(trigger)||(trigger==='scheduled'&&(typeof scheduledFor!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor)||!Number.isFinite(Date.parse(scheduledFor)))))throw new ValidationError('来源计划检查需有效触发方式及含时区的计划时刻');
   if(!Array.isArray(postIds)||(!postIds.length&&!listOnly)||postIds.length>20||postIds.some(id=>typeof id!=='string'||!/^\d{20}$/.test(id))||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ValidationError('工行岗位需1—20个20位ID，分页尺寸1—100');
   if(checking)throw new ValidationError('工行来源检查正在进行，请勿重叠运行');
    checking=true;
   const run={id:randomUUID(),sourceId,checkedAt:now().toISOString(),trigger,scheduledFor,selectedPostIds:[...new Set(postIds)],status:'checking',stage:'official_chain',officialChain:[],pages:[],listCount:0,listComplete:false,catalogPages:[],catalogCount:0,catalogComplete:false,details:[],announcements:[],attachmentsChecked:0,jobIds:[],gaps:[],businessGaps:[],unknowns:[],error:null};
    activeRun=run;
    save(run);
   try{
    for(const url of [origin+'/',origin+'/pc/index.html']){const response=await request(url);
    run.officialChain.push({...response,bytes:undefined,raw:response.bytes.toString('utf8')});
    save(run);
    if(response.status!==200)throw Error('工行官方入口未取得');}
    const script=run.officialChain.at(-1).raw.match(/\/icbc\/trmo\/d\/pc\/umi\.[a-f0-9]+\.js/);
    if(!script)throw Error('工行官方页面结构变化');
    const bundle=await request(origin+script[0]);
    run.officialChain.push({...bundle,bytes:undefined,raw:bundle.bytes.toString('utf8')});
    save(run);
    if(bundle.status!==200||!bundle.bytes.includes(Buffer.from('/main/social/postDetail/:postId'))||!bundle.bytes.includes(Buffer.from('R00302')))throw Error('工行社招公开页面契约变化');
    const layoutHash=bundle.bytes.toString('utf8').match(/2:"([a-f0-9]{8})"/)?.[1];
    if(!layoutHash)throw Error('工行公开岗位组件地址未确认');
    const layout=await request(origin+'/icbc/trmo/d/pc/p__main___layout.'+layoutHash+'.async.js');
    const layoutText=layout.bytes.toString('utf8');run.officialChain.push({...layout,bytes:undefined,raw:layoutText});
    const button=layoutText.match(/"1"==this\.state\.applyState[\s\S]{0,250}?"0"==this\.state\.applyState[\s\S]{0,250}?disabled:!0[\s\S]{0,80}?postDetail\.disabled/);
    if(layout.status!==200||!button)throw Error('工行公开投递按钮状态规则未确认');
    run.buttonRule={url:layout.url,text:button[0],openStates:['0','1'],otherStates:'disabled',label:'已截止',readAt:layout.readAt,rawHash:layout.rawHash};save(run);
    async function listing(path,key,kind,pages,countKey,completeKey){let total=null;
    const rows=[];
    for(let page=1;page<=(total===null?1:Math.ceil(total/pageSize));page++){const response=await json(path,{page,pageSize,[key]:'R00302',...(kind==='post'?{struIds:''}:{})});run[pages].push(response);
    save(run);
    const data=response.data;
    if(!data||!Number.isInteger(data.total)||data.total<0||data.total>10000||!Array.isArray(data.dataList)||data.dataList.length>pageSize||(total!==null&&data.total!==total)||data.dataList.some(item=>item[kind==='post'?'recruitType':'projectType']!=='R00302'||!/^\d{20}$/.test(item[kind==='post'?'postId':'announId'])))throw Error('工行社会招聘分页结构、总数或类型无效');
    total=data.total;
    rows.push(...data.dataList);run[countKey]=rows.length;
    save(run);}
     if(rows.length!==total||new Set(rows.map(item=>item[kind==='post'?'postId':'announId'])).size!==total)throw Error('工行社招分页数量不符或跨页重复');run[completeKey]=true;
    save(run);
    return rows;}
    run.stage='list';
    const posts=await listing('/post/qryPostList','recruitType','post','pages','listCount','listComplete');
    run.stage='catalog';
    const catalogue=await listing('/announ/qryAnnounList','projectType','notice','catalogPages','catalogCount','catalogComplete');
    for(const postId of run.selectedPostIds){if(!application.isSourceSelectionAllowed(sourceId,postId))continue;
     const listed=posts.find(x=>x.postId===postId);
    if(!listed){run.businessGaps.push(`选中岗位${postId}未在完整社招列表；不据此关闭或删除旧岗位`);continue;}
     run.stage='detail';
    (run.detailAttempts??=[]).push({externalId:postId,at:now().toISOString()});save(run);
    const response=await json('/post/qryPostById',{postId});
    run.details.push(response);
    save(run);
    const detail=response.data;
    if(!detail||detail.postId!==postId||detail.recruitType!=='R00302'||detail.publishPostName!==listed.publishPostName||detail.belongsStruName!==listed.belongsStruName)throw Error('工行岗位详情身份、类型或所属机构不一致');
    response.decodedHtml=decoded(detail.postDepict);
    const body=plain(response.decodedHtml);
    if(!body.trim())throw Error('工行岗位正文未取得');
    response.requirementsInDetail=body.includes('任职要求');
     const ended=typeof detail.enterEndTime==='string'&&Number.isFinite(Date.parse(detail.enterEndTime.replace(' ','T')+'+08:00'))&&Date.parse(detail.enterEndTime.replace(' ','T')+'+08:00')<=now().getTime();
     const current=!ended&&['0','1'].includes(String(detail.applyState));
     if(trigger==='scheduled'||isAutomatic?.()){
      const fit=targetLocation({location:{options:[detail.placeStr]}}),direction=jobRelevance({title:detail.publishPostName,duties:body});
      const reason=ended?'明确报名期限已过，不自动加工':fit.status==='excluded'?fit.reason:direction.status==='out_of_scope'?direction.reason:null;
      if(reason){response.externalId=postId;response.processingStatus='scope_excluded';response.processingSkipped=reason;(run.skippedSelections??=[]).push({externalId:postId,title:detail.publishPostName,processingSkipped:reason});save(run);continue;}
     }
     const related=await json('/announ/qryAnnounListByPostId',{postId});
    response.relatedAnnouncements=related;
    save(run);
    if(!Array.isArray(related.data)||!related.data.length)throw Error('选中工行岗位未取得关联社招公告');
    const contents=[],attachments=[];
    let unit=null;
     for(const linked of related.data){if(!catalogue.some(x=>x.announId===linked.announId)||linked.projectType!=='R00302')throw Error('岗位关联公告不属于本次社招目录');
    run.stage='announcement';
    const announcement=await json('/announ/qryAnnounById',{announId:linked.announId});
    run.announcements.push(announcement);
    save(run);
    const notice=announcement.data;
    if(notice?.announId!==linked.announId||notice.projectType!=='R00302'||notice.struName!==linked.struName)throw Error('工行关联公告身份不一致');announcement.decodedHtml=decoded(notice.content);
    const text=plain(announcement.decodedHtml);
    const found=text.match(/一[、.]\s*招聘机构\s*\n([^\n]+)/)?.[1]?.trim();
    if(!found)throw Error('工行招聘机构未从公告正文确认');
    if(unit&&unit!==found)throw Error('工行关联公告招聘机构矛盾');
    unit=found;
    contents.push(`关联公告：${notice.title}\n${text}`);announcement.attachments=[];
      for(let i=1;i<=5;i++){if(!notice['attachId'+i])continue;
    run.stage='attachment';
    const url=notice['attachAddr'+i],name=notice['attachName'+i];
    const safe=new URL(url);
    if(safe.origin!==origin||!/^\/api\/v1\/chunkserver\/TRM-default\/_\/[^/]+\.(xls|xlsx|pdf|docx)$/i.test(safe.pathname)||safe.search||safe.hash)throw Error('工行附件地址越界');
    application.assertSourceRequestAllowed(sourceId);
    // An HTTP failure belongs to this URL for the whole check, not each role.
    // The resource scope ends with the check so the next cycle retries afresh.
    const file=await reuseRunResource('public-attachment',url,()=>request(url));
    const evidence={...file,bytes:undefined,name,contentBase64:file.bytes.toString('base64')};announcement.attachments.push(evidence);
    save(run);
    if(file.status!==200){run.gaps.push(`${name}：附件未取得（HTTP ${file.status}）`);
    attachments.push({name});continue;}run.attachmentsChecked++;
    const types={xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
    attachments.push({name,mediaType:types[url.split('.').at(-1).toLowerCase()],contentBase64:evidence.contentBase64});}
     }
     const path=origin+'/pc/index.html#/main/social/postDetail/'+postId;
    const recruitmentStatus=ended?'historical_closed':current?'publicly_listed_open':'unverified';
    if(!ended&&!current)run.businessGaps.push(`岗位${postId}当前投递状态待核验，不标开放`);
     const dateEvidence=[{field:'enterBeginTime',raw:detail.enterBeginTime,meaning:'explicit_registration_start'},{field:'enterEndTime',raw:detail.enterEndTime,meaning:'explicit_deadline'}].filter(x=>typeof x.raw==='string');
     const target={title:detail.publishPostName,recruitmentUnit:unit,department:null,batch:null};
     const identity={...target,sourceIdentity:{sourceId,externalId:postId,stableCode:postId},observedAt:run.checkedAt,refreshedAt:detail.publishTime??null,dateEvidence,recruitmentStatus,sourceEvidence:{sourceId,postId,listed:true,recruitType:'R00302',applyState:detail.applyState,belongsStruName:detail.belongsStruName,projectId:detail.projectId??null,batchId:detail.batchId??null,applicationUrl:path,announcementIds:related.data.map(item=>item.announId),announcementUrls:related.data.map(item=>origin+'/pc/index.html#/main/social/announDetail/'+item.announId),checkedAt:run.checkedAt,attachmentConditionsComplete:attachments.length===0}};
     const originalText=`工行社会招聘选中具体岗位\n岗位：${target.title}\n招聘单位：${unit}\n所属机构（平台字段）：${detail.belongsStruName}\n部门及批次：未单独核验\n公开地点：${detail.placeStr}\n${body}\n${contents.join('\n\n')}\n岗位详情与投递入口：${path}\n投递步骤：注册并登录官方招聘站，在该岗位详情点击投递，依官方流程填写简历并申请。\n报名截止时间（官方页面标签enterEndTime）：${detail.enterEndTime}\n报名起始时间（官方页面enterBeginTime）：${detail.enterBeginTime}\n签约主体未披露。`;
     const contentHash=hash(JSON.stringify({target,text:originalText.replace(/\s+/g,' '),readerVersion:attachmentPython?'xls-row-scope-v1':'unconfigured',attachments:attachments.map(x=>({name:x.name,sha:x.contentBase64?hash(Buffer.from(x.contentBase64,'base64')):null})),current}));
    const cached=db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId,postId,sourceProcessingKey(contentHash));
    let announcement=cached?application.getAnnouncement(cached.announcement_id):null;
    run.stage='processing';
     if(!announcement){announcement=await application.createAnnouncement({title:target.title,sourceUrl:path,originalText,evidenceUse:ended?'historical':'current',attachments,jobIdentities:[identity],targetJobs:[target]});db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId,postId,sourceProcessingKey(contentHash),announcement.id);}
     if(trigger==='scheduled'||isAutomatic?.()) {
      application.recordAnnouncementProcessingObservation(announcement.id,{sourceUrl:path,title:target.title,checkedAt:run.checkedAt,applicationOpen:current,locations:[detail.placeStr]});
      const screened=application.screenAnnouncementForAutomaticProcessing(announcement.id);
      if(screened.status==='scope_excluded'){response.externalId=postId;response.announcementId=screened.id;response.processingStatus=screened.status;response.processingSkipped=screened.processingSkipped;save(run);continue;}
     }
     const documentScopes=[];
     const normalizeCell=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
     for(const attachment of announcement.attachments.filter(item=>item.status==='read'&&item.mediaType==='application/vnd.ms-excel')){
      run.stage='attachment_scoping';
      const headers=attachment.segments.filter(segment=>segment.cells?.some(cell=>['岗位名称','招聘岗位'].includes(cell.text)));
      const matches=[];const common=[];
      for(const header of headers){
       const sheet=header.locator.split('/row:')[0],titleColumn=header.cells.find(cell=>['岗位名称','招聘岗位'].includes(cell.text)).address.replace(/\d+$/,''),placeColumn=header.cells.find(cell=>cell.text==='工作地点')?.address.replace(/\d+$/,'');
       const rows=attachment.segments.filter(segment=>segment.locator.startsWith(sheet+'/row:'));const headerIndex=rows.indexOf(header);
       for(let index=0;index<rows.length;index++){const segment=rows[index],title=segment.cells.find(cell=>cell.address.replace(/\d+$/,'')===titleColumn)?.text,place=segment.cells.find(cell=>cell.address.replace(/\d+$/,'')===placeColumn)?.text;
        if(index<=headerIndex||!title)common.push(segment.locator);
        else if((normalizeCell(title)===normalizeCell(target.title)&&(!placeColumn||(place&&normalizeCell(detail.placeStr).includes(normalizeCell(place)))))||(normalizeCell(title)===normalizeCell(target.title.split('-').at(-1))&&placeColumn&&place&&normalizeCell(detail.placeStr).includes(normalizeCell(place))))matches.push(segment.locator);
       }
      }
      if(matches.length!==1)throw Error('工行附件岗位名称及地点无法唯一对应；原表保留，不套用其他行条件');
      documentScopes.push({documentId:attachment.id,locators:attachment.segments.filter(segment=>[...common,...matches].includes(segment.locator)).map(segment=>segment.locator)});
     }
     run.stage='processing';
     announcement=application.recordAnnouncementProcessingObservation(announcement.id,{sourceUrl:path,title:target.title,checkedAt:run.checkedAt,applicationOpen:current,locations:[detail.placeStr]});
     announcement=await application.processAnnouncement(announcement.id,documentScopes.length?{documentScopes}:{});
     response.externalId=postId;response.announcementId=announcement.id;
     if(announcement.status==='scope_excluded'){response.processingStatus=announcement.status;response.processingSkipped=announcement.processingSkipped;save(run);continue;}
     if(['deferred','scope_pending'].includes(announcement.status)){response.processingStatus=announcement.status;response.processingDecision=announcement.sourceProcessingDecision;run.businessGaps.push(announcement.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));save(run);continue;}
    if(announcement.status==='failed')throw Error(`工行岗位加工失败：${announcement.error}`);
    if(announcement.jobIds.length!==1)throw Error('工行选中岗位加工未得到唯一具体岗位');
     const unread=announcement.attachments.filter(item=>item.status!=='read');identity.sourceEvidence.attachmentConditionsComplete=unread.length===0;
    for(const id of announcement.jobIds){const job=application.getSourceJob(id);
    if(!job.sourceIdentities?.some(x=>x.sourceId===sourceId&&x.externalId===postId))throw Error('工行加工岗位来源身份未关联');
    const modelDates=announcement.extraction.jobs[0].dateEvidence??[];
    const verifiedDates=[...modelDates.filter(date=>!dateEvidence.some(source=>source.field===date.field)),...dateEvidence.map(date=>({...date,evidence:modelDates.find(model=>model.field===date.field)?.evidence??[],sourceUrl:path}))];
    const updated=application.importJob({...job,...identity,dateEvidence:verifiedDates,evidenceUse:ended?'historical':'current'});
    run.jobIds.push(updated.job.id);}
     if(!response.requirementsInDetail&&(!announcement.attachments.length||unread.length))run.gaps.push(`岗位${postId}详情未列独立任职要求且附件未完整读取，条件覆盖未确认`);
     const readerGaps=new Set(unread.map(item=>`${item.name}：${item.error??'附件未取得'}`));
     for(const gap of announcement.gaps)(readerGaps.has(gap)?run.gaps:run.unknowns).push(gap);
     // Source coverage excludes ordinary undisclosed business fields; job-level unknowns stay intact.

     if(unread.length)run.failureCategory='attachment';
    save(run);
    }
    run.gaps=[...new Set(run.gaps)];
    run.status=run.gaps.length?'partial':'success';
    run.stage=run.gaps.length?'coverage':'completed';
   }catch(error){run.status='failed';
    run.error=error.message;run.failureCategory=run.stage.startsWith('attachment')?'attachment':run.stage==='processing'?'processing':run.stage==='detail'||run.stage==='announcement'?'detail':run.stage==='list'||run.stage==='catalog'?'pagination':'acquisition';}
   finally{run.finishedAt=now().toISOString();
    save(run);
    checking=false;
    activeRun=null;
    const posts=run.pages.flatMap(page=>page.data?.dataList??[]);
    const acquired=run.listComplete===true;
    for(const job of application.listJobs())for(const identity of job.sourceIdentities??[]){if(identity.sourceId!==sourceId)continue;
     const detail=run.details.find(item=>item.data?.postId===identity.externalId&&item.decodedHtml),data=detail?.data;
     const rawStart=data?.enterBeginTime;
     const normalizedStart=typeof rawStart==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawStart)&&Number.isFinite(Date.parse(rawStart.replace(' ','T')+'+08:00'))?rawStart.replace(' ','T')+'+08:00':null;
     const rawDeadline=data?.enterEndTime;
     const normalizedDeadline=typeof rawDeadline==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawDeadline)&&Number.isFinite(Date.parse(rawDeadline.replace(' ','T')+'+08:00'))?rawDeadline.replace(' ','T')+'+08:00':null;
     const text=`来源检查：${run.id}\n${run.pages.map(page=>page.raw).join('\n')}\n${detail?.raw??''}\n公开投递按钮原文：${run.buttonRule?.text??'未取得'}\n平台北京时间规范化：${normalizedDeadline??'未确认'} ${normalizedStart??'未确认'}\n${run.error??''}`;
     const evidence={url:detail?.url??run.pages[0]?.url??origin+'/',text,quote:run.id,locator:'完整公开社招分页／岗位详情／官方按钮规则'};
     application.recordRecruitmentObservation(job.id,{id:run.id+':'+job.id+':'+identity.externalId,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:acquired?'success':'failed',listComplete:acquired,listed:acquired?posts.some(post=>post.postId===identity.externalId):null,detailAccessible:detail?true:null,applicationOpen:detail&&run.buttonRule?run.buttonRule.openStates.includes(String(data.applyState)):null,evidence,sourceCheckId:run.id,error:run.error,start:normalizedStart?{raw:normalizedStart,sourceRaw:rawStart,evidence:{...evidence,quote:normalizedStart,locator:'详情enterBeginTime北京时间规范化（保留sourceRaw）'}}:undefined,deadline:normalizedDeadline?{raw:normalizedDeadline,sourceRaw:rawDeadline,evidence:{...evidence,quote:normalizedDeadline,locator:'详情enterEndTime北京时间规范化（保留sourceRaw）'}}:undefined});
    }
    application.recordSourceCheck(run);}
   return structuredClone(run);
  },
 };
}
