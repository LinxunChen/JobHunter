import {targetScopeKey,matchesTargetScope} from './local-settings.mjs';
import {beijingDay} from './beijing-time.mjs';
import {jobRelevance,targetLocation,recruitmentFit} from './job-relevance.mjs';
import {discoveryScope,discoveryDeadline,discoveryReviewPolicy,discoveryEvidenceText,discoveryRoleBlocks} from './discovery-scope.mjs';

export const processingScopeVersion='beijing-technical-social-v2';
export function announcementSource(item) {
 const identity=item.jobIdentities?.find(x=>x.sourceIdentity?.sourceId);
 return identity?{sourceId:identity.sourceIdentity.sourceId,externalId:identity.sourceIdentity.externalId}:{sourceId:item.sourceIdentityContext?.sourceId,externalId:item.sourceIdentityContext?.externalId??item.sourceUrl};
}
export function roleDuties(text) {
 return text.match(/(?:工作职责|岗位职责|职位职责|职责描述|岗位描述|职责)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:任职条件|任职资格|任职要求|应聘条件|岗位要求|岗位需求|职位要求)\s*[:：]?|$)/)?.[1]??'';
}
function directionBlocks(text) {
 const headings=[...text.matchAll(/^[ \t]*[（(][一二三四五六七八九十\d]+[）)][ \t]*([^\n]+方向)[ \t]*[:：]?[ \t]*$/gm)];
 return headings.map((x,i)=>({title:x[1].trim(),text:text.slice(x.index,headings[i+1]?.index??text.length)}));
}
function withDutyScope(decision,text) {
 if(decision.status!=='eligible')return decision;
 const sections=directionBlocks(roleDuties(text));
 if(sections.length<2)return decision;
 const selected=sections.filter(x=>jobRelevance({title:x.title,duties:x.text}).status==='relevant').map(x=>x.title);
 if(!selected.length)return {...decision,status:'needs_material',reason:'混合职责中尚无明确目标方向分支；保留原文，不调用模型'};
 const conditions=roleConditions(text),conditionBlocks=directionBlocks(conditions);
 if(conditionBlocks.length>1&&!conditionBlocks.some(x=>selected.includes(x.title)))return {...decision,status:'needs_material',reason:'混合资格分支无法与目标职责方向精确对应；保留原件，不猜测条件归属'};
 return {...decision,selectedDutySections:selected};
}
function roleConditions(text) {
 return text.match(/(?:任职条件|任职资格|任职要求|应聘条件|岗位要求|岗位需求|职位要求)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:报名截止|报名时间|投递入口|网申期限|官方详情原始日期)|$)/)?.[1]??'';
}
export function processingDocuments(documents,decision) {
 if(!decision?.selectedDutySections?.length)return documents;
 return documents.map(document=>{
  if(document.id!=='announcement')return document;
  const duties=roleDuties(document.text),sections=directionBlocks(duties);
  if(sections.length<2)return document;
  const first=sections[0].text,common=duties.slice(0,duties.indexOf(first));
  const selected=sections.filter(x=>decision.selectedDutySections.includes(x.title)).map(x=>x.text).join('\n');
  let text=document.text.replace(duties,common+selected);
  const conditions=roleConditions(text),shared=conditions.search(/^(?:通用条件|公共条件|共同条件)\s*[:：]/m),local=shared<0?conditions:conditions.slice(0,shared),conditionBlocks=directionBlocks(local);
  if(conditionBlocks.length>1){
   const prefix=local.slice(0,local.indexOf(conditionBlocks[0].text));
   text=text.replace(conditions,prefix+conditionBlocks.filter(x=>decision.selectedDutySections.includes(x.title)).map(x=>x.text).join('\n')+(shared<0?'':conditions.slice(shared)));
  }
  // Conditions outside the duties field remain intact; no guessed condition
  // ownership, source quotes are validated again against the full original.
  return {...document,text,segments:[{locator:'正文',text}]};
 });
}
export function processingScope(item,at) {
 const source=announcementSource(item);if(!source.sourceId)return null;
 const observation=item.processingObservation;
 const text=discoveryEvidenceText(item),title=item.targetJobs?.[0]?.title??item.jobIdentities?.[0]?.title??item.title;
 const result=(status,reason,extra={})=>({status,reason,version:processingScopeVersion,targetScopeKey:targetScopeKey(),checkedAt:new Date(at).toISOString(),...extra});
 const mixed=!item.jobIdentities?.length&&!item.targetJobs?.length&&discoveryRoleBlocks(text).roles.length>1;
 if(item.evidenceUse==='historical')return result('excluded','历史招聘原文保留，不自动加工');
 if(recruitmentFit({title}).status==='out_of_scope')return result('excluded','不属于所选招聘类型');
 const direction=jobRelevance({title,duties:roleDuties(item.originalText)});
 if(direction.status==='out_of_scope'&&!mixed)return result('excluded',direction.reason);
 const prior=item.sourceProcessingDecision;
 const known=prior&&matchesTargetScope(prior.targetScopeKey)?prior:null;
 const deadline=discoveryDeadline(text,at,{publishedAt:item.publishedAt});
 if(deadline.status==='expired')return result('excluded','明确报名期限已过，不自动加工',{deadline});
 // Only explicitly labelled work locations, never an employer address.
 const location=item.originalText.match(/^[ \t]*(?:工作地点|工作地址|地点公开选项|公开地点选项|公开地点|地点)\s*[:：]\s*([^\r\n]+)$/m)?.[1];
 const fit=targetLocation({location:{options:observation?.locations??(location?[location.trim()]:[])}});
 if(fit.status==='excluded'&&(!mixed||observation?.locations))return result('excluded',fit.reason);
 if(observation?.applicationOpen===false)return result('excluded','最新官方详情确认申请关闭，不自动加工');
 if(known?.selectedTitles?.length&&known.status==='eligible'&&(item.attachments??[]).every(x=>x.status==='read'&&!x.ocrNeedsReview)&&(deadline.status==='open_window'||known.deadline?.day>=beijingDay(at)))return withDutyScope(result('eligible',known.reason,{...known,version:processingScopeVersion,targetScopeKey:targetScopeKey(),checkedAt:new Date(at).toISOString()}),item.originalText);
 if(!item.jobIdentities?.length&&!item.targetJobs?.length) {
  const listDate=item.sourceIdentityContext?.dateEvidence?.find(x=>x.field==='listDate')?.raw;
  const broad=discoveryReviewPolicy({decision:discoveryScope({text,title,at,publication:item.publishedAt?{at:item.publishedAt}:undefined,attachments:(item.attachments??[]).map(x=>({...x,contentBase64:x.status==='read'}))}),text,title,listDate,at});
  return withDutyScope(result(broad.status,broad.reason,{...broad,...(broad.status==='needs_material'&&known?.manualActions?{manualActions:known.manualActions}:{})}),item.originalText);
 }
 const dates=(item.jobIdentities??[]).flatMap(x=>x.dateEvidence??[]).filter(x=>x.meaning==='explicit_deadline').map(x=>x.raw?.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)?.slice(1,4)).filter(x=>x&&Number(x[0])<2500).map(([y,m,d])=>y+'-'+m.padStart(2,'0')+'-'+d.padStart(2,'0'));
 if(dates.length&&dates.every(x=>x<beijingDay(at)))return result('excluded','官方岗位截止已过，不自动加工');
 const starts=(item.jobIdentities??[]).flatMap(x=>x.dateEvidence??[]).filter(x=>x.meaning==='explicit_registration_start').map(x=>x.raw?.slice(0,10));
 const storedOpen=(item.jobIdentities??[]).some(x=>x.sourceEvidence?.applicationOpen===true||x.sourceEvidence?.canDelivery===true&&x.recruitmentStatus==='publicly_listed_open'||x.recruitmentStatus==='publicly_listed_open'&&x.sourceEvidence?.applyState!=null)||deadline.status==='open_window'||dates.length===1&&dates[0]>=beijingDay(at);
 const open=typeof observation?.applicationOpen==='boolean'?observation.applicationOpen:storedOpen;
 const gaps=[fit.status!=='included'?'目标工作地点未确认':null,direction.status!=='relevant'?'目标职责未确认':null,!open?'当前报名开放未确认':null,starts.some(x=>x>beijingDay(at))?'报名尚未开始':null,(item.attachments??[]).some(x=>x.status!=='read'||x.ocrNeedsReview)?'必要附件未完整可靠读取':null].filter(Boolean);
 if(gaps.length)return result('needs_material',gaps.join('；')+'；保留原文，不调用模型',{reviewPolicy:'weekly',missing:gaps});
 return withDutyScope(result('eligible','已确认目标工作地点、目标方向和当前报名开放',{selectedTitles:[title]}),item.originalText);
}
