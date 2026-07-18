# Grok Deck

**Grok Deck** is a Codex-style **desktop command center** for the official Grok coding agent.

It is not a re-implementation of the agent brain. Instead it is a GUI shell that:

1. Signs you in with the **same SuperGrok / X Premium+ OAuth** as the Grok CLI (`~/.grok/auth.json`)
2. Spawns `grok agent stdio` (Agent Client Protocol)
3. Streams chat, thoughts, tool calls, plans, and permission prompts in a desktop UI

> No `XAI_API_KEY` / console.x.ai API billing required when you use OAuth — usage follows your Grok CLI account subscription.

## Prerequisites

- **Node.js 20+**
- **Grok CLI** installed and on `PATH`  
  https://x.ai/cli  
  Windows: `irm https://x.ai/cli/install.ps1 | iex`
- An active **SuperGrok** or eligible **X Premium+** account (same as CLI)

## Quick start

```bash
cd "Grok Agent App"
npm install
npm run dev
```

If Electron fails to launch on Windows (`Electron failed to install correctly`), run:

```bash
node scripts/fix-electron.mjs
npm start
```

1. Click **Sign in with Grok** (runs `grok login --oauth`, browser flow — same SuperGrok session as CLI)
2. **Open project** → pick a folder
3. Describe a coding task and press **Ctrl+Enter**

### Production-ish local run

```bash
npm run build
npm start
```

## Architecture

```
┌──────────────────────────┐
│  Grok Deck (Electron)    │  React UI — chat, tools, permissions, diffs
│  Main process            │  IPC · folder dialogs · fs path jail · auth
└────────────┬─────────────┘
             │ ACP JSON-RPC over stdio
             │  · session/prompt, session/request_permission
             │  · fs/read_text_file, fs/write_text_file  ← required for edits
┌────────────▼─────────────┐
│  grok agent stdio        │  Official agent: tools, sessions, MCP, sandbox
│  ~/.grok/auth.json       │  OAuth tokens (shared with CLI)
└──────────────────────────┘
```

### Why file writes need client handlers

If the desktop client advertises `fs.writeTextFile: true`, Grok **calls back** into the client with `fs/write_text_file`. Rejecting that method is what made edits fail. Grok Deck implements read/write with:

- workspace **path jail** (project root only)
- **Normal** mode: approval banner + diff preview before write
- **Plan** mode: writes blocked
- **Always-approve** (`Shift+Tab` / `Ctrl+O`): auto-allow

### CLI-parity modes (Shift+Tab)

| Mode | CLI equivalent | Behavior |
|---|---|---|
| Normal | default | Ask before file writes |
| Plan | Plan mode | Plan only — no writes |
| Always-approve | Ctrl+O / YOLO | Auto-approve tools & edits |

| Package | Role |
|---|---|
| `apps/desktop` | Electron + React UI |
| `packages/acp-client` | `grok agent stdio` JSON-RPC client |
| `packages/shared` | Shared types / IPC channel names |

## Why this approach?

Building a full coding agent from scratch (file tools, shell, permissions, skills, git, …) duplicates what the Grok CLI already does well. Grok Deck focuses on the **Codex App experience**:

- Project / session workspace
- Streaming conversation
- Tool call cards
- Human-in-the-loop approvals
- Settings & recent projects

…while keeping **OAuth + agent runtime** on the official CLI.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Electron in development |
| `npm run build` | Production build |
| `npm run start` | Preview production build |

## Settings

### Windows installer / portable EXE

```bash
npm run dist
```

Outputs (under `apps/desktop/release/`):

| File | Description |
|---|---|
| `GrokDeck-0.3.0-Setup.exe` | NSIS installer (choose install folder, shortcuts) |
| `GrokDeck-0.3.0-portable.exe` | Portable — no install, just run |
| `win-unpacked/Grok Deck.exe` | Unpacked app folder |

Requires **Grok CLI** on PATH (`grok`) for the agent backend.

### Config directory

User data is stored in **`~/.grokdeck/`** (Windows: `C:\Users\<you>\.grokdeck\`):

- `settings.json` — model, theme, window size, panel widths
- `project.json` — last/recent projects
- `themes/` — custom wallpapers
- `ghost/` — undo history

Legacy `~/.grok-deck` is migrated automatically on first launch.

Stored settings example (`settings.json`):

- `model` — e.g. `grok-build`
- `grokPath` — path to `grok` if not on PATH
- `alwaysApprove` — pass `--always-approve` to the agent (use carefully)

## Roadmap

- Diff review panel (via `x.ai/git/diffs` + `x.ai/session` notifications)
- Multi-thread sidebar / session resume from `~/.grok/sessions`
- Worktree-aware parallel agents
- Skills / MCP manager UI
- Optional Computer Use surface

## License

Private / personal project unless stated otherwise.
