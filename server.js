#!/usr/bin/env node
// Terminal MCP server for Claude Desktop on Linux.
// Pure Node, no npm deps. Implements JSON-RPC over newline-delimited JSON on stdin/stdout.
// https://github.com/LukeLamb/claude-terminal-mcp — MIT License.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// ─── Config (from CLI args, then env, then fallback) ──────────────────────
function parseArgv() {
  const out = { defaultCwd: '' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--default-cwd' && i + 1 < a.length) {
      out.defaultCwd = a[++i];
    }
  }
  return out;
}

const ARGS = parseArgv();
const DEFAULT_CWD = (() => {
  const candidate = ARGS.defaultCwd && ARGS.defaultCwd.trim();
  if (candidate) {
    if (candidate === '~') return os.homedir();
    if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2));
    return candidate;
  }
  return os.homedir();
})();
const RUNS_ROOT = '/tmp/claude-term-mcp/runs';
const JOBS_ROOT = '/tmp/claude-term-mcp/jobs';
const OUTPUT_CAP = 100_000;

// ─── Safety denylist ──────────────────────────────────────────────────────
// Minimal last-resort patterns. NOT a sandbox — just blocks a few obvious
// footguns. Edit freely; users who want full unrestricted shell can set this
// to [].
const DENYLIST = [
  { re: /(^|[\s;&|])rm\s+-[rfRF]{1,3}\s+\/(\s|$|--no-preserve-root)/, why: "'rm -rf /' wipes the filesystem" },
  { re: /(^|[\s;&|])rm\s+-[rfRF]{1,3}\s+(~|\$HOME)(\s|$|\/)/, why: "'rm -rf ~' wipes your home directory" },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bdd\s+[^|;&]*?\bof=\/dev\/(sd|nvme|mmcblk|hd|vd)[a-z0-9]/, why: "'dd' writing to a raw disk device" },
  { re: /\bmkfs(\.[a-z0-9]+)?\s+\/dev\/(sd|nvme|mmcblk|hd|vd)[a-z0-9]/, why: "'mkfs' on a raw disk device" },
  { re: /(^|[\s;&|])(shutdown|poweroff|halt|reboot)\b/, why: 'system power/reboot command' },
];

function checkDenylist(command) {
  for (const rule of DENYLIST) {
    if (rule.re.test(command)) return rule.why;
  }
  return null;
}

