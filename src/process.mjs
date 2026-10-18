import { spawn } from 'node:child_process';

/** Bounded local process, no shell; timeout includes any child retries. */
export function runProcess(command, args, { input = '', cwd, timeoutMs = 180000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure, killTimer;
    const terminate = message => {
      failure ??= new Error(message);
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    };
    const timer = setTimeout(() => terminate('本地加工进程超时'), timeoutMs);
    const collect = stream => chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) return terminate('本地加工输出超出限制');
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) {
        // Keep partial streams in memory for the caller's safe diagnostic summary, not in JSON/errors.
        Object.defineProperty(failure,'processResult',{value:{code,signal,stdout,stderr}});
        return reject(failure);
      }
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
