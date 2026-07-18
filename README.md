# Grok Deck

**Language / 언어:** [English](#english) · [한국어](#한국어)

---

<a id="english"></a>

## English

**Grok Deck** is a Codex-style **desktop command center** for the official Grok coding agent.

It does **not** re-implement the agent brain. It is a GUI shell that:

1. Signs you in with the **same SuperGrok / X Premium+ OAuth** as the Grok CLI (`~/.grok/auth.json`)
2. Spawns `grok agent stdio` (Agent Client Protocol)
3. Streams chat, thoughts, tool calls, plans, and permission prompts in a desktop UI

> No `XAI_API_KEY` / console.x.ai API billing required when you use OAuth — usage follows your Grok CLI account subscription.

**Download (Windows):** see [Releases](https://github.com/soodal2u/grok-deck/releases) — Setup installer + portable EXE.

### Features (Grok Deck–specific)

These are what the desktop app adds on top of the CLI agent runtime.

#### Chat & streaming

- **Streaming conversation** with Markdown, GFM, and syntax-highlighted code blocks
- **Thought / reasoning stream** alongside assistant text
- **Live tool toast** — tool calls stay **collapsed** by default so chat stays readable; click to expand (status line updates: “searching…”, “editing…”, `3/12 done`)
- **Plan panel** — agent plan entries as they stream
- **Plan review card** (Codex-style) — expand plan, add change notes, **Apply & implement** or **Revise plan**
- **Turn timing** — duration after each turn
- **Composer**
  - **Ctrl+Enter** to send
  - **Image / file attachments** (picker, drag & drop)
  - **`@` file mentions** — workspace file search
  - **`/` slash commands** — built-ins + agent commands + **Skills** (`SKILL.md`)

#### Built-in slash helpers

| Command | What it does |
|---|---|
| `/compact` | Compact conversation (save context) |
| `/context` | Show context usage |
| `/session-info` | Session metadata |
| `/always-approve` | Toggle always-approve (`on` / `off`) |
| `/new` | New session (UI) |
| `/clear` | Clear chat (UI) |
| `/help` | List commands / skills |

#### Safety modes (CLI parity)

Cycle with **Shift+Tab**. Toggle Always-approve with **Ctrl+O**.

| Mode | Shortcut | Behavior |
|---|---|---|
| **Normal** | Shift+Tab | Ask before file writes & risky tools |
| **Plan** | Shift+Tab | Project writes blocked; **`plan.md` writable**; review card to apply / revise |
| **Always-approve** | Shift+Tab / **Ctrl+O** | Auto-approve tools & edits (use carefully) |

#### Ghost Git (undo agent edits)

Deck-only local history — not your project’s real git.

- Snapshots **before/after** per file after a turn that writes
- **Undo** restores previous snapshot
- **Edit summary cards** show which files changed (+/−) immediately after the turn
- Stored under `~/.grokdeck/ghost/`

#### Right sidebar

- **Plan phase checklist** — current step / completed / in progress
- **Diff review** — files changed this session + preview
- Context meter, Ghost Git status, open in Explorer / PS / CMD / VS Code / Cursor

#### Sessions & projects

- Threads grouped by project from `~/.grok/sessions` (shared with CLI)
- Resume / delete sessions, noise filter for short/test threads
- New project (**Ctrl+N**), open folder

#### Themes

Dark · Ember · Night · Aurora · custom wallpapers (import / AI Theme tab)

#### Settings

Model, reasoning effort (`low` / `medium` / `high`), Grok CLI path, theme opacity, panel widths, window bounds — all under **`~/.grokdeck/`**.

### Prerequisites

- **Node.js 20+**
- **Grok CLI** on `PATH` — https://x.ai/cli  
  Windows: `irm https://x.ai/cli/install.ps1 | iex`
- Active **SuperGrok** or eligible **X Premium+** account

### Quick start

```bash
git clone https://github.com/soodal2u/grok-deck.git
cd grok-deck
npm install
npm run dev
```

If Electron fails on Windows (`Electron failed to install correctly`):

```bash
node scripts/fix-electron.mjs
npm start
```

1. **Sign in with Grok**
2. **Open project**
3. Describe a task → **Ctrl+Enter**

```bash
npm run build && npm start   # production-ish local
npm run dist                 # Windows Setup + portable → apps/desktop/release/
```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Enter** | Send |
| **Shift+Tab** | Normal → Plan → Always-approve |
| **Ctrl+O** | Toggle Always-approve |
| **Ctrl+N** | New project |
| **`@`** | File mention |
| **`/`** | Slash commands & skills |

### Architecture

```
┌──────────────────────────┐
│  Grok Deck (Electron)    │  React UI — chat, tools, permissions, diffs, themes
│  Main process            │  IPC · path jail · auth · ghost · sessions
└────────────┬─────────────┘
             │ ACP JSON-RPC over stdio
┌────────────▼─────────────┐
│  grok agent stdio        │  Official agent runtime
│  ~/.grok/auth.json       │  OAuth (shared with CLI)
│  ~/.grok/sessions        │  Threads (shared with CLI)
└──────────────────────────┘
```

| Package | Role |
|---|---|
| `apps/desktop` | Electron + React UI |
| `packages/acp-client` | ACP client, Ghost Git, terminals, usage |
| `packages/shared` | Shared types / IPC |

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev |
| `npm run build` / `start` | Production build / run |
| `npm run dist` | Windows installer + portable |
| `npm run typecheck` | Typecheck |
| `npm run smoke:acp` | ACP smoke |

### Config directory

`~/.grokdeck/` — `settings.json`, `project.json`, `themes/`, `ghost/`, `usage/`

### License

Published publicly on GitHub. Add a `LICENSE` file if you want an explicit open-source license.

---

<a id="한국어"></a>

## 한국어

**Grok Deck**은 공식 Grok 코딩 에이전트를 위한 **Codex 스타일 데스크톱 커맨드 센터**입니다.

에이전트 “두뇌”를 다시 만든 앱이 **아닙니다**. GUI 셸로서 다음을 합니다:

1. Grok CLI와 **동일한 SuperGrok / X Premium+ OAuth**로 로그인 (`~/.grok/auth.json`)
2. `grok agent stdio` 실행 (Agent Client Protocol)
3. 채팅, 사고 과정, 도구 호출, 계획, 권한 요청을 데스크톱 UI로 스트리밍

> OAuth 사용 시 `XAI_API_KEY` / console.x.ai API 과금이 필요 없습니다. 사용량은 Grok CLI 구독을 따릅니다.

**Windows 다운로드:** [Releases](https://github.com/soodal2u/grok-deck/releases)에서 **설치형(Setup)** · **포터블(portable)** EXE를 받을 수 있습니다.

### Grok Deck만의 기능

CLI 에이전트 런타임 위에 데스크톱이 더하는 부분입니다.

#### 채팅 & 스트리밍

- Markdown / GFM / 코드 하이라이트 **스트리밍 대화**
- 어시스턴트 옆 **사고(Thought) 스트림**
- **라이브 툴 토스트** — 도구 호출이 많을 때 **기본 접힘**. 채팅 글이 가려지지 않음. 클릭 시 펼침. 현재 작업 이름·진행 수(`3/12 완료`) 갱신
- **플랜 패널** — 단계 목록 스트리밍
- **계획 리뷰 카드** (Codex 스타일) — 계획 펼치기, 수정 메모, **계획 적용·구현 시작** / **계획 수정 요청**
- 턴 소요 시간 표시
- **입력창**
  - **Ctrl+Enter** 전송
  - 이미지·파일 첨부 (선택, 드래그 앤 드롭)
  - **`@` 파일 멘션** — 워크스페이스 파일 검색
  - **`/` 슬래시 명령** — 내장 명령 + 에이전트 명령 + **스킬** (`SKILL.md`)

#### 내장 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/compact` | 대화 압축 (컨텍스트 절약) |
| `/context` | 컨텍스트 사용량 |
| `/session-info` | 세션 정보 |
| `/always-approve` | Always-approve 토글 (`on` / `off`) |
| `/new` | 새 세션 (UI) |
| `/clear` | 대화 비우기 (UI) |
| `/help` | 명령·스킬 목록 |

#### 안전 모드 (CLI와 동일 개념)

**Shift+Tab**으로 순환, **Ctrl+O**로 Always-approve 토글.

| 모드 | 단축키 | 동작 |
|---|---|---|
| **Normal** | Shift+Tab | 파일 쓰기·위험 도구 전 확인 |
| **Plan** | Shift+Tab | 프로젝트 파일 쓰기 차단, **`plan.md`만 쓰기 가능**, 리뷰 카드로 적용/수정 |
| **Always-approve** | Shift+Tab / **Ctrl+O** | 도구·편집 자동 승인 (신중히) |

권한 요청은 **큐**에 쌓입니다. 쓰기 승인 시 **diff 미리보기**를 보여 줍니다.

#### Ghost Git (에이전트 편집 되돌리기)

프로젝트 실제 git이 아닌 **Deck 전용** 로컬 히스토리입니다.

- 파일을 쓴 턴마다 **이전/이후** 스냅샷
- **실행 취소**로 직전 스냅샷 복원 (프로젝트별 스택)
- 턴 종료 직후 **「파일 N개를 편집했습니다」** 카드 (+/−, 리뷰, 실행 취소)
- 저장 위치: `~/.grokdeck/ghost/` (Windows: `C:\Users\<이름>\.grokdeck\ghost\`)

#### 우측 패널

- **현재 작업 단계** — Plan 페이즈 투두 (완료 / 진행 중 / 대기, 진행 바)
- **리뷰 · Diff** — 이번 세션 변경 파일 목록·미리보기
- 컨텍스트 미터, Ghost Git, 탐색기 / PowerShell / CMD / VS Code / Cursor로 열기

#### 세션 & 프로젝트

- 왼쪽: `~/.grok/sessions` 기준 **프로젝트별 스레드** (CLI와 동일 저장소)
- 세션 이어하기 / 삭제, 짧은·테스트 세션 숨기기
- 프로젝트 열기, 새 작업 (**Ctrl+N**)

#### 테마

다크 · 엠버 · 나이트 · 오로라 · 커스텀 배경 (가져오기 / AI 테마 탭)

#### 설정

모델, 추론 강도 (`low` / `medium` / `high`), Grok CLI 경로, 배경 강도, 패널 너비, 창 위치 — 모두 **`~/.grokdeck/`** 에 저장.

### 사전 요구 사항

- **Node.js 20+**
- **Grok CLI**가 `PATH`에 있어야 함 — https://x.ai/cli  
  Windows: `irm https://x.ai/cli/install.ps1 | iex`
- **SuperGrok** 또는 이용 가능한 **X Premium+** 계정 (CLI와 동일)

### 빠른 시작

```bash
git clone https://github.com/soodal2u/grok-deck.git
cd grok-deck
npm install
npm run dev
```

Windows에서 Electron 실행 오류 (`Electron failed to install correctly`)가 나면:

```bash
node scripts/fix-electron.mjs
npm start
```

1. **Grok으로 로그인**
2. **프로젝트 열기**
3. 할 일 입력 → **Ctrl+Enter**

```bash
npm run build && npm start   # 로컬 프로덕션에 가깝게 실행
npm run dist                 # Setup + portable → apps/desktop/release/
```

| 파일 | 설명 |
|---|---|
| `GrokDeck-*-Setup.exe` | NSIS 설치 프로그램 |
| `GrokDeck-*-portable.exe` | 설치 없이 실행 |
| `win-unpacked/Grok Deck.exe` | 압축 해제된 앱 |

패키징된 앱도 에이전트 백엔드로 **Grok CLI (`grok`)** 가 필요합니다.

### 키보드 단축키

| 단축키 | 동작 |
|---|---|
| **Ctrl+Enter** | 메시지 전송 |
| **Shift+Tab** | Normal → Plan → Always-approve 순환 |
| **Ctrl+O** | Always-approve 토글 |
| **Ctrl+N** | 새 프로젝트 / 작업 |
| **`@`** | 파일 멘션 검색 |
| **`/`** | 슬래시 명령 · 스킬 |

### 구조

```
┌──────────────────────────┐
│  Grok Deck (Electron)    │  React UI — 채팅, 도구, 권한, diff, 테마
│  메인 프로세스            │  IPC · path jail · 인증 · ghost · 세션
└────────────┬─────────────┘
             │ ACP JSON-RPC (stdio)
┌────────────▼─────────────┐
│  grok agent stdio        │  공식 에이전트 런타임
│  ~/.grok/auth.json       │  OAuth (CLI와 공유)
│  ~/.grok/sessions        │  스레드 (CLI와 공유)
└──────────────────────────┘
```

| 패키지 | 역할 |
|---|---|
| `apps/desktop` | Electron + React UI |
| `packages/acp-client` | ACP 클라이언트, Ghost Git, 터미널, 사용량 |
| `packages/shared` | 공통 타입 / IPC |

**왜 이 방식인가?** 파일 도구·셸·권한·스킬 등을 전부 다시 만들면 CLI와 중복됩니다. Deck는 **데스크톱 경험**에 집중하고, **OAuth + 에이전트 실행**은 공식 CLI에 맡깁니다.

### 스크립트

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 실행 |
| `npm run build` / `start` | 프로덕션 빌드 / 실행 |
| `npm run dist` | Windows 설치·포터블 |
| `npm run typecheck` | 타입 검사 |
| `npm run smoke:acp` | ACP 스모크 |

### 설정 폴더

`~/.grokdeck/` (Windows: `C:\Users\<이름>\.grokdeck\`)

| 경로 | 용도 |
|---|---|
| `settings.json` | 모델, 테마, 창, 패널, 추론 강도 |
| `project.json` | 최근 프로젝트 |
| `themes/` | 커스텀 배경 |
| `ghost/` | 프로젝트별 되돌리기 히스토리 |
| `usage/` | 컨텍스트 토큰 사용량 캐시 |

구버전 `~/.grok-deck` 은 첫 실행 시 자동 이전됩니다.

### 로드맵

- 더 풍부한 멀티 파일 diff 리뷰
- 워크트리 기반 병렬 에이전트
- 스킬 / MCP 관리 UI
- Computer Use (선택)
- macOS / Linux 패키징

### 라이선스

GitHub에 공개되어 있습니다. 명시적 오픈소스 라이선스가 필요하면 `LICENSE` 파일을 추가하세요.
