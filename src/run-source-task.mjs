import {createProductionApplication} from './production-bootstrap.mjs';

const [databasePath,taskId]=process.argv.slice(2);
const app=createProductionApplication({databasePath,notificationsEnabled:false,backgroundSourceChecks:false});
try {await app.executeSourceCheckTask(taskId);}finally{app.close();}
