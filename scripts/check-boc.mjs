import { resolve } from 'node:path';
import { createApplication } from '../src/application.mjs';

const app = createApplication({ databasePath: resolve(process.env.JOBHUNTER_DB ?? '.data/job-hunter.sqlite'), attachmentPython: process.env.JOBHUNTER_ATTACHMENT_PYTHON });
try {
  const run = await app.checkBocSource({ postIds: process.argv.slice(2) });
  console.log(JSON.stringify({ id: run.id, status: run.status, checkedAt: run.checkedAt, catalogPages: run.catalogPages.length, catalogCount: run.catalogCount, catalogComplete: run.catalogComplete, platformPages: run.platformPages.length, platformCount: run.platformJobs.length, platformListComplete: run.platformListComplete, selectedAnnouncements: run.announcements.length, selectedApplicationPaths: run.applicationPaths.length, currentOpportunityConfirmedCount: run.currentOpportunityConfirmedCount, jobIds: run.jobIds, gaps: run.gaps, error: run.error }, null, 2));
  if (run.status !== 'success') process.exitCode = 1;
} finally { app.close(); }
