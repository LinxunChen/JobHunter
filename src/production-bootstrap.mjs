import {createProfileProcessor} from './profile-codex.mjs';
import {existsSync,openSync,closeSync,fstatSync,lstatSync,readFileSync,constants} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {createApplication} from './application.mjs';
import {createPushplusTransport} from './pushplus.mjs';
import {createCodexProcessor} from './codex.mjs';
import {createMatchingProcessor} from './matching-codex.mjs';
import {createSourceTaskLauncher} from './source-task-launcher.mjs';

const desktopCodex='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const productionCodexCommand=process.env.JOBHUNTER_CODEX_COMMAND??(existsSync(desktopCodex)?desktopCodex:(process.env.PATH??'').split(':').map(path=>join(path,'codex')).find(path=>isAbsolute(path)&&existsSync(path))??desktopCodex);

function notificationConfiguration(path) {
  let descriptor;
  try {
    let metadata;try{metadata=lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const directory=lstatSync(dirname(path)),owner=process.getuid?.();
    if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)||(owner!=null&&directory.uid!==owner)||!metadata.isFile()||metadata.isSymbolicLink())throw Error();
    descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    metadata=fstatSync(descriptor);
    if(!metadata.isFile()||(metadata.mode&0o077)||metadata.nlink!==1||(owner!=null&&metadata.uid!==owner)||metadata.size>16384)throw Error();
    const config=JSON.parse(readFileSync(descriptor,'utf8'));
    if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['enabled','queryEnabled','token','accessKey'].includes(key))||typeof config.enabled!=='boolean'||(config.queryEnabled!=null&&typeof config.queryEnabled!=='boolean')||(config.token!=null&&typeof config.token!=='string')||(config.accessKey!=null&&typeof config.accessKey!=='string')||(config.enabled&&!config.token?.trim())||(config.queryEnabled&&(!config.enabled||!config.accessKey?.trim())))throw Error();
    return config;
  }catch{throw new Error('JobHunter通知配置不可用；发送未启用');}
  finally{if(descriptor!=null)closeSync(descriptor);}
}

/** Explicit production entry only; ordinary application/test callers never load secrets. */
export function createProductionApplication({databasePath,credentialPath=join(dirname(databasePath),'credentials/pushplus.json'),codexCommand=productionCodexCommand,pushplusRequest,notificationsEnabled=true,backgroundSourceChecks=true,expandedSources=process.env.JOBHUNTER_EXPANDED_SOURCES==='1',...options}) {
  if(!isAbsolute(codexCommand))throw new Error('生产Codex入口需要明确绝对路径');
  let notificationTransport=null;
  if(notificationsEnabled&&!options.verificationMode&&!existsSync(join(dirname(databasePath),'restore-verification.json'))) {
    const configuration=notificationConfiguration(credentialPath);
    if(configuration)notificationTransport=createPushplusTransport({...configuration,request:pushplusRequest});
  }
  return createApplication({...options,expandedSources,databasePath,notificationTransport,sourceCheckLauncher:options.sourceCheckLauncher??(backgroundSourceChecks?createSourceTaskLauncher({databasePath}):null),
    announcementProcessor:options.announcementProcessor===undefined?createCodexProcessor({workingRoot:dirname(databasePath),command:codexCommand}):options.announcementProcessor,
    profileProcessor:options.profileProcessor===undefined?createProfileProcessor({workingRoot:dirname(databasePath),command:codexCommand}):options.profileProcessor,
    matchingProcessor:options.matchingProcessor===undefined?createMatchingProcessor({workingRoot:dirname(databasePath),command:codexCommand}):options.matchingProcessor});
}
