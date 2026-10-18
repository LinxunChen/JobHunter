import {createHash} from 'node:crypto';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';
import {qualificationFactsFromCareer} from './qualification-profile.mjs';

const fields=['education','major','birthday','certificates','experiences'];
const hash=text=>createHash('sha256').update(text.trim().replace(/\r\n/g,'\n')).digest('hex');
export function createProfileAnalysis({db,matching,qualificationProfiles,processor,now,ValidationError,verificationMode}) {
 db.exec('CREATE TABLE IF NOT EXISTS profile_analyses (id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 let closed=false;const pending=new Map(),owners=new Set();
 const stamp=()=>now().toISOString();
 const latest=()=>matching.listCareerProfiles()[0];
 const get=id=>{const row=db.prepare('SELECT body FROM profile_analyses WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
 const save=value=>{db.prepare('INSERT INTO profile_analyses VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,JSON.stringify(value));return value;};
 const validate=(output,profile)=>{
  if(!output||!output.facts||typeof output.facts!=='object'||Array.isArray(output.facts)||Object.keys(output.facts).some(key=>!fields.includes(key))||!Array.isArray(output.gaps??[])||(output.gaps??[]).some(x=>typeof x!=='string'))throw new ValidationError('资料提取结构无效');
  const facts={},sources={};
  for(const [key,value] of Object.entries(output.facts)){
   if(value==null||Array.isArray(value)&&!value.length)continue;
   const quote=output.evidence?.[key];
   if(typeof quote!=='string'||!quote.trim()||!profile.text.includes(quote))throw new ValidationError('资料事实缺少可定位原文');
   const values=key==='experiences'?Array.isArray(value)?value.flatMap(x=>[x.domain,x.startMonth,x.endMonth]):[]:Array.isArray(value)?value:[value];
   if(!values.length||values.some(x=>typeof x!=='string'||!quote.includes(x)))throw new ValidationError('提取值不在引用中，不接受推断事实');
   if(key==='birthday'&&!/出生|生日/.test(quote)||key==='education'&&quote.split(/[，。；;\n]/).some(part=>part.includes(value)&&/在读|拟取得|预计|计划|未取得|未获|尚未取得|待确认|可能|或/.test(part)))throw new ValidationError('未取得或未明确的个人事实不能作为资格');
   facts[key]=value;sources[key]={kind:'career',reference:profile.id,quote};
  }
  return {facts,sources,gaps:output.gaps??[]};
 };
 const merge=(profile,extracted)=>{
  const old=qualificationProfiles.getQualificationProfile(),facts={...old?.facts},sources={...old?.sources},conflicts=[];
  for(const key of Object.keys(sources))if(sources[key].kind==='career'){delete facts[key];delete sources[key];}
  for(const [key,value] of Object.entries(extracted.facts)){
   if(sources[key]?.kind==='user'){
    if(JSON.stringify(facts[key])!==JSON.stringify(value))conflicts.push(key);
   }else{facts[key]=value;sources[key]=extracted.sources[key];}
  }
  // Use the established validator before publishing any extracted facts.
  qualificationProfiles.saveQualificationProfile({facts,sources});
  return conflicts;
 };
 const operations={
  getProfileAnalysis(profileId=latest()?.id){const record=profileId?get(profileId):null;return record?.status==='processing'&&processingOwnerAlive(record.owner)===false?{...record,status:'interrupted',gaps:['资料分析中断，下次检查继续；原资料和历史保留']}:record;},
  enqueueProfileAnalysis(profile){
   const existing=get(profile.id);if(existing)return existing;
   const materialHash=hash(profile.text),cached=db.prepare("SELECT body FROM profile_analyses WHERE json_extract(body,'$.materialHash')=? AND json_extract(body,'$.status') IN ('completed','needs_review') ORDER BY rowid DESC LIMIT 1").get(materialHash);
   const record={id:profile.id,profileId:profile.id,materialHash,status:'pending',createdAt:stamp(),gaps:[],attempts:0};
   if(cached){const previous=JSON.parse(cached.body);try{const extracted=validate(previous.output,profile),conflicts=merge(profile,extracted);return save({...record,status:conflicts.length||extracted.gaps.length?'needs_review':'completed',output:previous.output,conflicts,finishedAt:stamp(),reusedFrom:previous.id});}catch{/* Changed formatting may invalidate literal quotes; analyze the new text. */}}
   if(!processor){
    const extracted=qualificationFactsFromCareer(profile);
    if(Object.keys(extracted.facts).length){const conflicts=merge(profile,extracted);return save({...record,status:conflicts.length?'needs_review':'completed',conflicts,finishedAt:stamp(),method:'labelled',output:{facts:extracted.facts,evidence:Object.fromEntries(Object.entries(extracted.sources).map(([key,value])=>[key,value.quote])),gaps:[]}});}
   }
   return save(record);
  },
  async analyzeProfile(profileId=latest()?.id,{retry=false}={}){
   if(verificationMode)throw new ValidationError('恢复核对模式不分析资料');
   const profile=matching.getCareerProfile(profileId);if(!profile)throw new ValidationError('职业资料不存在');
   let record;db.exec('BEGIN IMMEDIATE');
   try{
    record=get(profileId)??operations.enqueueProfileAnalysis(profile);
    if(['completed','needs_review','superseded'].includes(record.status)||record.status==='failed'&&!retry||record.status==='processing'&&processingOwnerAlive(record.owner)!==false||!processor){db.exec('COMMIT');return record;}
    record={...record,history:[...(record.history??[]),...(record.attempts?[{status:record.status==='processing'?'interrupted':record.status,startedAt:record.startedAt,finishedAt:record.finishedAt??stamp()}]:[])],owner:beginProcessingOwner(),status:'processing',startedAt:stamp(),attempts:record.attempts+1};owners.add(record.owner);save(record);db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   try{
    const result=await processor.analyze({profile});if(closed)return record;
    const output=result.output??result,extracted=validate(output,profile);
    db.exec('SAVEPOINT profile_publish');
    try{
     if(latest()?.id!==profile.id){record.status='superseded';record.gaps=['已有更新的资料版本，本次结果不替代当前事实'];}
     else {const conflicts=merge(profile,extracted);record.status=conflicts.length||extracted.gaps.length?'needs_review':'completed';record.conflicts=conflicts;record.gaps=extracted.gaps;record.output=output;}
     record.finishedAt=stamp();save(record);db.exec('RELEASE profile_publish');
    }catch(error){db.exec('ROLLBACK TO profile_publish; RELEASE profile_publish');throw error;}
   }catch(error){if(closed)return record;record.status=['budget_deferred','batch_deferred'].includes(error.receipt?.failureCategory)?'deferred':'failed';record.gaps=[record.status==='deferred'?'资料已保存，等待模型预算或连接恢复':'资料已保存，分析未完成；请重试或补充明确事实'];record.finishedAt=stamp();save(record);}
   finally{endProcessingOwner(record.owner);owners.delete(record.owner);}
   return get(profile.id);
  },
  scheduleProfileAnalysis(profileId){
   if(!processor||verificationMode||closed||pending.has(profileId))return;
   const work=new Promise(resolve=>setImmediate(resolve)).then(()=>closed?null:operations.analyzeProfile(profileId));
   pending.set(profileId,work);work.catch(()=>{}).finally(()=>pending.delete(profileId));
  },
  async waitForProfileAnalysis(){await Promise.all([...pending.values()]);return operations.getProfileAnalysis();},
  async runPendingProfileAnalyses(){
   const profile=latest();if(!profile||verificationMode)return null;
   if(pending.has(profile.id))await pending.get(profile.id);
   const record=operations.getProfileAnalysis(profile.id);
   if(!record)return null;
   const retry=record.status==='failed'&&Date.parse(record.finishedAt)+15*60000<=now().getTime();
   return operations.analyzeProfile(profile.id,{retry});
  },
  closeProfileAnalysis(){closed=true;for(const owner of owners)endProcessingOwner(owner);owners.clear();},
 };
 return operations;
}
