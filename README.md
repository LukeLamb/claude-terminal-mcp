# Terminal — Claude Desktop extension for Linux

A [Claude Desktop](https://claude.ai/download) extension that gives Claude terminal, filesystem, and background-job access on your local Linux machine.

Addresses a gap on Linux Claude Desktop where `claude_desktop_config.json`-style MCP servers aren't loaded (that mechanism is macOS/Windows only); on Linux, the only way to add tools is via installable extensions.

---

## ⚠️ Security — read this first

**Installing this extension grants Claude unrestricted shell access on your user account.** Anything your user can do from a terminal, Claude can do through this tool: read any file your user can read, modify anything they can modify, install software, open network connections, etc.

Treat installing this the same way you'd treat giving someone an SSH session to your machine. Don't install it on machines with sensitive data you wouldn't want Claude to see or on shared systems.

There is a minimal built-in safety denylist that refuses a handful of obviously-destructive one-liners (`rm -rf /`, `rm -rf ~`, fork bombs, `dd`/`mkfs` on raw disk devices, `shutdown`/`reboot`). **This is a last-resort safety net, not a sandbox.** A determined command can trivially bypass it. It exists so that a moment's inattention doesn't wipe your home directory.

To tighten the rails, edit the `DENYLIST` array at the top of [`server.js`](server.js) and rebuild. To remove them entirely, set `DENYLIST = []` and rebuild.

---

## What it does

Exposes 8 tools to Claude:

| Tool | Purpose |
|---|---|
| `run_command(command, cwd?, timeout?, env?)` | Run a shell command via `bash -lc`. Pipes, redirects, `source venv/bin/activate && …` all work. Returns stdout/stderr/exit_code. Output is capped at 100KB per stream; full transcript is always saved to a file and the path returned as `log_path`. |
| `read_file(path, offset?, limit?)` | Read a text file with optional line-range slicing. |
| `list_directory(path)` | Entries with type (file/dir), size, and mtime. |
| `write_file(path, content, overwrite?)` | Create or overwrite a text file. Parent directories are created. |
| `run_background(command, cwd?)` | Spawn a detached subprocess; returns a `job_id`. Use for long-running work you don't want to block the chat on (builds, training runs, servers). |
| `read_background(job_id, tail?)` | Status and last N lines of stdout/stderr for a background job. |
| `list_background()` | All jobs (running, exited, killed). |
| `kill_background(job_id)` | SIGTERM the job; SIGKILL after 5 seconds if it's still alive. |

Run state (transcripts, job scratch files) lives under `/tmp/claude-term-mcp/` and is wiped at reboot.

---

## Install

1. Download the latest `Terminal.mcpb` from the [Releases page](https://github.com/LukeLamb/claude-terminal-mcp/releases).
2. Open Claude Desktop → **Settings** → **Extensions**.
3. Scroll to the **Extension Developer** section at the bottom. Click **Install Extension** and pick the `Terminal.mcpb` file you downloaded.
4. Claude Desktop shows the extension details with a red "developer info not verified by Anthropic" warning. Verify you trust the source, then click **Install**.
5. At install time Claude Desktop will ask for a **Default working directory** — this is where shell commands run when Claude doesn't specify one. Pick your main projects folder, or leave empty to default to your home directory.
6. Back on **All extensions**, make sure **Terminal** is toggled on.
7. In a chat, open the connector/tools picker and enable **Terminal** for that conversation.

You can change the default working directory later from **Settings** → **Extensions** → **Terminal**.

## Requirements

- Claude Desktop ≥ 0.10.0 on Linux (also tested on macOS)
- Node.js ≥ 16 (Claude Desktop bundles a recent Node it uses to run the extension, so a system Node isn't required)
- `bash` on PATH

No `npm install` step — the extension is zero-dependency pure Node.

---

## Configuration

All configuration is done through Claude Desktop's UI at install time or under **Settings** → **Extensions** → **Terminal**.

| Field | Type | Purpose |
|---|---|---|
| Default working directory | Directory | Where shell commands run when Claude doesn't specify one. Leave blank for `$HOME`. |

To customize the denylist or other behavior, edit [`server.js`](server.js) and rebuild (see below).

---

## Known issues

**Yellow banner: "Tool result could not be submitted. The request may have expired or the connection was interrupted."** This fires on every turn that triggers Claude's dynamic tool-loading step. The 404 is on the tool-search result submission to the Anthropic backend, not on the MCP tool itself — your tool call runs and returns correctly immediately after the banner. It's cosmetic. Same issue also hits the stock Filesystem extension. Likely a client↔backend protocol mismatch that will be fixed in a future Claude Desktop release.

---

## Build from source

```bash
git clone https://github.com/LukeLamb/claude-terminal-mcp
cd claude-terminal-mcp

# Edit whatever you want in server.js / manifest.json.
# If you change the tool surface, update both places.

# Bump the version in manifest.json so Claude Desktop treats the install as an update.

# Build the bundle:
zip -j Terminal.mcpb manifest.json package.json server.js

# Then install Terminal.mcpb via Claude Desktop → Settings → Extensions → Install Extension.
```

## Uninstall

**Settings** → **Extensions** → **All extensions** → **Terminal** → **Remove**.

## Privacy policy

**No data leaves your machine.** This extension runs entirely locally:

- **Data collection:** None. The extension does not phone home, emit telemetry, or make any network requests of its own. All network calls you observe will be ones *you* ask Claude to run (e.g. `curl`, `wget`, `git push`).
- **Data usage & storage:** Command transcripts (stdin excluded, stdout + stderr + exit code) are written to `/tmp/claude-term-mcp/runs/<timestamp>.log` so Claude can reference them later in the same conversation. Background job state (command, pid, stdout/stderr log files, exit code, status) is written to `/tmp/claude-term-mcp/jobs/<job-id>/`.
- **Third-party sharing:** None. Nothing is ever transmitted to Anthropic, to the extension author, or to any third party by this extension. (Claude Desktop itself separately sends tool inputs/outputs to Anthropic as part of the normal chat flow — that's Anthropic's relationship with you, not this extension's.)
- **Retention:** `/tmp/claude-term-mcp/` is cleared at every reboot. To clear it manually: `rm -rf /tmp/claude-term-mcp`.
- **Permissions scope:** Commands run with your own user's permissions — the same as if you typed them into a terminal.
- **Contact / questions:** Open an issue at <https://github.com/LukeLamb/claude-terminal-mcp/issues>.

## License

[MIT](LICENSE). Use freely, attribution appreciated, no warranty.
