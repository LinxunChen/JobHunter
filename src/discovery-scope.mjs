import {beijingDay} from './beijing-time.mjs';
import {jobRelevance,targetLocation} from './job-relevance.mjs';

// Column dates and employer addresses never establish application deadlines or
// work locations. A broad notice stays saved until these fields are explicit.
export function discoveryDeadline(text,at,{publishedAt}={}) {
 const date='(\\d{4})[年./-]\\s*(\\d{1,2})[月./-]\\s*(\\d{1,2})(?:日)?';
 const ending='截止(?:报名|时间|日期)?\\s*(?:为|至|于|是)?\\s*[:：]?\\s*(?:北京时间\\s*)?'+date;
 const window='(?:报名(?:时间|期限)|(?:简历)?投递(?:时间|期限)|申请时间|网申时间)';
 const patterns=[new RegExp('(?:报名|网申|申请|简历投递|简历接收)'+ending,'g'),new RegExp('(?:^|\\n)[ \\t•●·]*(?:[（(][一二三四五六七八九十\\d]+[）)]\\s*)?'+ending,'g'),new RegExp(window+'[\\s\\S]{0,80}?(?:至|到|[-—–])\\s*'+date,'g'),new RegExp(window+'\\s*[:：]?\\s*'+date+'[ \\t\\d:：时分点]{0,20}截止','g'),new RegExp('请于\\s*'+date+'前[^。\\n]{0,20}(?:个人资料|简历|应聘材料)[^。\\n]{0,30}发送','g')];
 const matches=patterns.flatMap(pattern=>[...text.matchAll(pattern)].map(match=>match.slice(1,4)));
 let ambiguousRange=false;
 for(const match of text.matchAll(new RegExp(window+'\\s*[:：]?\\s*(\\d{4})年\\s*(\\d{1,2})月\\s*(\\d{1,2})日[\\s\\S]{0,30}?(?:至|到|[-—–])\\s*(\\d{1,2})月\\s*(\\d{1,2})日','g'))){
  const start=Number(match[2])*100+Number(match[3]),end=Number(match[4])*100+Number(match[5]);
  if(end<start)ambiguousRange=true;else matches.push([match[1],match[4],match[5]]);
 }
 // Relative windows require this article's publisher timestamp, never the
 // directory date or acquisition time. Keep the more generous inclusive day.
 const publication=publishedAt&&Number.isFinite(Date.parse(publishedAt))?beijingDay(new Date(publishedAt)):null;
 const relative=text.match(/报名时间[^。\n]{0,60}自发布招聘公告起[^。\n]{0,40}报名时间为期(\d{1,3})天/);
 if(publication&&relative&&Number(relative[1])>0){const end=new Date(publication+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+Number(relative[1]));matches.push(end.toISOString().slice(0,10).split('-'));}
 const monthDay=text.match(/本批次简历投递截止时间(?:为|至|：|:)\s*(\d{1,2})月\s*(\d{1,2})日/);
 if(publication&&monthDay&&Number(monthDay[1])*100+Number(monthDay[2])>=Number(publication.slice(5,7))*100+Number(publication.slice(8,10)))matches.push([publication.slice(0,4),monthDay[1],monthDay[2]]);
 const receipt=text.match(/接收简历时间\s*[:：]\s*(\d{1,2})月\s*(\d{1,2})日[^。\n]{0,20}至\s*(\d{1,2})月\s*(\d{1,2})日/);
 if(publication&&receipt){const start=Number(receipt[1])*100+Number(receipt[2]),end=Number(receipt[3])*100+Number(receipt[4]);if(end>=start&&end>=Number(publication.slice(5,7))*100+Number(publication.slice(8,10)))matches.push([publication.slice(0,4),receipt[3],receipt[4]]);}
 const days=[...new Set(matches.map(([y,m,d])=>`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`))];
 const valid=!ambiguousRange&&days.length>0&&days.every(day=>Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day);
 const allExpired=valid&&days.every(day=>day<beijingDay(new Date(at)));
 return {day:valid&&days.length===1?days[0]:null,days:valid?days:[],status:allExpired?'expired':valid&&days.length===1?'open_window':'unknown',note:'仅采用正文明确报名期限；多个期限均已过可排除，其他冲突不推断开放'};
}

