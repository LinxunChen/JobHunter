import {AsyncLocalStorage} from 'node:async_hooks';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';

// The async context distinguishes a cycle's own adapter calls from another HTTP request.
export function createSourceCheckLock({db,ValidationError}) {
 const context=new AsyncLocalStorage();
 const held=()=>{const row=db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle');return row?JSON.parse(row.body):null;};
 return {
  withSourceCheckOwner(owner,work){return context.run(owner,work);},
  acquireSourceCheckLock() {
   db.exec('BEGIN IMMEDIATE');let owner;
   try {
    const lock=held();
    if(lock&&processingOwnerAlive(lock.owner)!==false) {
     if(lock.owner.id!==context.getStore()?.id)throw new ValidationError('后台正在检查，请查看现有检查进度');
     db.exec('COMMIT');return {owner:lock.owner,borrowed:true};
    }
    owner=beginProcessingOwner();db.prepare('INSERT INTO scheduled_lock VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('cycle',JSON.stringify({owner,runId:null}));db.exec('COMMIT');return {owner,borrowed:false};
   }catch(error){db.exec('ROLLBACK');endProcessingOwner(owner);throw error;}
  },
  releaseSourceCheckLock(lease) {
   if(lease.borrowed)return;
   try{if(held()?.owner?.id===lease.owner.id)db.prepare('DELETE FROM scheduled_lock WHERE id=?').run('cycle');}finally{endProcessingOwner(lease.owner);}
  },
 };
}
