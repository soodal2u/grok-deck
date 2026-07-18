import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve, isAbsolute, relative, sep } from "node:path";

export type ManagedTerminal = {
  id: string;
  proc: ChildProcessWithoutNullStreams | null;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  waiters: Array<(status: { exitCode: number | null; signal: string | null }) => void>;
  cwd: string;
  command: string;
};

/**
 * Implements ACP terminal/* methods for the desktop client.
 *
 * Important on Windows:
 * - Agent terminals must NEVER show a visible console window.
 * - Spawning via `cmd /c …` only applies CREATE_NO_WINDOW (windowsHide) to
 *   cmd.exe. The leaf process (python.exe, etc.) is started by cmd without
 *   that flag, so Windows Terminal / OpenConsole can attach a translucent
 *   window (the "empty transparent terminal" bug).
 * - Prefer spawning the leaf executable directly with windowsHide: true.
 * - Only fall back to cmd when the command truly needs a shell (&&, |, …).
 * - Never use shell: true on Windows for agent tools.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private seq = 0;

  constructor(private workspaceRoot: string) {}

  create(params: {
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    cwd?: string | null;
    outputByteLimit?: number | null;
  }): { terminalId: string } {
    const cwd = this.resolveCwd(params.cwd);
    const outputByteLimit = params.outputByteLimit ?? 1_048_576;
    const id = `term_${Date.now().toString(36)}_${++this.seq}`;

    const env = buildHiddenEnv(params.env);

    const command = params.command;
    const args = params.args || [];
    const fullCmd = [command, ...args].join(" ");

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnHidden(command, args, cwd, env);
    } catch (err) {
      const term: ManagedTerminal = {
        id,
        proc: null,
        output: err instanceof Error ? err.message : String(err),
        truncated: false,
        outputByteLimit,
        exitCode: 1,
        signal: null,
        exited: true,
        waiters: [],
        cwd,
        command: fullCmd,
      };
      this.terminals.set(id, term);
      return { terminalId: id };
    }

    const term: ManagedTerminal = {
      id,
      proc,
      output: "",
      truncated: false,
      outputByteLimit,
      exitCode: null,
      signal: null,
      exited: false,
      waiters: [],
      cwd,
      command: fullCmd,
    };
    this.terminals.set(id, term);

    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      term.output += text;
      if (Buffer.byteLength(term.output, "utf8") > term.outputByteLimit) {
        let bytes = Buffer.byteLength(term.output, "utf8");
        let start = 0;
        while (bytes > term.outputByteLimit && start < term.output.length) {
          start += 1;
          bytes = Buffer.byteLength(term.output.slice(start), "utf8");
        }
        term.output = term.output.slice(start);
        term.truncated = true;
      }
    };

    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    proc.on("error", (err) => {
      term.output += (term.output ? "\n" : "") + err.message;
      if (!term.exited) {
        term.exited = true;
        term.exitCode = 1;
        this.flushWaiters(term);
      }
    });

    proc.on("close", (code, signal) => {
      term.exited = true;
      term.exitCode = code;
      term.signal = signal;
      term.proc = null;
      this.flushWaiters(term);
    });

    return { terminalId: id };
  }

  /**
   * Spawn without a visible console window.
   * Windows: spawn the leaf process directly so CREATE_NO_WINDOW applies to it.
   */
  private spawnHidden(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): ChildProcessWithoutNullStreams {
    const opts = {
      cwd,
      env,
      windowsHide: true as const,
      // Pipe all streams so no console is needed for IO
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };

    if (process.platform === "win32") {
      const resolved = resolveWinCommand(command, args);
      return spawn(resolved.file, resolved.args, {
        ...opts,
        // windowsVerbatimArguments only for cmd fallback paths
        windowsVerbatimArguments: resolved.verbatim === true,
        shell: false,
      }) as ChildProcessWithoutNullStreams;
    }

    if (args.length === 0 && /[\s|&;<>]/.test(command)) {
      return spawn(command, { ...opts, shell: true }) as ChildProcessWithoutNullStreams;
    }
    return spawn(command, args, opts) as ChildProcessWithoutNullStreams;
  }

  output(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const term = this.require(terminalId);
    const result: {
      output: string;
      truncated: boolean;
      exitStatus?: { exitCode: number | null; signal: string | null };
    } = {
      output: term.output,
      truncated: term.truncated,
    };
    if (term.exited) {
      result.exitStatus = { exitCode: term.exitCode, signal: term.signal };
    }
    return result;
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const term = this.require(terminalId);
    if (term.exited) {
      return Promise.resolve({ exitCode: term.exitCode, signal: term.signal });
    }
    return new Promise((resolve) => {
      term.waiters.push(resolve);
    });
  }

  kill(terminalId: string): Record<string, never> {
    const term = this.require(terminalId);
    if (term.proc && !term.exited) {
      try {
        if (process.platform === "win32" && term.proc.pid) {
          // Kill the whole tree (cmd/python children if any)
          spawn("taskkill", ["/pid", String(term.proc.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          term.proc.kill("SIGTERM");
        }
      } catch {
        try {
          term.proc.kill();
        } catch {
          /* ignore */
        }
      }
    }
    return {};
  }

  release(terminalId: string): Record<string, never> {
    const term = this.terminals.get(terminalId);
    if (!term) return {};
    if (term.proc && !term.exited) {
      this.kill(terminalId);
    }
    this.terminals.delete(terminalId);
    return {};
  }

  disposeAll() {
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
  }

  private require(terminalId: string): ManagedTerminal {
    const term = this.terminals.get(terminalId);
    if (!term) throw new Error(`Unknown terminalId: ${terminalId}`);
    return term;
  }

  private flushWaiters(term: ManagedTerminal) {
    const status = { exitCode: term.exitCode, signal: term.signal };
    for (const w of term.waiters) w(status);
    term.waiters = [];
  }

  private resolveCwd(cwd?: string | null): string {
    const root = resolve(this.workspaceRoot);
    if (!cwd) return root;
    const abs = resolve(isAbsolute(cwd) ? cwd : resolve(root, cwd));
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      const rootLower = root.toLowerCase();
      const absLower = abs.toLowerCase();
      if (
        !absLower.startsWith(rootLower.endsWith(sep) ? rootLower : rootLower + sep) &&
        absLower !== rootLower
      ) {
        throw new Error(`Terminal cwd outside workspace is blocked: ${abs}`);
      }
    }
    return abs;
  }
}

/** Strip WT session vars and force non-interactive terminal hints. */
function buildHiddenEnv(
  extra?: Array<{ name: string; value: string }>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1", TERM: "dumb" };
  // Empty string is not enough — delete so Windows Terminal does not reattach
  delete env.WT_SESSION;
  delete env.WT_PROFILE_ID;
  delete env.WT_PROFILE;
  for (const e of extra || []) {
    if (e?.name) env[e.name] = e.value;
  }
  return env;
}

/**
 * Resolve how to spawn on Windows so CREATE_NO_WINDOW applies to the real
 * executable (python, node, git, …), not only a cmd.exe wrapper.
 */
function resolveWinCommand(
  command: string,
  args: string[],
): { file: string; args: string[]; verbatim?: boolean } {
  // Explicit args → direct spawn of the leaf process
  if (args.length > 0) {
    return { file: command, args };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { file: command, args: [] };
  }

  // Shell metacharacters require cmd
  if (needsShell(trimmed)) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", trimmed],
      verbatim: true,
    };
  }

  // Single-string command like `python calculator.py` or `"C:\Path\app.exe" -x`
  // → parse and spawn leaf directly so windowsHide hits python/app, not cmd.
  const tokens = tokenizeCmdLine(trimmed);
  if (tokens.length === 0) {
    return { file: command, args: [] };
  }
  return { file: tokens[0], args: tokens.slice(1) };
}

function needsShell(cmdline: string): boolean {
  // Operators that require cmd.exe interpretation
  return /&&|\|\||[|<>]|\b(cd|set|call|if|for|exit)\b/i.test(cmdline) || /[\r\n]/.test(cmdline);
}

/**
 * Minimal Windows command-line tokenizer (handles "double quotes").
 * Good enough for agent tool invocations; complex shell syntax hits needsShell.
 */
function tokenizeCmdLine(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}
