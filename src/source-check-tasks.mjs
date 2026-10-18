import {randomUUID} from 'node:crypto';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';
import {updateNecessaryJobs} from './necessary-jobs.mjs';
import {sourceCapabilities} from './source-capabilities.mjs';

export function createSourceCheckTasks({db,application,now,verificationMode,sourceCheckLauncher,ValidationError}) {
 db.exec('CREATE TABLE IF NOT EXISTS source_check_tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
 const parse=row=>row?JSON.parse(row.body):null,stamp=()=>now().toISOString(),pending=new Map();
 const save=task=>{db.prepare('INSERT INTO source_check_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id,JSON.stringify(task));return task;};
 const get=id=>parse(db.prepare('SELECT body FROM source_check_tasks WHERE id=?').get(id));
 const lock=()=>parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle'));
 const project=task=>task?.status==='running'&&processingOwnerAlive(task.owner)===false?{...task,status:'interrupted',reason:'检查进程已中断，保留已完成步骤；可重新检查当前数据'}:task;
 const execute=task=>application.withModelBatch(async()=>{
  try {
   application.recordOperationalChanges();application.recoverProcessingOperations();
   for(const id of task.sourceIds) {
    if(task.results.some(result=>result.sourceId===id))continue;
    task.currentSourceId=id;save(task);
    let result;
    try{result=await application.withSourceCheckOwner(task.owner,()=>application.runSourceCheck(id,{trigger:'manual'}));}catch(error){result={status:'failed',error:error.message};application.recordSourceCheck({id:randomUUID(),sourceId:id,status:'failed',trigger:'manual',checkedAt:stamp(),gaps:[error.message]});}
    task.results.push({sourceId:id,status:result.status,checkId:result.id??null,error:result.error??null,gaps:result.gaps??[]});save(task);
   }
   task.currentSourceId=null;task.stage='jobs';save(task);
   task.jobs=await updateNecessaryJobs(application,{sourceIds:task.sourceIds});
   task.status=task.results.some(x=>!['success','paused','unsupported_type'].includes(x.status))||!['completed'].includes(task.jobs.status)?'partial':'completed';
  }catch(error){task.status='failed';task.error=error.message;}
  finally {
   task.finishedAt=stamp();try {save(task);application.recordOperationalChanges();}
   finally {if(lock()?.owner?.id===task.owner.id)db.prepare('DELETE FROM scheduled_lock WHERE id=?').run('cycle');endProcessingOwner(task.owner);pending.delete(task.id);}
  }
  return task;
 },{automatic:true});
 const operations={
  listSourceCheckTasks({limit=20}={}){return db.prepare('SELECT body FROM source_check_tasks ORDER BY rowid DESC LIMIT ?').all(limit).map(parse).map(project);},
  getSourceCheckTask(id){return project(get(id));},
  async waitForSourceCheck(id){if(pending.has(id))await pending.get(id);return operations.getSourceCheckTask(id);},
  async executeSourceCheckTask(id) {
   if(verificationMode)throw new ValidationError('恢复核对模式不可检查');
   db.exec('BEGIN IMMEDIATE');let task,owner;
   try {
    const prior=get(id),held=lock();
    if(prior?.status!=='running'||prior.workerClaimedAt||held?.taskId!==id||held.owner.id!==prior.owner.id)throw new ValidationError('检查任务已被接管、恢复或取消，不启动外呼');
    owner=beginProcessingOwner();task={...prior,owner,workerClaimedAt:stamp()};save(task);db.prepare('UPDATE scheduled_lock SET body=? WHERE id=?').run(JSON.stringify({...held,owner}),'cycle');db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');endProcessingOwner(owner);throw error;}
   return execute(task);
  },
  resumeSourceCheck(id) {
   const prior=project(get(id));if(prior?.status!=='interrupted')throw new ValidationError('仅中断任务可以继续检查');
   return operations.startSourceCheck({sourceIds:prior.sourceIds},prior);
  },
  startSourceCheck(input={},resume=null) {
   if(verificationMode)throw new ValidationError('恢复核对模式不可检查');
   if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(key=>key!=='sourceIds')||(input.sourceIds!==undefined&&(!Array.isArray(input.sourceIds)||!input.sourceIds.length||input.sourceIds.some(id=>typeof id!=='string'||!sourceCapabilities[id]))))throw new ValidationError('检查来源参数无效');
   const available=application.getSourcesOverview().sources.filter(x=>x.implemented&&x.monitoring.enabled&&sourceCapabilities[x.id]).map(x=>x.id);
   const sourceIds=input.sourceIds?[...new Set(input.sourceIds)]:available;
   if(!sourceIds.length||sourceIds.some(id=>!available.includes(id)))throw new ValidationError('没有可检查来源，机构待接入或已暂停');
   db.exec('BEGIN IMMEDIATE');let task;
   try {
    const held=lock();
    if(held&&processingOwnerAlive(held.owner)!==false){db.exec('COMMIT');return held.taskId?operations.getSourceCheckTask(held.taskId):{status:'busy',runId:held.runId,reason:'每日检查正在进行'};}
    // Recover dead tasks only as part of an explicit operation. GET remains read-only.
    for(const old of application.listActiveOperationIds('source_check_tasks',['running']).map(id=>project(get(id))).filter(x=>x.status==='interrupted'))save({...old,finishedAt:stamp()});
    task={id:randomUUID(),owner:beginProcessingOwner(),status:'running',startedAt:stamp(),finishedAt:null,sourceIds,results:resume?[...resume.results]:[],stage:'sources',currentSourceId:null,...(resume?{resumedFrom:resume.id}:{})};
    save(task);db.prepare('INSERT INTO scheduled_lock VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('cycle',JSON.stringify({owner:task.owner,taskId:task.id,runId:null}));db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');endProcessingOwner(task?.owner);throw error;}
   const work=Promise.resolve().then(()=>sourceCheckLauncher?sourceCheckLauncher(task):execute(task));
   work.catch(()=>{
    endProcessingOwner(task.owner);
    try {const current=get(task.id),held=lock();if(current?.status==='running'&&held?.taskId===task.id&&processingOwnerAlive(current.owner)===false){save({...current,status:'interrupted',finishedAt:stamp(),reason:'检查进程中断，已完成步骤保留'});db.prepare('DELETE FROM scheduled_lock WHERE id=?').run('cycle');}}catch{/* Web may have closed; persisted ownership lets the next explicit operation recover. */}
   }).finally(()=>{endProcessingOwner(task.owner);pending.delete(task.id);});pending.set(task.id,work);return {...task};
  },
 };
 return operations;
}
