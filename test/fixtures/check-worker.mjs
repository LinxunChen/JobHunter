import {createApplication} from '../../src/application.mjs';

const [databasePath,id]=process.argv.slice(2);
if(databasePath&&id){
let task;
const sourceFetch=async url=>{
 if(!task?.resumedFrom&&url.includes('boc.cn'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
 throw Error('受控传输：模拟来源失败，无真实外呼');
};
const app=createApplication({databasePath,sourceFetch,ccbSourceFetch:sourceFetch,icbcFetch:sourceFetch,cmriFetch:sourceFetch,sasacFetch:sourceFetch,announcementProcessor:null,matchingProcessor:null,careerSource:null,notificationTransport:{enabled:true,simulated:true,send:async()=>{throw Error('手动检查不可发送');}}});
task=app.getSourceCheckTask(id);
try {await app.executeSourceCheckTask(id);}finally{app.close();}

}
