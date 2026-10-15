import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { buildTurnPrompt, parseTurnResponse, assertSupportedGenerationOptions } from './json-turn.mjs';
const SCRIPT = fileURLToPath(new URL('./agy-sdk.py', import.meta.url));
const LIMIT = 8 * 1024 * 1024;
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'];
export function createPythonRunner({ python = process.env.RDSH_AGY_PYTHON || fileURLToPath(new URL('./.venv/bin/python', import.meta.url)), timeoutMs = 120000, spawnImpl = spawn, env = process.env } = {}) {
  return (payload, { signal, env: requestEnv } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Antigravity SDK: aborted')); return; }
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > LIMIT) { reject(new Error('Antigravity SDK: input exceeds limit')); return; }
    const childEnv = {};
    for (const source of [env, requestEnv ?? {}]) {
      for (const key of ENV_KEYS) if (typeof source[key] === 'string') childEnv[key] = source[key];
      // Windows spawn collapses case aliases; merge each source before the next.
      if (process.platform === 'win32') for (const key of PROXY_ENV_KEYS) {
        const lower = key.toLowerCase();
        const value = typeof source[key] === 'string' ? source[key] : source[lower];
        delete childEnv[lower];
        if (typeof value === 'string') childEnv[key] = value;
      }
    }
    let root;
    try { root = mkdtempSync(path.join(tmpdir(), 'rdsh-agy-bridge-')); }
    catch { reject(new Error('Antigravity SDK: temporary workspace could not be created')); return; }
    childEnv.RDSH_SDK_TMPDIR = root;
    let child, timer, output = '', size = 0, done = false, failure;
    const decoder = new StringDecoder('utf8');
    const stop = () => { try { if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, 'SIGKILL'); else child?.kill('SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch {} } };
    const finish = async (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { await rm(root, { recursive: true, force: true }); }
      catch { reject(new Error('Antigravity SDK: temporary workspace cleanup failed')); return; }
      error ? reject(error) : resolve(result);
    };
    const abort = () => { failure ??= new Error('Antigravity SDK: aborted'); stop(); };
    try { child = spawnImpl(python, ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: childEnv }); }
    catch { finish(new Error('Antigravity SDK: Python runtime could not start')); return; }
    child.stdout.on('data', data => {
      size += data.length;
      if (size > LIMIT) { failure ??= new Error('Antigravity SDK: output exceeds limit'); stop(); }
      else if (!failure) output += decoder.write(data);
    });
    child.stderr.resume(); // Deliberately discard SDK diagnostics: may include credentials.
    child.on('error', () => { failure ??= new Error('Antigravity SDK: Python runtime could not start'); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (done) return;
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new Error('Antigravity SDK: bridge process failed')); return; }
      output += decoder.end();
      let result;
      try { result = JSON.parse(output); } catch { finish(new Error('Antigravity SDK: invalid bridge response')); return; }
      const errors = new Set(['SDK_NOT_INSTALLED', 'SDK_AUTH_REQUIRED', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'INPUT_LIMIT', 'SDK_REQUEST_FAILED']);
      if (result?.error) {
        const diagnostic = result.error === 'SDK_REQUEST_FAILED' && typeof result.exceptionClass === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(result.exceptionClass) ? ` (${result.exceptionClass}${Number.isInteger(result.httpStatus) && result.httpStatus >= 400 && result.httpStatus <= 599 ? ` HTTP ${result.httpStatus}` : ''})` : '';
        finish(new Error(`Antigravity SDK: ${errors.has(result.error) ? result.error : 'SDK_REQUEST_FAILED'}${diagnostic}`)); return;
      }
      finish(null, result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { failure ??= new Error('Antigravity SDK: timed out'); stop(); }, timeoutMs);
    if (signal?.aborted) abort(); else child.stdin.end(input);
  });
}
export function createAgySdkBackend({ runner = createPythonRunner(), keyResolver } = {}) {
  return {
    async discover({ signal } = {}) {
      const result = await runner({ operation: 'discover' }, { signal });
      if (!Array.isArray(result?.models) || !result.models.length || result.models.some(m => typeof m.id !== 'string' || !m.id)) throw new Error('Antigravity SDK: invalid model catalog');
      return result.models;
    },
    async generate(options = {}) {
      options.signal?.throwIfAborted();
      assertSupportedGenerationOptions(options);
      const key = keyResolver ? await keyResolver({ signal: options.signal }) : undefined;
      if (key !== undefined && (typeof key !== 'string' || !key)) throw new Error('Antigravity SDK: invalid resolved API key');
      const runOptions = { signal: options.signal, ...(key ? { env: { GEMINI_API_KEY: key, GOOGLE_API_KEY: key } } : {}) };
      let repair;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runner({ operation: 'generate', model: options.model, prompt: buildTurnPrompt({ ...options, repair }) }, runOptions);
        if (typeof result?.text !== 'string') throw new Error('Antigravity SDK: invalid response');
        try { return parseTurnResponse(result.text, options.tools ?? []); }
        catch (error) {
          if (error?.code !== 'INVALID_JSON_TURN' || attempt === 1) throw error;
          repair = error.message;
        }
      }
    },
  };
}
