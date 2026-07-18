# Grok Deck

**Grok Deck** is a Codex-style **desktop command center** for the official Grok coding agent.

It does **not** re-implement the agent brain. It is a GUI shell that:

1. Signs you in with the **same SuperGrok / X Premium+ OAuth** as the Grok CLI (`~/.grok/auth.json`)
2. Spawns `grok agent stdio` (Agent Client Protocol)
3. Streams chat, thoughts, tool calls, plans, and permission prompts in a desktop UI

> No `XAI_API_KEY` / console.x.ai API billing required when you use OAuth — usage follows your Grok CLI account subscription.

---

## Features (Grok Deck–specific)

These are what the desktop app adds on top of the CLI agent runtime.

### Chat & streaming

- **Streaming conversation** with Markdown, GFM, and syntax-highlighted code blocks
- **Thought / reasoning stream** alongside assistant text
- **Tool call chips & groups** — live status (pending → running → done/failed), inputs/outputs, file locations
- **Plan panel** — agent plan entries as they stream
- **Turn timing** — duration shown after each turn completes
- **Composer**
  - **Ctrl+Enter** to send
  - **Image / file attachments** (picker, path attach, drag & drop)
  - **`@` file mentions** — workspace file search autocomplete, attached as context
  - **`/` slash commands** — built-ins plus agent-advertised commands and **Skills** (`SKILL.md`)

### Built-in slash helpers

| Command | What it does |
|---|---|
| `/compact` | Compact conversation (save context) |
| `/context` | Show context usage |
| `/session-info` | Session metadata |
| `/always-approve` | Toggle always-approve (`on` / `off`) |
| `/new` | New session (handled in UI) |
| `/clear` | Clear chat (UI) |
| `/help` | List commands / skills |

Agent skills discovered from user / project / bundled skill roots also appear in the slash palette.

### Safety modes (CLI parity)

Cycle with **Shift+Tab**. Toggle Always-approve with **Ctrl+O**.

| Mode | Shortcut | Behavior |
|---|---|---|
| **Normal** | Shift+Tab cycle | Ask before file writes & risky tools |
| **Plan** | Shift+Tab cycle | Plan only — **project writes blocked**; session `plan.md` (`~/.grok/sessions/...`) is writable |
| **Always-approve** | Shift+Tab / **Ctrl+O** | Auto-approve tools & edits (use carefully) |

Permission requests are **queued** (not lost if several fire). Write approvals show a **diff preview** before applying.

### Ghost Git (undo agent edits)

Deck-only local history — not your project’s real git.

- After a turn that writes files, Deck snapshots **before/after** content per file
- **Undo** restores the previous snapshot (multi-level stack per project)
- **Edit summary cards** on assistant messages: which files changed and +/− line stats
- Stored under `~/.grokdeck/ghost/` (keyed by project path)

### Diff review panel (right sidebar)

- Live list of files changed in the current session
- **Unified-style preview** of pending / applied edits
- Select a path to inspect add/delete stats and content

### Sessions & projects

- Sidebar groups **threads by project** from `~/.grok/sessions` (same store as the CLI)
- **Resume** a session (loads transcript + reconnects agent session when possible)
- **Delete** a session from the list
- **Noise filter** — hide short / smoke / untitled sessions by default (toggle in Settings)
- **Open project** folder, **New task** / new project flow (**Ctrl+N**)
- Open project in **Explorer**, **PowerShell**, **CMD**, **VS Code**, or **Cursor**

### Context meter

- Token usage bar (input / output / cache when reported)
- Context limit display (defaults sensibly until the agent reports a limit)
- Last-known usage persisted under `~/.grokdeck/usage/` so it survives agent restarts

### Themes & wallpapers

| Theme | Style |
|---|---|
| **Dark** | Solid dark (no photo) |
| **Ember** | Warm ambient wallpaper |
| **Night** | Cool night wallpaper |
| **Aurora** | Soft aurora wallpaper |
| **Custom** | Your own images |

- Adjustable **wallpaper opacity** so chat stays readable
- **Import** wallpaper images into `~/.grokdeck/themes/`
- **AI Theme** tab — prompt helper + import recent Grok `/imagine` (or attachment) images as custom wallpapers
- Translucent panels when a wallpaper is active so the photo shows through

### Settings