function log(...args) {
  try {
    process.stderr.write('[terminal-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}

function expandUser(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveCwd(cwd) {
  if (!cwd) return DEFAULT_CWD;
  return expandUser(cwd);
}

function truncate(buf) {
  if (buf.length <= OUTPUT_CAP) return { text: buf.toString('utf8'), truncated: false };
  return { text: buf.subarray(0, OUTPUT_CAP).toString('utf8'), truncated: true };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function runCommand(args) {
  return new Promise((resolve) => {
    const command = args.command;
    const workdir = resolveCwd(args.cwd);
    const timeoutMs = (args.timeout ?? 120) * 1000;
    const extraEnv = args.env || {};

    const refusal = checkDenylist(command);
    if (refusal) {
      resolve(errorResult(
        `Command refused by built-in safety denylist (${refusal}). ` +
        `If you believe this is a false positive, ask the user to edit server.js and remove the matching DENYLIST entry.`
      ));
      return;
    }

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let timedOut = false;

    const child = spawn('bash', ['-lc', command], {
      cwd: workdir,
      env: { ...process.env, ...Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [k, String(v)])) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (d) => { stdoutBuf = Buffer.concat([stdoutBuf, d]); });
    child.stderr.on('data', (d) => { stderrBuf = Buffer.concat([stderrBuf, d]); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(errorResult(`spawn failed: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const stdoutTrunc = truncate(stdoutBuf);
      const stderrTrunc = truncate(stderrBuf);
      if (timedOut) stderrTrunc.text += `\n[timeout after ${args.timeout ?? 120}s]`;

      let logPath = null;
      try {
        fs.mkdirSync(RUNS_ROOT, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        logPath = path.join(RUNS_ROOT, `${ts}-${process.pid}.log`);
        fs.writeFileSync(
          logPath,
          `=== COMMAND ===\n${command}\n=== CWD: ${workdir} ===\n=== STDOUT ===\n${stdoutBuf.toString('utf8')}\n=== STDERR ===\n${stderrBuf.toString('utf8')}`
        );
      } catch (e) {
        log('failed to save run log:', e.message);
      }

      resolve(textResult({
        exit_code: timedOut ? -1 : code,
        stdout: stdoutTrunc.text,
        stderr: stderrTrunc.text,
        stdout_truncated: stdoutTrunc.truncated,
        stderr_truncated: stderrTrunc.truncated,
        timed_out: timedOut,
        cwd: workdir,
        log_path: logPath,
      }));
    });
  });
}

function readFileTool(args) {
  const p = expandUser(args.path);
  if (!fs.existsSync(p)) return errorResult(`no such file: ${p}`);
  const st = fs.statSync(p);
  if (!st.isFile()) return errorResult(`not a regular file: ${p}`);

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 2000;
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  const total = lines.length;
  const end = Math.min(offset + limit, total);
  const selected = lines.slice(offset, end).join('\n');

  return textResult({
    path: p,
    content: selected,
    start_line: offset,
    end_line: end,
    total_lines: total,
    truncated: end < total,
  });
}

function listDirectory(args) {
  const p = expandUser(args.path);
  if (!fs.existsSync(p)) return errorResult(`no such directory: ${p}`);
  const st = fs.statSync(p);
  if (!st.isDirectory()) return errorResult(`not a directory: ${p}`);

  const names = fs.readdirSync(p);
  const entries = names.map((name) => {
    const full = path.join(p, name);
    try {
      const s = fs.statSync(full);
      return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs / 1000 };
    } catch (e) {
      return { name, error: e.message };
    }
  });
  entries.sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1;
    const db = b.type === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
  return textResult({ path: p, entries });
}

function writeFileTool(args) {
  const p = expandUser(args.path);
  const overwrite = args.overwrite ?? true;
  if (fs.existsSync(p) && !overwrite) return errorResult(`refusing to overwrite (overwrite=false): ${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, args.content, 'utf8');
  return textResult({ path: p, bytes_written: Buffer.byteLength(args.content, 'utf8') });
}

function jobDir(id) { return path.join(JOBS_ROOT, id); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function refreshJobStatus(id) {
  const d = jobDir(id);
  const statusFile = path.join(d, 'status');
  if (!fs.existsSync(statusFile)) return;
  const status = fs.readFileSync(statusFile, 'utf8').trim();
  if (status !== 'running') return;
  const pidFile = path.join(d, 'pid');
  if (!fs.existsSync(pidFile)) return;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isNaN(pid) || pidAlive(pid)) return;
  fs.writeFileSync(statusFile, 'exited');
  const endedFile = path.join(d, 'ended_at');
  if (!fs.existsSync(endedFile)) fs.writeFileSync(endedFile, String(Date.now() / 1000));
  const exitFile = path.join(d, 'exit_code');
  if (!fs.existsSync(exitFile)) fs.writeFileSync(exitFile, '-1');
}

function runBackground(args) {
  const command = args.command;
  const refusal = checkDenylist(command);
  if (refusal) {
    return errorResult(
      `Command refused by built-in safety denylist (${refusal}). ` +
      `If you believe this is a false positive, ask the user to edit server.js and remove the matching DENYLIST entry.`
    );
  }
  const workdir = resolveCwd(args.cwd);
  fs.mkdirSync(JOBS_ROOT, { recursive: true });
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const d = jobDir(id);
  fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(d, 'cmd.txt'), command);
  fs.writeFileSync(path.join(d, 'cwd.txt'), workdir);
  fs.writeFileSync(path.join(d, 'started_at'), String(Date.now() / 1000));
  fs.writeFileSync(path.join(d, 'status'), 'running');

  const stdoutFd = fs.openSync(path.join(d, 'stdout.log'), 'w');
  const stderrFd = fs.openSync(path.join(d, 'stderr.log'), 'w');

  const wrapper =
    `bash -lc ${JSON.stringify(command)}; ` +
    `ec=$?; ` +
    `printf "%s" "$ec" > ${JSON.stringify(path.join(d, 'exit_code'))}; ` +
    `printf "%s" "$(date +%s.%N)" > ${JSON.stringify(path.join(d, 'ended_at'))}; ` +
    `printf "%s" exited > ${JSON.stringify(path.join(d, 'status'))}`;

  const child = spawn('bash', ['-lc', wrapper], {
    cwd: workdir,
    stdio: ['ignore', stdoutFd, stderrFd],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(path.join(d, 'pid'), String(child.pid));
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return textResult({ job_id: id, cwd: workdir, command, status: 'running' });
}

function tailText(p, tail) {
  if (!fs.existsSync(p)) return '';
  const txt = fs.readFileSync(p, 'utf8');
  if (!tail || tail <= 0) return txt;
  const lines = txt.split('\n');
  return lines.slice(-tail).join('\n');
}

function readBackground(args) {
  const id = args.job_id;
  const tail = args.tail ?? 100;
  const d = jobDir(id);
  if (!fs.existsSync(d)) return errorResult(`no such job: ${id}`);
  refreshJobStatus(id);
  const readT = (fn, def = '') => {
    const p = path.join(d, fn);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : def;
  };
  const exitRaw = readT('exit_code');
  return textResult({
    job_id: id,
    status: readT('status') || 'unknown',
    exit_code: exitRaw === '' ? null : parseInt(exitRaw, 10),
    pid: parseInt(readT('pid') || '0', 10),
    command: fs.existsSync(path.join(d, 'cmd.txt')) ? fs.readFileSync(path.join(d, 'cmd.txt'), 'utf8') : '',
    cwd: fs.existsSync(path.join(d, 'cwd.txt')) ? fs.readFileSync(path.join(d, 'cwd.txt'), 'utf8') : '',
    started_at: parseFloat(readT('started_at') || '0') || null,
    ended_at: parseFloat(readT('ended_at') || '0') || null,
    stdout_tail: tailText(path.join(d, 'stdout.log'), tail),
    stderr_tail: tailText(path.join(d, 'stderr.log'), tail),
  });
}

function listBackground() {
  if (!fs.existsSync(JOBS_ROOT)) return textResult({ jobs: [] });
  const ids = fs.readdirSync(JOBS_ROOT).filter((f) => fs.statSync(path.join(JOBS_ROOT, f)).isDirectory());
  const jobs = ids.sort().map((id) => {
    refreshJobStatus(id);
    const d = jobDir(id);
    const readT = (fn, def = '') => {
      const p = path.join(d, fn);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : def;
    };
    const exitRaw = readT('exit_code');
    return {
      job_id: id,
      status: readT('status') || 'unknown',
      pid: parseInt(readT('pid') || '0', 10),
      command: fs.existsSync(path.join(d, 'cmd.txt')) ? fs.readFileSync(path.join(d, 'cmd.txt'), 'utf8') : '',
      started_at: parseFloat(readT('started_at') || '0') || null,
      ended_at: parseFloat(readT('ended_at') || '0') || null,
      exit_code: exitRaw === '' ? null : parseInt(exitRaw, 10),
    };
  });
  return textResult({ jobs });
}

async function killBackground(args) {
  const id = args.job_id;
  const d = jobDir(id);
  if (!fs.existsSync(d)) return errorResult(`no such job: ${id}`);
  refreshJobStatus(id);
  const status = fs.readFileSync(path.join(d, 'status'), 'utf8').trim();
  if (status !== 'running') return textResult({ job_id: id, status, killed: false });
  const pid = parseInt(fs.readFileSync(path.join(d, 'pid'), 'utf8').trim(), 10);
  try { process.kill(-pid, 'SIGTERM'); } catch (_) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  }
  for (let i = 0; i < 50; i++) {
    if (!pidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch (_) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }
  fs.writeFileSync(path.join(d, 'status'), 'killed');
  const endedFile = path.join(d, 'ended_at');
  if (!fs.existsSync(endedFile)) fs.writeFileSync(endedFile, String(Date.now() / 1000));
  return textResult({ job_id: id, status: 'killed', killed: true });
}

const TOOLS = [
  {
    name: 'run_command',
    description: "Run a shell command via bash -lc on the user's machine. Returns stdout/stderr/exit_code. Default cwd is the user-configured default working directory (or $HOME if unset). Output capped at 100KB per stream; full transcript saved to log_path.",
    annotations: { title: 'Run shell command', destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run. Pipes, redirects, `source venv/bin/activate && …` all work.' },
        cwd: { type: 'string', description: "Working directory. Defaults to the user-configured default working directory (or the user's home directory if unset)." },
        timeout: { type: 'number', description: 'Timeout in seconds. Default 120.' },
        env: { type: 'object', description: 'Extra environment variables to set for this command.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file with optional line-range slicing.',
    annotations: { title: 'Read file', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: '0-indexed starting line. Default 0.' },
        limit: { type: 'number', description: 'Max lines to return. Default 2000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List entries in a directory with type, size, and mtime.',
    annotations: { title: 'List directory', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file. Parent directories are created.',
    annotations: { title: 'Write file', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Default true.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_background',
    description: 'Start a long-running command in the background. Returns a job_id you can poll with read_background.',
    annotations: { title: 'Run command in background', destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, cwd: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_background',
    description: 'Read status and last N lines of stdout/stderr for a background job. tail=0 returns full logs.',
    annotations: { title: 'Read background job output', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        tail: { type: 'number', description: 'Number of trailing lines to return. Default 100.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_background',
    description: 'List all background jobs (running, exited, killed).',
    annotations: { title: 'List background jobs', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kill_background',
    description: 'Terminate a running background job (SIGTERM, then SIGKILL after 5s).',
    annotations: { title: 'Kill background job', destructiveHint: true },
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
];

const HANDLERS = {
  run_command: runCommand,
  read_file: readFileTool,
  list_directory: listDirectory,
  write_file: writeFileTool,
  run_background: runBackground,
  read_background: readBackground,
  list_background: listBackground,
  kill_background: killBackground,
};

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'terminal-mcp', version: '0.3.1' },
    });
    return;
  }

  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }

  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log('server started, pid', process.pid, 'default_cwd', DEFAULT_CWD);
