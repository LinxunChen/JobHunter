import {sourceProcessingKey} from './local-settings.mjs';
import {randomUUID,createHash,randomInt,createPublicKey,publicEncrypt,constants} from 'node:crypto';
import {execFile} from 'node:child_process';
const origin='https://job.10086.cn';
const queryPaths=new Map([['/job-app/company/getCompanyList.do','getCompanyList'],['/job-app/job/searchJobs.do','searchJobs'],['/job-app/job/viewJob.do','viewJob']]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/?(?:p|div|li|tr)\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').trim();
const md5=value=>createHash('md5').update(value).digest('hex');
const pad=(value,size)=>String(value).padStart(size,'0').slice(-size);

// Anonymous public recruitment reads only. No cookies, login, captcha, resume or application API.
async function publicCurl(url,options={}){
  const parsed=new URL(url),path=parsed.pathname;
  const download=path==='/job-app/commonService/downloadFile.do'&&/^\?fileId=[A-Za-z0-9_-]{1,128}$/.test(parsed.search);
  const detailPage=path==='/personal/job/detail.html'&&/^\?id=[A-Za-z0-9_-]{1,128}$/.test(parsed.search);
  const query=queryPaths.has(path),staticPage=['/personal/job/index.html','/js/job-center.js','/js/job-module.js'].includes(path);
  if(parsed.origin!==origin||parsed.username||parsed.password||parsed.hash||(parsed.search&&!detailPage&&!download)||(!query&&!staticPage&&!detailPage&&!download)||(query?options.method!=='POST':options.method&&options.method!=='GET'))throw Error('研究院公开读取路径或方法越界');
  const args=['--noproxy','*','--silent','--show-error','--connect-timeout','15','--max-time','40','--max-filesize',String(5*1024*1024),'--write-out','\n%{http_code}',url];
  if(query)args.push('--request','POST','--header','Content-Type: application/json','--data-binary','@-');
  return new Promise((resolve,reject)=>{
    const child=execFile('/usr/bin/curl',args,{encoding:null,maxBuffer:5*1024*1024+1024,timeout:45000,signal:options.signal},(error,stdout)=>{
      if(error)return reject(Error(`研究院公开读取失败（curl exit=${error.code??'unknown'}），未降低证书检查`));
      const status=Number(stdout.subarray(-3).toString());if(!Number.isInteger(status)||status<100||status>599)return reject(Error('研究院公开读取无有效HTTP状态'));
      resolve(new Response(stdout.subarray(0,-4),{status}));
    });child.stdin.on('error',()=>{});child.stdin.end(query?options.body:undefined);
  });
}
function publicEnvelope(serviceName,data,script){
  const key=script.match(/prototype\.pbkey="([A-Za-z0-9+/=]+)"/)?.[1],alphabet=script.match(/function getSecret\(\)[\s\S]*?var gs_str = '([A-Za-z0-9]+)'/)?.[1];
  if(!key||!alphabet||alphabet.length<10||!script.includes('curtime + secret'))throw Error('公开匿名签名契约变化');
  const timestamp=Date.now(),nonce=Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join('');
  const publicKey=createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'});
  const digest=Buffer.from(md5(timestamp+nonce)).toString('base64')+';'+publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(nonce)).toString('base64');
  const date=new Date(timestamp),suffix=pad(parseInt(md5(timestamp+',https://job.10086.cn/personal/job/index.html,Netscape,5.0,JobHunter-public-read').slice(25,32),16),6);
  const conversationId=pad(date.getFullYear(),4)+pad(date.getMonth()+1,2)+pad(date.getDate(),2)+pad(date.getHours(),2)+pad(date.getMinutes(),2)+pad(date.getSeconds(),2)+pad(date.getMilliseconds(),3)+suffix;
  return {serviceName,header:{version:'1.0',timestamp,digest,conversationId},data};
}
export function createCmriOperations({db,now,application,cmriFetch=publicCurl,sourceTimeoutMs=45000,ValidationError=Error,definition=null}){
  const sourceId=definition?.id??'cmri-social',companyId=definition?.companyId??97,companyShortName=definition?.companyShortName??'研究院',companyType=definition?.companyType??4;
  const unitPattern=new RegExp(definition?.unitPattern??'研究院'),expectedCompany=definition?.name??'中国移动通信有限公司研究院';
  const scope=`集团官网companyId${companyId}／${companyShortName}／type2社会招聘，全部公开列表分页，选中详情与申请入口；不同主体不合并`;
  db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,body TEXT NOT NULL,checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL,external_id TEXT NOT NULL,content_hash TEXT NOT NULL,announcement_id TEXT NOT NULL,PRIMARY KEY(source_id,external_id,content_hash))');
  application.registerSource({id:sourceId,name:definition?.name??'中国移动研究院官方社招',kind:'recruitment',monitoringObjectIds:definition?.objects??['seed-23'],scope});
  const save=run=>db.prepare('INSERT INTO source_checks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,sourceId,JSON.stringify(run),run.checkedAt);
  const history=()=>db.prepare('SELECT body FROM source_checks WHERE source_id=? ORDER BY rowid DESC').all(sourceId).map(row=>JSON.parse(row.body));
  let checking=false;
  async function request(run,url,options={}){
    application.assertSourceRequestAllowed(sourceId);
    const controller=new AbortController();let timer;
    try{
      const {response,bytes}=await Promise.race([(async()=>{const response=await cmriFetch(url,{...options,redirect:'manual',signal:controller.signal});const bytes=Buffer.from(await response.arrayBuffer());return {response,bytes};})(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error(`研究院公开请求超时（${sourceTimeoutMs}ms）`));},sourceTimeoutMs);})]);
      if(bytes.length>5*1024*1024)throw Error('研究院响应超过5MiB读取边界');
      const evidence={url,status:response.status,readAt:now().toISOString(),raw:options.binary?undefined:bytes.toString('utf8'),...(options.binary?{contentBase64:bytes.toString('base64')}:{}),rawHash:hash(bytes)};run.lastResponse=evidence;save(run);
      if(response.status!==200&&!options.binary)throw Error(`研究院公开读取HTTP ${response.status}`);return evidence;
    }finally{clearTimeout(timer);}
  }
  async function query(run,path,data,script){
    const evidence=await request(run,origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(publicEnvelope(queryPaths.get(path),data,script))});
    evidence.requestParameters=structuredClone(data);let result;
    try{result=JSON.parse(evidence.raw);if(typeof result==='string')result=JSON.parse(result);}catch{throw Error('研究院公开响应JSON解析失败');}
    if(result?.code!=='0000')throw Error('研究院公开查询未返回成功代码');evidence.data=result.data;return evidence;
  }
  return {
    [definition?'getJiutianCoverage':'getCmriCoverage'](){return {sourceId,implemented:true,scope,...application.getSourceCoverageHistory(sourceId)};},
    async [definition?'checkExpanded_jiutian_social':'checkCmriSource']({postIds,pageSize=20,listOnly=false,trigger='manual',scheduledFor=null}={}){
      if(postIds!=null&&(!Array.isArray(postIds)||(!postIds.length&&!listOnly)||postIds.length>20||postIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))))throw new ValidationError('研究院选中岗位需1—20个公开ID');
      if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!['manual','scheduled'].includes(trigger)||(trigger==='scheduled'&&(typeof scheduledFor!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor)||!Number.isFinite(Date.parse(scheduledFor)))))throw new ValidationError('研究院分页或含时区计划时刻无效');
      if(checking)throw new ValidationError('研究院来源正在检查，请勿重叠');checking=true;
      const run={id:randomUUID(),sourceId,cmriSource:true,checkedAt:now().toISOString(),trigger,scheduledFor,status:'checking',stage:'official_chain',officialChain:[],pages:[],company:null,recruitType:'2',listCount:0,listComplete:false,details:[],selectedPostIds:postIds?[...new Set(postIds)]:null,jobIds:[],gaps:[],businessGaps:[],unknowns:[],error:null};save(run);
      try{
        const page=await request(run,origin+'/personal/job/index.html');run.officialChain.push(page);
        if(!page.raw.includes('/js/job-center.js')||!page.raw.includes('/js/job-module.js')||!page.raw.includes('javascript:type(2);')||!page.raw.includes('data["companyId"]')||!page.raw.includes('data["type"]'))throw Error('官方职位入口脚本关联变化');
        const signing=await request(run,origin+'/js/job-center.js'),dictionary=await request(run,origin+'/js/job-module.js');run.officialChain.push(signing,dictionary);
        const type=dictionary.raw.match(/var recruitTypeJson\s*=\s*(\[[\s\S]*?\]);/)?.[1];
        if(!type||!JSON.parse(type).some(item=>item.code==='02'&&item.name==='社会招聘'))throw Error('公开社会招聘分类未确认');
        run.stage='company';run.companyDirectory=await query(run,'/job-app/company/getCompanyList.do',{newJob:0},signing.raw);
        const companies=run.companyDirectory.data?.companyList;
        if(!Array.isArray(companies)||companies.filter(item=>String(item.companyId)===String(companyId)).length!==1)throw Error('研究院官方机构目录未唯一确认');
        run.company=companies.find(item=>String(item.companyId)===String(companyId));if(run.company.shortName!==companyShortName||run.company.type!==companyType)throw Error(`companyId${companyId}与${companyShortName}身份不一致`);
        run.stage='list';let total=null;const rows=[];
        for(let pageNo=1;pageNo<=(total===null?1:Math.ceil(total/pageSize));pageNo++){
          const response=await query(run,'/job-app/job/searchJobs.do',{pageNo,pageSize,key:'',workYear:'',companyId,degree:'',publishTime:'',workType:'',type:2,category:'',subCategory:'',workCity:'',workProvince:''},signing.raw);run.pages.push(response);save(run);
          const data=response.data;if(!Number.isInteger(data?.total)||data.total<0||data.total>10000||!Array.isArray(data.jobList)||data.jobList.length>pageSize||(total!==null&&data.total!==total))throw Error('研究院社招分页总数或结构无效');
          if(data.jobList.some(item=>!item||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||String(item.type)!=='2'||(item.companyId!=null?String(item.companyId)!==String(companyId):item.companyShortName!==companyShortName||item.company!==expectedCompany)))throw Error('公开列表包含未确认的社招类型或研究院身份');
          total=data.total;rows.push(...data.jobList);run.listCount=rows.length;save(run);
        }
        if(rows.length!==total||new Set(rows.map(item=>item.id)).size!==total)throw Error('研究院社招分页不完整或重复');run.listComplete=true;
        run.selectedPostIds??=rows.slice(0,20).map(item=>item.id);
        if(!postIds&&rows.length>20)run.businessGaps.push(`仅选中前20详情，另${rows.length-20}条详情及条件未核验`);
        for(const postId of run.selectedPostIds){if(!application.isSourceSelectionAllowed(sourceId,postId))continue;
          const listed=rows.find(item=>item.id===postId);if(!listed){run.businessGaps.push(`选中岗位${postId}未在完整研究院社招列表；不删除或关闭旧岗`);continue;}
          run.detailAttempts??=[];run.detailAttempts.push({externalId:postId,at:now().toISOString()});save(run);run.stage='detail';const path=origin+'/personal/job/detail.html?id='+postId,applicationPage=await request(run,path),response=await query(run,'/job-app/job/viewJob.do',{id:postId},signing.raw);response.applicationPage=applicationPage;run.details.push(response);save(run);
          const detail=response.data;
          if(!detail||detail.id!==postId||String(detail.type)!=='2'||String(detail.companyId)!==String(companyId)||detail.name!==listed.name||(listed.company&&detail.company!==listed.company)||typeof detail.company!=='string'||!unitPattern.test(detail.company))throw Error('研究院社招详情身份、主体或类型不一致');
          if(!applicationPage.raw.includes('/job-app/job/viewJob.do')||!applicationPage.raw.includes('job.status != 1')||!applicationPage.raw.includes('.jl_btn'))throw Error('公开具体投递入口及状态规则未确认');
          response.identityVerified=true;response.applicationOpen=String(detail.status)==='1';
          const target={title:detail.name,recruitmentUnit:detail.company,department:detail.department||null,batch:detail.batch||null};
          const dateEvidence=[{field:'startTime',raw:detail.startTime,meaning:'unverified'},{field:'endTime',raw:detail.endTime,meaning:'unverified'}].filter(item=>typeof item.raw==='string');
          const label=(variable,code)=>{if(code==null||code==='')return '未披露';const literal=dictionary.raw.match(new RegExp('var '+variable+'\\s*=\\s*(\\[[\\s\\S]*?\\]);'))?.[1];let values;try{values=JSON.parse(literal?.replace(/,\s*]/g,']'));}catch{}const name=values?.find(item=>String(item.code)===String(code))?.name;if(!name){run.gaps.push(`${target.title}：明确资格代码${variable}/${code}未解析`);return `代码${code}（解释未核验）`;}return name;};
          const description=plain(detail.description),requirements=plain(detail.dutyCondition),other=plain(detail.otherRequirement);
          if(!description)throw Error('研究院具体职责未取得');if(!requirements)run.gaps.push(`${target.title}：任职条件字段未取得，不能称条件完整`);
          const attachments=[];response.attachments=[];
          const links=[...String(detail.description??'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),...String(detail.dutyCondition??'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),...String(detail.otherRequirement??'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].filter(link=>link[1].includes('downloadFile.do')||/\.(?:pdf|txt|docx|xlsx|xls)(?:$|[?#])/i.test(link[1]+' '+plain(link[2])));
          if(links.length>10)throw Error('研究院公开附件超过10项读取边界');
          for(const link of links){const name=plain(link[2])||'公开条件附件',url=new URL(link[1],origin);if(response.attachments.some(item=>item.url===url.href))continue;
            if(url.origin!==origin||url.pathname!=='/job-app/commonService/downloadFile.do'||!/^\?fileId=[A-Za-z0-9_-]{1,128}$/.test(url.search)||url.username||url.password||url.hash){run.gaps.push(`${name}：附件地址未属于已核验的官方公开下载路径`);attachments.push({name});continue;}
            run.stage='attachment';let file;try{file=await request(run,url.href,{binary:true});}catch(error){run.gaps.push(`${name}：附件读取失败（${error.message}）`);attachments.push({name});continue;}response.attachments.push({...file,name});
            if(file.status!==200){run.gaps.push(`${name}：附件原件未取得（HTTP ${file.status}）`);attachments.push({name});continue;}
            const extension=name.split('.').at(-1).toLowerCase(),types={txt:'text/plain',pdf:'application/pdf',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
            attachments.push({name,mediaType:types[extension]??'application/octet-stream',contentBase64:file.contentBase64});
          }
          const originalText=`研究院社会招聘具体岗位\n岗位：${target.title}\n招聘单位：${target.recruitmentUnit}\n部门：${target.department??'未单独披露'}\n正式批次：${target.batch??'未单独披露'}\n公开地点选项：${detail.province??''} ${detail.city??''}\n岗位描述：\n${description}\n任职条件：\n${requirements}\n其他要求及公共报名条件（按原文）：\n${other}\n学历要求（公开字典）：${label('educationBgJson',detail.degree)}\n工作年限（公开字典）：${label('workExpJsons',detail.workYear)}\n平台开始时间：${detail.startTime??'未披露'}\n平台截止字段：${detail.endTime??'未披露'}（字段含义未独立核验，不生成确定倒计时）\n所属公司原字段：${detail.company}\n集团展示字段：${detail.companyName??'未披露'}\n签约主体未披露，不等同招聘单位或集团。\n投递路径：${path}\n投递步骤：注册并登录官方平台，在岗位详情完成简历并自行投递。`;
          const identity={...target,sourceIdentity:{sourceId,externalId:postId,stableCode:postId},observedAt:run.checkedAt,refreshedAt:detail.startTime??null,dateEvidence,recruitmentStatus:response.applicationOpen?'publicly_listed_open':'unverified',sourceEvidence:{sourceId,externalId:postId,companyId,recruitType:'2',listed:true,checkedAt:run.checkedAt,detailStatus:detail.status,applicationUrl:path}};
          const contentHash=hash(JSON.stringify({target,text:originalText.replace(/\s+/g,' '),attachments:attachments.map(item=>({name:item.name,hash:item.contentBase64?hash(Buffer.from(item.contentBase64,'base64')):null}))})),cached=db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId,postId,sourceProcessingKey(contentHash));
          let announcement=cached?application.getAnnouncement(cached.announcement_id):null;run.stage='processing';
          if(!announcement){announcement=await application.createAnnouncement({title:target.title,sourceUrl:path,originalText,attachments,jobIdentities:[identity],targetJobs:[target]});db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId,postId,sourceProcessingKey(contentHash),announcement.id);}
          announcement=application.recordAnnouncementProcessingObservation(announcement.id,{sourceUrl:path,title:target.title,checkedAt:run.checkedAt,applicationOpen:response.applicationOpen,locations:[detail.province??'',detail.city??'']});
          announcement=await application.processAnnouncement(announcement.id);if(announcement.status==='failed')throw Error('研究院具体岗位加工失败：'+announcement.error);
          response.externalId=postId;response.announcementId=announcement.id;
          if(announcement.status==='scope_excluded'){response.processingStatus=announcement.status;response.processingSkipped=announcement.processingSkipped;save(run);continue;}
          if(['deferred','scope_pending'].includes(announcement.status)){response.processingStatus=announcement.status;response.processingDecision=announcement.sourceProcessingDecision;run.businessGaps.push(announcement.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));save(run);continue;}
          for(const id of announcement.jobIds){const job=application.getSourceJob(id);if(!job.sourceIdentities.some(item=>item.sourceId===sourceId&&item.externalId===postId))throw Error('研究院加工结果来源身份未关联');const modelDates=announcement.extraction.jobs[0].dateEvidence??[];const result=application.importJob({...job,...identity,dateEvidence:[...dateEvidence,...modelDates.filter(item=>!dateEvidence.some(source=>source.field===item.field))]});run.jobIds.push(result.job.id);}
          const unread=announcement.attachments.filter(item=>item.status!=='read');if(unread.length){run.gaps.push(...unread.map(item=>`${item.name}：附件条件未完整读取（${item.error??'原件未取得'}）`));run.failureCategory='attachment';}run.unknowns.push(...announcement.gaps.filter(gap=>!unread.some(item=>gap.startsWith(item.name+'：'))));save(run);
        }
        run.status=run.gaps.length?'partial':'success';run.stage=run.gaps.length?(run.failureCategory==='attachment'?'attachment':'coverage'):'completed';
      }catch(error){run.status='failed';run.error=error.message;run.failureCategory=run.stage==='attachment'?'attachment':run.stage==='list'?'pagination':run.stage==='detail'?'detail':run.stage==='processing'?'processing':'acquisition';}
      finally{run.finishedAt=now().toISOString();save(run);checking=false;
        const listed=run.pages.flatMap(page=>page.data?.jobList??[]);
        for(const job of application.listJobs())for(const identity of job.sourceIdentities??[]){if(identity.sourceId!==sourceId)continue;const detail=run.details.find(item=>item.identityVerified&&item.data.id===identity.externalId);const text=`读取记录：${run.id}\n${run.pages.map(page=>page.raw).join('\n')}\n${detail?.raw??''}\n${detail?.applicationPage.raw??''}\n${run.error??''}`;application.recordRecruitmentObservation(job.id,{id:run.id+':'+job.id+':'+identity.externalId,sourceId,externalId:identity.externalId,sourceCheckId:run.id,observedAt:run.checkedAt,acquisition:run.listComplete?'success':'failed',listComplete:run.listComplete,listed:run.listComplete?listed.some(item=>item.id===identity.externalId):null,detailAccessible:detail?true:null,applicationOpen:detail?.applicationOpen??null,evidence:{url:detail?.url??run.pages[0]?.url??origin+'/personal/job/index.html',text,quote:run.id,locator:'研究院社招完整分页／唯一详情／公开按钮状态规则'},error:run.error});}
        application.recordSourceCheck(run);}
      return structuredClone(run);
    },
  };
}