| Setting | Notes |
|---|---|
| **Model** | e.g. `grok-4.5`, `grok-build` |
| **Reasoning effort** | `low` / `medium` / `high` (CLI `--reasoning-effort`) |
| **Grok CLI path** | If `grok` is not on `PATH` |
| **Theme / opacity** | Built-in + custom |
| **Panel widths** | Resizable left nav & right review panels |
| **Window bounds** | Size / position remembered |

User config lives in **`~/.grokdeck/`** (Windows: `C:\Users\<you>\.grokdeck\`).  
Legacy `~/.grok-deck` is migrated on first launch.

### Desktop chrome

- Resizable **three-column** layout (nav · chat · review)
- Window **edge resize handles** (frameless-friendly)
- Windows **installer** + **portable** EXE via `npm run dist`

### Security boundaries

When the client advertises `fs.writeTextFile`, Grok **calls back** into the app. Deck implements:

- Workspace **path jail** (project root only)
- Mode-aware write policy (Normal / Plan / Always-approve)
- Approval banner + diff preview for Normal mode

---

## Prerequisites

- **Node.js 20+**
- **Grok CLI** on `PATH` — https://x.ai/cli  
  Windows: `irm https://x.ai/cli/install.ps1 | iex`
- Active **SuperGrok** or eligible **X Premium+** account (same as CLI)

---

## Quick start

```bash
git clone https://github.com/soodal2u/grok-deck.git
cd grok-deck
npm install
npm run dev
```

If Electron fails to launch on Windows (`Electron failed to install correctly`):

```bash
node scripts/fix-electron.mjs
npm start
```

1. **Sign in with Grok** (runs `grok login --oauth` — same SuperGrok session as CLI)
2. **Open project** → pick a folder
3. Describe a task → **Ctrl+Enter**

### Production-ish local run

```bash
npm run build
npm start
```

### Windows installer / portable

```bash
npm run dist
```

Outputs under `apps/desktop/release/`:

| File | Description |
|---|---|
| `GrokDeck-*-Setup.exe` | NSIS installer |
| `GrokDeck-*-portable.exe` | Portable (no install) |
| `win-unpacked/Grok Deck.exe` | Unpacked app folder |

The packaged app still needs **Grok CLI** (`grok`) for the agent backend.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Enter** | Send message |
| **Shift+Tab** | Cycle Normal → Plan → Always-approve |
| **Ctrl+O** | Toggle Always-approve |
| **Ctrl+N** | New project / task dialog |
| **`@`** (composer) | File mention search |
| **`/`** (composer) | Slash commands & skills |

---

## Architecture

```
┌──────────────────────────┐
│  Grok Deck (Electron)    │  React UI — chat, tools, permissions, diffs, themes
│  Main process            │  IPC · dialogs · path jail · auth · ghost · sessions
└────────────┬─────────────┘
             │ ACP JSON-RPC over stdio
             │  · session/prompt, session/request_permission
             │  · fs/read_text_file, fs/write_text_file  ← required for edits
┌────────────▼─────────────┐
│  grok agent stdio        │  Official agent: tools, sessions, MCP, sandbox
│  ~/.grok/auth.json       │  OAuth tokens (shared with CLI)
│  ~/.grok/sessions        │  Thread history (shared with CLI)
└──────────────────────────┘
```

| Package | Role |
|---|---|
| `apps/desktop` | Electron + React UI |
| `packages/acp-client` | `grok agent stdio` JSON-RPC client, Ghost Git, terminals, usage |
| `packages/shared` | Shared types / IPC channel names |

### Why this approach?

Rebuilding a full coding agent (file tools, shell, permissions, skills, git, …) duplicates what the Grok CLI already does. Grok Deck focuses on the **desktop command-center experience** while keeping **OAuth + agent runtime** on the official CLI.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Electron development |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run dist` | Windows installer + portable |
| `npm run typecheck` | Typecheck workspaces |
| `npm run smoke:acp` | ACP smoke script |

---

## Config directory

`~/.grokdeck/`:

| Path | Purpose |
|---|---|
| `settings.json` | Model, theme, window, panels, reasoning |
| `project.json` | Last / recent projects |
| `themes/` | Custom wallpapers + catalog |
| `ghost/` | Per-project undo history |
| `usage/` | Cached context token usage |

---

## Roadmap

- Richer multi-file diff review (deeper integration with agent git/diff notifications)
- Worktree-aware parallel agents
- Skills / MCP manager UI
- Optional Computer Use surface
- Cross-platform packaging polish (macOS / Linux)

---

## License

Source is published publicly on GitHub. Add a `LICENSE` file if you want an explicit open-source license.
