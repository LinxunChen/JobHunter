import { resolve } from 'node:path';
import { createApplication } from '../src/application.mjs';

const app = createApplication({ databasePath: resolve(process.env.JOBHUNTER_DB ?? '.data/job-hunter.sqlite') });
try {
  const run = await app.checkCcbSource({ postIds: process.argv.slice(2), announcementIds: (process.env.JOBHUNTER_CCB_ANNOUNCEMENT_IDS ?? '').split(',').filter(Boolean) });
  console.log(JSON.stringify({ id: run.id, status: run.status, checkedAt: run.checkedAt, listCount: run.listCount, pages: run.pages.length, listComplete: run.listComplete, selectedDetails: run.details.length, publicAnnouncements: run.announcements.length, jobIds: run.jobIds, gaps: run.gaps, error: run.error }, null, 2));
  if (run.status !== 'success') process.exitCode = 1;
} finally { app.close(); }
