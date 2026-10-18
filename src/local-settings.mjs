import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';

const context=new AsyncLocalStorage();
export const defaultRoleKeywords=Object.freeze(['软件研发','算法','数据科学','人工智能','信息技术']);
export const defaultLocalSettings=Object.freeze({targetCities:['北京'],roleKeywords:[...defaultRoleKeywords],excludedKeywords:[],recruitmentType:'social',preferences:'',careerDocumentId:'',careerSettingsPath:''});
export const currentLocalSettings=()=>context.getStore()?.getSettings()??structuredClone(defaultLocalSettings);
export const withLocalSettings=(getSettings,work,getCompatibleTargetScopes=()=>[])=>context.run({getSettings,getCompatibleTargetScopes},work);
export const targetCityLabel=()=>currentLocalSettings().targetCities.join('、')||'不限城市';
export const usesTechnicalKeywords=(settings=currentLocalSettings())=>settings.roleKeywords.length===defaultRoleKeywords.length&&defaultRoleKeywords.every(word=>settings.roleKeywords.includes(word));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
// Keep v1 hashes when the normalized target has exactly the same meaning.
const targetScope=settings=>({targetCities:settings.targetCities,roleMode:usesTechnicalKeywords(settings)?'technical':settings.roleKeywords.length?'keywords':'all',roleKeywords:usesTechnicalKeywords(settings)?[]:settings.roleKeywords,excludedKeywords:settings.excludedKeywords,...(settings.recruitmentType!=='social'?{recruitmentType:settings.recruitmentType}:{})});
export const isDefaultTargetScope=()=>JSON.stringify(targetScope(currentLocalSettings()))===JSON.stringify(targetScope(defaultLocalSettings));
export const targetScopeKey=()=>digest(targetScope(currentLocalSettings()));
export const matchingScopeKey=()=>currentLocalSettings().preferences?digest({target:targetScopeKey(),preferences:currentLocalSettings().preferences}):targetScopeKey();
export const matchesTargetScope=key=>key?key===targetScopeKey()||(context.getStore()?.getCompatibleTargetScopes()??[]).includes(key):isDefaultTargetScope();
export const matchesMatchingScope=key=>currentLocalSettings().preferences?key===matchingScopeKey():matchesTargetScope(key);
export const sourceProcessingKey=value=>isDefaultTargetScope()?value:value+':'+targetScopeKey();

export function createLocalSettingsOperations({db,databasePath,initialSettings={},ValidationError}) {
 db.exec('CREATE TABLE IF NOT EXISTS local_settings (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_settings_scope_aliases (scope_key TEXT NOT NULL,legacy_key TEXT NOT NULL,PRIMARY KEY(scope_key,legacy_key))');
 function normalize(input,base=defaultLocalSettings) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='roleMode'&&!Object.hasOwn(defaultLocalSettings,key)))throw new ValidationError('设置字段无效');
  if(Object.hasOwn(input,'roleMode')&&!['technical','keywords','all'].includes(input.roleMode))throw new ValidationError('旧岗位方向无效');
  const {roleMode,...patch}=input;
  if(roleMode==='technical')patch.roleKeywords=[...defaultRoleKeywords];
  if(roleMode==='all')patch.roleKeywords=[];
  const value={...structuredClone(base),...patch};
  for(const key of ['targetCities','roleKeywords','excludedKeywords']){
   if(!Array.isArray(value[key])||value[key].length>50||value[key].some(x=>typeof x!=='string'||!x.trim()||x.length>100))throw new ValidationError('城市与关键词必须为有效文本列表');
   value[key]=[...new Set(value[key].map(x=>x.trim()))];
  }
  if(!['social','campus','all'].includes(value.recruitmentType))throw new ValidationError('招聘类型无效');
  for(const key of ['careerDocumentId','careerSettingsPath','preferences'])if(typeof value[key]!=='string'||value[key].length>(key==='preferences'?4000:2000))throw new ValidationError('设置文本无效');
  for(const key of ['careerDocumentId','careerSettingsPath','preferences'])value[key]=value[key].trim();
  if(value.careerDocumentId&&!/^\d{14}-[a-z0-9]{7}$/.test(value.careerDocumentId))throw new ValidationError('职业文档ID无效');
  return value;
 }
 const path=join(dirname(databasePath),'local-settings.json');let seed=initialSettings;
 if(databasePath!==':memory:'&&existsSync(path)){
  try{seed={...JSON.parse(readFileSync(path,'utf8')),...seed};}catch{throw new ValidationError('本地设置文件不可读');}
 }
 const rawSettings=()=>JSON.parse(db.prepare('SELECT body FROM local_settings WHERE id=1').get()?.body??JSON.stringify(seed));
 const registerLegacyScope=raw=>{
  if(!['technical','keywords','all'].includes(raw.roleMode)||raw.recruitmentType&&raw.recruitmentType!=='social')return;
  const normalized=normalize(raw),old={targetCities:normalized.targetCities,roleMode:raw.roleMode,roleKeywords:raw.roleKeywords??[],excludedKeywords:normalized.excludedKeywords};
  const canonical=digest(targetScope(normalized)),legacy=digest(old);
  if(canonical!==legacy)db.prepare('INSERT OR IGNORE INTO local_settings_scope_aliases VALUES(?,?)').run(canonical,legacy);
 };
 normalize(seed);registerLegacyScope(rawSettings());
 const getLocalSettings=()=>normalize(rawSettings());
 const getCompatibleTargetScopes=()=>db.prepare('SELECT legacy_key FROM local_settings_scope_aliases WHERE scope_key=?').all(digest(targetScope(getLocalSettings()))).map(row=>row.legacy_key);
 const validateLocalSettings=input=>normalize(input,getLocalSettings());
 return {getLocalSettings,getCompatibleTargetScopes,validateLocalSettings,saveLocalSettings(input){const value=validateLocalSettings(input);registerLegacyScope(rawSettings());db.prepare('INSERT INTO local_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(value));return getLocalSettings();}};
}
