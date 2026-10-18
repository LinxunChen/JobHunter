import {resolve} from 'node:path';
import {migrateHistoryIndexes} from './history-store.mjs';

const databasePath=resolve(process.argv[2]??process.env.JOBHUNTER_DB??'.data/job-hunter.sqlite');
console.log(JSON.stringify(await migrateHistoryIndexes({databasePath,rebuild:process.argv.includes('--rebuild'),onProgress:progress=>console.log(JSON.stringify(progress))})));
