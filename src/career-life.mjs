import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {currentLocalSettings} from './local-settings.mjs';

/** Reuse only the already-running Life MCP listener. Never launch or repair it. */
export function createLifeCareerSource({ settingsPath, getSettings=currentLocalSettings, fetcher = fetch, timeoutMs = 15000 } = {}) {
  return {
    async readCareerOverview() {
      const configured=getSettings(),careerSourceId=configured.careerDocumentId,path=settingsPath??configured.careerSettingsPath;
      if(!careerSourceId||!path||!isAbsolute(path))throw new Error('尚未配置本地职业来源');
      const settings = JSON.parse(await readFile(path, 'utf8'));
      if (settings.enabled !== true || settings.host !== '127.0.0.1' || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535 || settings.authEnabled !== true || typeof settings.token !== 'string' || !settings.token) throw new Error('现有Life本机MCP配置不可用');
      const endpoint = `http://127.0.0.1:${settings.port}/mcp`;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${settings.token}` };
      let requestId = 0;
      const send = async (method, params, notification = false) => {
        const response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(timeoutMs) });
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        if (!response.ok) throw new Error('Life只读MCP会话请求未成功');
        const raw = await response.text();
        if (!raw) return null;
        let value;
        if (raw.trimStart().startsWith('{')) value = JSON.parse(raw);
        else {
          const messages = raw.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(text => JSON.parse(text));
          value = messages.find(message => message.id === requestId);
        }
        if (!value || value.error) throw new Error('Life只读MCP结果未成功');
        return value.result;
      };
      try {
        await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'job-hunter-authorized-career', version: '1' } });
        await send('notifications/initialized', null, true);
        let start = 0; let total = null; const windows = []; const contents = [];
        for (let count = 0; count < 100; count++) {
          const result = await send('tools/call', { name: 'document', arguments: { action: 'get_doc', id: careerSourceId, mode: 'markdown', blockStart: start, blockLimit: 60, tokenBudget: 12000, includeBlockIds: true } });
          const doc = result?.structuredContent;
          if (result?.isError || doc?.id !== careerSourceId || doc.blockStart !== start || !Number.isInteger(doc.returnedBlocks) || doc.returnedBlocks <= 0 || !Number.isInteger(doc.totalBlocks) || doc.totalBlocks < 1 || typeof doc.content !== 'string') throw new Error('指定职业概览窗口无效');
          if (total !== null && total !== doc.totalBlocks) throw new Error('职业概览读取中变化，请重新完整检查');
          total = doc.totalBlocks;
          windows.push({ blockStart: start, returnedBlocks: doc.returnedBlocks, totalBlocks: total, truncated: Boolean(doc.truncated), hasNextWindow: Boolean(doc.hasNextWindow) });
          contents.push(doc.content); start += doc.returnedBlocks;
          if (!doc.hasNextWindow) {
            if (doc.truncated || start !== total) throw new Error('职业概览未完整读取');
            return { id: careerSourceId, text: contents.join('\n\n'), complete: true, windows, receipt: { transport: 'existing-life-mcp-http', endpoint, documentId: careerSourceId } };
          }
          if (start >= total || doc.nextBlockStart !== start) throw new Error('职业概览后续窗口不连续');
        }
        throw new Error('职业概览分页超过本次安全读取上限');
      } finally {
        if (headers['Mcp-Session-Id']) await fetcher(endpoint, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
      }
    },
  };
}
