import {createHash} from 'node:crypto';
import {reuseRunResource} from './run-resources.mjs';
import { fileURLToPath } from 'node:url';
import {readImage} from './image-reader.mjs';
import { runProcess } from './process.mjs';

export function readAttachment(item,bytes,python) {
 return reuseRunResource('attachment-text',[item.mediaType,python??null,createHash('sha256').update(bytes).digest('hex')],()=>extractAttachment(item,bytes,python));
}
async function extractAttachment(item, bytes, python) {
  if(['image/jpeg','image/png','image/gif','image/webp'].includes(item.mediaType))return readImage(bytes);
  if (item.mediaType === 'text/plain' || item.mediaType === 'text/csv') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim()) throw new Error('附件未提取到文字');
    return { text, segments: [{ locator: '全文', text }] };
  }
  const kinds = { 'application/vnd.ms-excel': 'xls', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };
  const kind = kinds[item.mediaType];
  if (!kind) throw new Error('附件类型暂不支持；保留原始文件，可补录文字');
  if (!python) throw new Error('二进制附件读取需要配置JOBHUNTER_ATTACHMENT_PYTHON；原文件仍保留');
  const result = await runProcess(python, [fileURLToPath(new URL('./read-attachment.py', import.meta.url))], { input: JSON.stringify({ kind, contentBase64: bytes.toString('base64') }), timeoutMs: 15000 });
  if (result.code !== 0) throw new Error('附件读取失败；可能损坏、加密、扫描件或Python缺少读取依赖，原文件仍保留');
  return JSON.parse(result.stdout);
}
