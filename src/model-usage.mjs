import {randomUUID} from 'node:crypto';
import {beijingDay} from './beijing-time.mjs';

// Store numeric receipts only: no prompt, source text, private profile or provider errors.
export function createModelUsageOperations({db,now,ValidationError}) {
 db.exec('CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS model_budget_days (date TEXT PRIMARY KEY,calls INTEGER NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS model_budget_exceptions (date TEXT PRIMARY KEY,body TEXT NOT NULL)');
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 const policy=()=>{const date=beijingDay(now()),row=db.prepare('SELECT body FROM model_budget_exceptions WHERE date=?').get(date),limit=row?JSON.parse(row.body).limit:50;return {date,limit,temporary:Boolean(row)&&limit!==50};};
 return {
  setModelBudgetException({date,limit,reason}) {
   if(date!==beijingDay(now())||(limit!==null&&(!Number.isSafeInteger(limit)||limit<50))||typeof reason!=='string'||!reason.trim())throw new ValidationError('临时额度必须明确授权、仅限今日，并保留原因');
   const value={date,limit,reason,authorizedAt:now().toISOString()};
   db.prepare('INSERT INTO model_budget_exceptions VALUES(?,?) ON CONFLICT(date) DO UPDATE SET body=excluded.body').run(date,JSON.stringify(value));return value;
  },
  getModelBudgetStatus() {
   const {date,limit,temporary}=policy(),used=db.prepare('SELECT calls FROM model_budget_days WHERE date=?').get(date)?.calls??0;
   return {date,limit,used,remaining:limit===null?null:Math.max(0,limit-used),temporary,resetAt:new Date(Date.parse(date+'T16:00:00.000Z')).toISOString(),scope:'automatic',note:temporary?'今日按本人授权临时'+(limit===null?'放开':'提高至'+limit+'次')+'；调用仍计数，北京时间明日自动恢复50次。':'全项目自动加工、匹配与资料分析共用；实际尝试含失败，缓存复用不占次数。达到上限后原文保留，次日续办；明确手动加工不占自动额度。'};
  },
  reserveAutomaticModelCall({reservedForMatching=0}={}) {
   // One SQL statement reserves before invoking the processor, across workers and restarts.
   // An interrupted attempt keeps its reservation: never exceed the cap after a crash.
   if(!Number.isSafeInteger(reservedForMatching)||reservedForMatching<0)throw new ValidationError('匹配预留次数无效');
   const {date,limit}=policy(),availableLimit=limit===null?null:Math.max(0,limit-reservedForMatching);
   const result=db.prepare('INSERT INTO model_budget_days(date,calls) SELECT ?,1 WHERE ? IS NULL OR ?>0 ON CONFLICT(date) DO UPDATE SET calls=calls+1 WHERE ? IS NULL OR calls<? RETURNING calls').get(date,availableLimit,availableLimit,availableLimit,availableLimit);
   if(!result){const used=db.prepare('SELECT calls FROM model_budget_days WHERE date=?').get(date)?.calls??0;const error=Error(reservedForMatching&&limit>used?'剩余额度优先用于'+reservedForMatching+'个已加工岗位的匹配；新公告原文已保存，匹配后或次日继续加工':'今日自动模型调用已达'+limit+'次，原文已保存，次日继续加工');error.receipt={completed:false,failureCategory:'budget_deferred'};throw error;}
   return {at:now().toISOString(),origin:'automatic'};
  },
  recordModelAttempt({id=randomUUID(),method,receipt,at=now().toISOString(),origin='live'}) {
   if(['batch_deferred','budget_deferred'].includes(receipt?.failureCategory))return null;
   if(!['process','match','profile'].includes(method)||!Number.isFinite(Date.parse(at)))throw new ValidationError('模型用量记录无效');
   const usage=receipt?.usage,input=count(usage?.input_tokens),output=count(usage?.output_tokens);
   const record={id,at,method,origin,model:receipt?.model??null,completed:receipt?.completed===true,failureCategory:receipt?.failureCategory??null,durationMs:count(receipt?.durationMs),inputTokens:input,outputTokens:output,cachedInputTokens:input===null?null:Math.min(input,count(usage?.cached_input_tokens)??0),reasoningOutputTokens:output===null?null:Math.min(output,count(usage?.reasoning_output_tokens)??0)};
   db.prepare('INSERT OR IGNORE INTO model_usage VALUES(?,?)').run(id,JSON.stringify(record));return record;
  },
  getModelUsageSummary({since=null}={}) {
   if(since!==null&&!Number.isFinite(Date.parse(since)))throw new ValidationError('模型用量起始时间无效');
   const records=db.prepare('SELECT body FROM model_usage ORDER BY rowid').all().map(r=>JSON.parse(r.body)).filter(r=>since===null||Date.parse(r.at)>=Date.parse(since));
   const sum=field=>records.reduce((n,r)=>n+(r[field]??0),0),inputTokens=sum('inputTokens'),outputTokens=sum('outputTokens');
   return {since,calls:records.length,completedCalls:records.filter(r=>r.completed).length,failedCalls:records.filter(r=>!r.completed).length,unknownUsageCalls:records.filter(r=>r.inputTokens===null||r.outputTokens===null).length,inputTokens,cachedInputTokens:sum('cachedInputTokens'),outputTokens,reasoningOutputTokens:sum('reasoningOutputTokens'),totalTokens:inputTokens+outputTokens,firstRecordedAt:records[0]?.at??null,note:'仅计已记录调用；失败无用量回执及记录启用前的历史消耗未知。缓存包含在输入，推理包含在输出，不重复相加。'};
  },
 };
}
