import { resolve } from 'node:path';
import { createApplication } from '../src/application.mjs';
const app = createApplication({ databasePath: resolve(process.env.JOBHUNTER_DB ?? '.data/job-hunter.sqlite') });
try {
  const run = await app.checkEfundsSource(process.argv.length > 2 ? { postIds: process.argv.slice(2) } : {});
  console.log(JSON.stringify({ id: run.id, status: run.status, checkedAt: run.checkedAt, pages: run.pages.length, listCount: run.listCount, listComplete: run.listComplete, details: run.details.length, attachmentsChecked: run.attachmentsChecked, jobIds: run.jobIds, gaps: run.gaps, stage: run.stage, error: run.error }, null, 2));
  if (run.status !== 'success') process.exitCode = 1;
} finally { app.close(); }
