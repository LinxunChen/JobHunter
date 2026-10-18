import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const active=new Set();
const identities=new Map();
function processStartedAt(pid) {
 const cached=identities.get(pid);if(cached&&Date.now()-cached.at<100)return cached.value;
 try {
  const raw=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:200,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C',TZ:'UTC'}}).trim();
  const value=Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():null;identities.set(pid,{value,at:Date.now()});return value;
 }catch{return null;}
}
let ownStartedAt;
export function beginProcessingOwner(){ownStartedAt??=processStartedAt(process.pid);const owner={pid:process.pid,id:randomUUID(),processStartedAt:ownStartedAt};active.add(owner.id);return owner;}
export function endProcessingOwner(owner){if(owner)active.delete(owner.id);}
// Unknown legacy ownership is never treated as proof of a dead process.
export function processingOwnerAlive(owner){
 if(!Number.isInteger(owner?.pid)||typeof owner.id!=='string')return null;
 if(owner.pid===process.pid)return active.has(owner.id);
 try{process.kill(owner.pid,0);}catch(error){return error.code==='ESRCH'?false:null;}
 if(owner.processStartedAt) {
  const current=processStartedAt(owner.pid);if(!current||!Number.isFinite(Date.parse(owner.processStartedAt)))return null;
  return current===owner.processStartedAt;
 }
 return true;
}