export function discoveryPublication(raw,url) {
 if(new URL(url).hostname!=='mp.weixin.qq.com')return null;
 const seconds=raw?.match(/\bvar\s+ct\s*=\s*["']?(\d{10})["']?\s*;/)?.[1];
 return seconds?{at:new Date(Number(seconds)*1000).toISOString(),quote:raw.match(/\bvar\s+ct\s*=\s*["']?\d{10}["']?\s*;/)[0],locator:'公众号原始HTML发布字段ct'}:null;
}

export function discoveryMiniProgramAttachments(raw='') {
 return [...raw.matchAll(/<a\b([^>]*data-miniprogram-path=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi)].flatMap(match=>{
  const name=match[2].replace(/<[^>]*>/g,'').trim();if(!/\.(?:pdf|docx?|xlsx?)$/i.test(name))return [];
  return [{name,miniProgram:match[1].match(/data-miniprogram-nickname=["']([^"']+)/)?.[1]??'微信小程序',path:match[1].match(/data-miniprogram-path=["']([^"']+)/)?.[1]?.replaceAll('&amp;','&'),action:'用手机微信打开原文，点击附件并下载原文件；公开网页没有附件下载地址，不能仅凭附件名称加工。'}];
 });
}

export function discoveryReviewPolicy({decision,text,title,listDate,at}) {
 if(decision.status!=='needs_material')return decision;
 const date=listDate&&/^\d{4}-\d{2}-\d{2}$/.test(listDate)?Date.parse(listDate+'T00:00:00Z'):NaN;
 const rolling=/持续招聘|持续进行中|长期招聘|全年招聘|滚动招聘|至岗位招聘结束止|招满为止|常年招聘|长期有效/.test(title+'\n'+text);
 const hasFutureDeadline=discoveryDeadline(text,at).status==='open_window';
 if(!rolling&&!hasFutureDeadline&&Number.isFinite(date)&&new Date(at)-date>180*86400000)return {...decision,reviewPolicy:'on_change',reason:`历史线索（栏目日期 ${listDate}），未确认当前开放；有新列示内容再检查。${decision.reason}`};
 return {...decision,reviewPolicy:'weekly'};
}
// Only explicit role labels establish separable blocks. Keep all text outside
// those blocks, including shared requirements and application instructions.
export function discoveryRoleBlocks(text) {
 const matches=[...text.matchAll(/^(?:\s*\d+[、.．]\s*)?(?:岗位名称|职位名称)\s*[:：]\s*([^\n]+)|^(?:招聘岗位|招聘职位)\s*[:：]\s*([^\n]+)/gm)];
 if(!matches.length)return {common:text,roles:[]};
 const roles=matches.map((match,i)=>({title:(match[1]??match[2]).trim(),start:match.index,end:matches[i+1]?.index??text.length}));
 const last=roles.at(-1),tail=text.slice(last.start),shared=/^(?:[ \t]*[一二三四五六七八九十\d]+[、.．）)][ \t]*)?(?:报名(?:事项|要求|程序|截止时间|时间|方式|流程)|网申截止|投递(?:简历|邮箱|方式|渠道)|应聘方式|联系方式|基本条件|通用条件|公共条件|其他事项|有关要求|工作地点|工作地址)[ \t]*[:：]?/gm;
 // A field inside the last role stays local. Only a separate section heading
 // can establish shared dates/locations; never borrow another role's fields.
 const suffix=[...tail.matchAll(shared)].find(match=>/^[ \t]*\n/.test(tail.slice(match.index+match[0].length))||/^[ \t]*[一二三四五六七八九十\d]+[、.．）)]/.test(match[0])||/报名事项|报名程序|公共条件|通用条件|联系方式|投递邮箱/.test(match[0]));
 if(suffix)last.end=last.start+suffix.index;
 return {common:[text.slice(0,roles[0].start),text.slice(last.end)].join('\n'),roles:roles.map(role=>({...role,text:text.slice(role.start,role.end)}))};
}
export function discoveryScope({text,title,at,attachments=[],publication,miniProgramAttachments=[]}) {
 const deadline=discoveryDeadline(text,at,{publishedAt:publication?.at});
 if(deadline.status==='expired')return {status:'excluded',reason:`正文报名截止 ${deadline.days.join('、')} 均已过，不调用模型`,deadline};
 if(/校园|校招|应届|优培|高校毕业生|20\d{2}届|实习生/.test(title)&&!/社会|社招/.test(title))return {status:'excluded',reason:'官方标题明确校园招聘或毕业生/实习招募，不进入社招加工',deadline};
 const blocks=discoveryRoleBlocks(text),direction=jobRelevance({title});
 if(direction.status==='out_of_scope'&&blocks.roles.length<2)return {status:'excluded',reason:'公告标题不属于目标岗位方向，保留线索，不调用模型',deadline};
 if(miniProgramAttachments.length)return {status:'needs_material',reason:'必要附件仅在微信小程序中提供：'+miniProgramAttachments.map(x=>x.name).join('、')+'；需取得原文件并确认当前仍招，不调用模型',deadline,manualActions:miniProgramAttachments};
 if(attachments.some(item=>!item.contentBase64))return {status:'needs_material',reason:'正文图片或必要附件尚未读全；保存原文，补齐文字后再判断目标岗位',deadline};
 if(attachments.some(item=>item.ocrNeedsReview))return {status:'needs_material',reason:'图片原件已读取，但部分文字置信度不足；需核对文字及当前招聘条件，不调用模型',deadline};
 if(blocks.roles.length>1){
  const commonDeadline=discoveryDeadline(blocks.common,at),commonLocation=blocks.common.match(/(?:工作地点|工作地址)\s*[:：]?\s*([^\n]+)/)?.[1];
  const decisions=blocks.roles.map(role=>{
   const own=discoveryDeadline(role.text,at),window=own.days.length||/报名时间|(?:报名|网申|申请)截止/.test(role.text)?own:commonDeadline;
   const location=role.text.match(/(?:工作地点|工作地址)\s*[:：]?\s*([^\n]+)/)?.[1]??commonLocation;
   const direction=jobRelevance({title:role.title,duties:role.text.match(/(?:岗位职责|工作职责|职责)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:任职|岗位要求|工作地点|报名)|$)/)?.[1]??''});
   const fit=targetLocation({location:{options:location?[location]:[]}});
   const status=window.status==='expired'||direction.status==='out_of_scope'||fit.status==='excluded'?'excluded':window.status==='open_window'&&direction.status==='relevant'&&fit.status==='included'?'eligible':'needs_material';
   return {title:role.title,status,deadline:window,location:location??null,reason:window.status==='expired'?'本岗报名期限已过':direction.status==='out_of_scope'?'非目标方向岗位':fit.status==='excluded'?fit.reason:window.status!=='open_window'?'本岗当前报名期限未明确':fit.status!=='included'?'本岗目标地点未明确':direction.status!=='relevant'?'本岗目标职责未明确':'当前目标岗位'};
  });
  const selectedTitles=decisions.filter(role=>role.status==='eligible').map(role=>role.title);
  return {status:selectedTitles.length?'eligible':decisions.some(role=>role.status==='needs_material')?'needs_material':'excluded',reason:selectedTitles.length?'混合公告仅加工当前目标岗位，保留公共资格与原件':'混合公告无已确认的当前目标岗位；逐岗位原因已保存',deadline,selectedTitles,roles:decisions};
 }
 if(deadline.status!=='open_window')return {status:'needs_material',reason:'正文未披露可确认的当前报名期限；保留原文，不调用模型',deadline};
 const location=text.match(/(?:工作地点|工作地址)\s*[:：]?\s*([^\n]+)/)?.[1];
 const fit=targetLocation({location:{options:location?[location]:[]}});
 if(fit.status==='excluded')return {status:'excluded',reason:fit.reason,deadline};
 if(fit.status!=='included')return {status:'needs_material',reason:'正文未明确目标工作地点；保留原文，不调用模型',deadline};
 // Multi-role notices need a concrete role scope before model processing. Keep
 // their original in full rather than feeding every business role to the model.
 const role=blocks.roles[0]?.title??title;
 const duties=text.match(/(?:工作职责|岗位职责|职位职责|职责描述)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:任职|岗位要求|工作地点|报名)|$)/)?.[1]??'';
 if(jobRelevance({title:role,duties}).status!=='relevant')return {status:'needs_material',reason:'尚无明确目标方向职责；保留原文，不调用模型',deadline};
 return {status:'eligible',reason:'正文含当前报名期限、目标工作地点和单个目标岗位',deadline,selectedTitles:[role]};
}

export function discoveryProcessingDocuments(documents,selectedTitles) {
 return documents.map(document=>{
  // Image/table attachment segments retain their original locators and all
  // qualifications; an unstructured attachment is never cut by guessed rows.
  if(document.id!=='announcement')return document;
  const blocks=discoveryRoleBlocks(document.text);
  if(blocks.roles.length<2)return document;
  const last=blocks.roles.at(-1),ambiguousTail=last.end===document.text.length&&/其他|报名|应聘人员|通用|公共|基本条件|放宽/.test(last.text);
  const text=[blocks.common,...blocks.roles.filter(role=>selectedTitles.includes(role.title)||role===last&&ambiguousTail).map(role=>role.text)].filter(Boolean).join('\n');
  // Text remains verbatim; the original documents stay saved in full.
  return {...document,text,segments:[{locator:document.id==='announcement'?'正文':'选中岗位及公共条件',text}]};
 });
}

// Low-confidence headings cannot establish what a nearby date means. Originals
// and all OCR lines remain saved, but automatic scope uses confident readings.
export const discoveryEvidenceText=announcement=>[announcement.originalText,...(announcement.attachments??[]).filter(item=>item.status==='read').map(item=>item.reader==='macOS Vision OCR'?item.segments.filter(line=>line.confidence>=.9).map(line=>line.text).join('\n'):item.text)].join('\n');
