import {processingOwnerAlive} from './processing-owner.mjs';
export function createProcessingRecovery({db,application,now,verificationMode,ValidationError}){
  return {
    recoverProcessingOperations(){
      if(verificationMode)throw new ValidationError('恢复核对模式不修改加工状态');
      const recovered=[],blocked=[];
        for(const [table,kind,statuses] of [['career_refreshes','career',['processing']],['matching_results','matching',['processing']],['announcements','announcement',['processing','reading_attachments']]]){
          for(const id of application.listActiveOperationIds(table,statuses)){
            const row=db.prepare(`SELECT id,body FROM ${table} WHERE id=?`).get(id);
            const record=JSON.parse(row.body);if(!statuses.includes(record.status))continue;
            const alive=processingOwnerAlive(record.owner);
            if(alive!==false){blocked.push({kind,id:record.id,reason:alive?'所属进程仍活动，不清理加工':'旧记录缺少所属进程证据，需人工核查'});continue;}
            record.interruptedFrom=record.status;record.status='failed';record.recoveredAt=now().toISOString();record.error='所属进程已中断，原文与完成步骤保留，可继续必要加工';record.gaps=[...new Set([...(record.gaps??[]),record.error])];
            if(kind==='announcement'){record.steps.push({step:'process_interrupted',at:record.recoveredAt});if(record.interruptedFrom==='reading_attachments')record.gaps.push('附件读取中断，未完成附件需重新读取，不能称完整加工');}
            const changed=db.prepare(`UPDATE ${table} SET body=? WHERE id=? AND body=?`).run(JSON.stringify(record),record.id,row.body);if(changed.changes)recovered.push({kind,id:record.id});
          }
        }
        return {recovered,blocked};
    },
  };
}
