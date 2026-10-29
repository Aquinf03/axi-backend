/** `axi web` — install/start the Next.js shell and open it. */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import http from "node:http"
import { createServer } from "node:net"
import path from "node:path"
import { stdout, stderr } from "node:process"
import { axiHome } from "../home.js"
import { proposeConfigWrite } from "../config/pending.js"
import { agentRoot } from "../root.js"
import { createNativeHost } from "../hosts/native.js"

export const DEFAULT_WEB_PORT = 3000
/** Match the URL we open — avoids IPv6/hostname mismatch with Firefox HMR. */
const LISTEN_HOST = "127.0.0.1"

/** Web servers started for an axi TTY session — stopped when that session exits. */
const sessionOwned = new Map<number, { port: number; child: ChildProcess }>()

function configPath(): string {
  return path.join(axiHome(), "config.json")
}

type ConfigFile = {
  web_port?: number
  [key: string]: unknown
}

function loadConfigFile(): ConfigFile {
  const p = configPath()
  if (!existsSync(p)) return {}
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as ConfigFile
    if (!j || typeof j !== "object") return {}
    return j
  } catch {
    return {}
  }
}

/** Configured listen port (`~/.axi/config.json` → `web_port`). */
export function getWebPort(): number {
  const n = loadConfigFile().web_port
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n)
  return DEFAULT_WEB_PORT
}

/** Persist listen port; returns status text (may include staged config diff). */
export function setWebPort(port: number): string {
  const n = Math.floor(port)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid web port: ${port}`)
  const cfg = loadConfigFile()
  cfg.web_port = n
  mkdirSync(axiHome(), { recursive: true, mode: 0o700 })
  const body = JSON.stringify(cfg, null, 2) + "\n"
  const result = proposeConfigWrite({
    path: configPath(),
    body,
    label: "config.json",
    mode: 0o600,
    summary: `web_port → ${n}`,
  })
  if (result.kind === "staged") return `web port  ${n}\n\n${result.diff}`
  return `web port  ${n}`
}

export type WebRuntimeStatus = {
  running: boolean
  sessionOwned: boolean
  port: number
  url: string
}

/** Live status for the configured (or session-owned) web UI. */
export function webRuntimeStatus(): WebRuntimeStatus {
  for (const entry of sessionOwned.values()) {
    const port = entry.port
    return {
      running: true,
      sessionOwned: true,
      port,
      url: `http://127.0.0.1:${port}`,
    }
  }
  const port = getWebPort()
  const url = `http://127.0.0.1:${port}`
  return { running: false, sessionOwned: false, port, url }
}

/** Async status: also probes whether something answers on the configured port. */
export async function webRuntimeStatusAsync(): Promise<WebRuntimeStatus> {
  const base = webRuntimeStatus()
  if (base.running) return base
  const free = await portFree(base.port)
  if (!free) {
    return { ...base, running: true, sessionOwned: false }
  }
  return base
}

export function webStatusText(status: WebRuntimeStatus = webRuntimeStatus()): string {
  const state = status.running ? "on" : "off"
  const owned = status.running
    ? status.sessionOwned
      ? " · session"
      : " · external"
    : ""
  return `web  ${state} · :${status.port} · ${status.url}${owned}`
}

function takeFlag(argv: string[], name: string): { argv: string[]; present: boolean } {
  const i = argv.indexOf(name)
  if (i < 0) return { argv, present: false }
  return { argv: [...argv.slice(0, i), ...argv.slice(i + 1)], present: true }
}

function takeOpt(argv: string[], name: string): { argv: string[]; value: string | null } {
  const i = argv.indexOf(name)
  if (i < 0) return { argv, value: null }
  const value = argv[i + 1] ?? null
  if (!value || value.startsWith("-")) {
    return { argv: [...argv.slice(0, i), ...argv.slice(i + 1)], value: null }
  }
  return { argv: [...argv.slice(0, i), ...argv.slice(i + 2)], value }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once("error", () => resolve(false))
    s.once("listening", () => {
      s.close(() => resolve(true))
    })
    s.listen(port, LISTEN_HOST)
  })
}

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (r.status > 0) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  return false
}

/** Probe Next HMR upgrade so the browser is not opened before the socket is ready. */
function probeHmr(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let u: URL
    try {
      u = new URL(baseUrl)
    } catch {
      done(false)
      return
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: "/_next/hmr?id=axi-ready",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(false)
    })
    req.once("upgrade", (_res, socket) => {
      socket.destroy()
      done(true)
    })
    req.once("response", (res) => {
      res.resume()
      done(false)
    })
    req.once("error", () => done(false))
    req.end()
  })
}

async function waitHmr(url: string, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await probeHmr(url)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** HTTP up + HMR upgrade accepting — ready for the browser. */
async function waitReady(url: string, ms: number): Promise<boolean> {
  const start = Date.now()
  if (!(await waitHttp(url, ms))) return false
  const left = Math.max(2_000, ms - (Date.now() - start))
  return waitHmr(url, left)
}

function webDir(): string {
  const root = agentRoot()
  // Released/npm layout ships `web/` inside the package; monorepo keeps it at repo-root.
  const nested = path.join(root, "web")
  if (existsSync(path.join(nested, "package.json"))) return nested
  return path.join(root, "..", "web")
}

function ensureWebTree(): string {
  const dir = webDir()
  if (!existsSync(path.join(dir, "package.json"))) {
    throw new Error(
      `web UI missing at ${dir} — use an axi checkout with web/, or reinstall a release that ships web/`,
    )
  }
  return dir
}

function ensureDist(): void {
  const root = agentRoot()
  const loop = path.join(root, "dist", "core", "agent", "agent-loop.js")
  if (existsSync(loop)) return
  stderr.write("axi web  building axi (dist missing)…\n")
  const r = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  })
  if (r.status !== 0) throw new Error("axi build failed — run `npm run build` in the axi repo")
}

function ensureWebDeps(dir: string): void {
  if (existsSync(path.join(dir, "node_modules", "next"))) return
  stderr.write("axi web  installing web dependencies…\n")
  const r = spawnSync("npm", ["install"], {
    cwd: dir,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  })
  if (r.status !== 0) throw new Error("web npm install failed")
}

function nextBin(dir: string): string {
  const local = path.join(dir, "node_modules", "next", "dist", "bin", "next")
  if (existsSync(local)) return local
  const win = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next")
  if (existsSync(win)) return win
  return "next"
}

/** Kill a process and its group / tree (Next spawns workers). */
export function killWebProcess(pid: number): void {
  if (!pid || pid <= 0) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      return
    }
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* ignore */
        }
      }
    }, 1200).unref?.()
  } catch {
    /* ignore */
  }
}

/** Stop web UIs that this axi TTY session started (not orphan --detach servers). */
export function stopSessionOwnedWeb(): void {
  for (const [pid, entry] of sessionOwned) {
    sessionOwned.delete(pid)
    try {
      entry.child.removeAllListeners()
    } catch {
      /* ignore */
    }
    killWebProcess(pid)
  }
}

function trackSession(child: ChildProcess, port: number): void {
  const pid = child.pid
  if (!pid) return
  sessionOwned.set(pid, { port, child })
  child.once("exit", () => {
    sessionOwned.delete(pid)
  })
}

function startNext(opts: {
  dir: string
  port: number
  workspace: string
  /** orphan = survive axi exit; session = killed with TTY; foreground = inherit stdio */
  mode: "orphan" | "session" | "foreground"
}): ChildProcess {
  const env = {
    ...process.env,
    AXI_WEB_WORKSPACE: opts.workspace,
    PORT: String(opts.port),
  }
  const bin = nextBin(opts.dir)
  // Pin hostname to the same host we open in the browser (HMR WebSocket).
  const args = ["dev", "-H", LISTEN_HOST, "-p", String(opts.port)]
  const sessionOrOrphan = opts.mode === "session" || opts.mode === "orphan"
  const child = spawn(bin, args, {
    cwd: opts.dir,
    env,
    stdio: opts.mode === "foreground" ? "inherit" : "ignore",
    shell: process.platform === "win32" && bin.endsWith(".cmd"),
    // New process group so we can kill Next + workers with -pid
    detached: sessionOrOrphan,
  })
  if (opts.mode === "orphan") child.unref()
  if (opts.mode === "session") trackSession(child, opts.port)
  return child
}

export type LaunchWebResult = {
  url: string
  alreadyRunning: boolean
  started: boolean
  pid?: number
}

/** Ensure the web UI is reachable; optionally start Next and open the browser. */
export async function launchWeb(opts: {
  workspace?: string
  port?: number
  open?: boolean
  /**
   * orphan — survive after axi exits (`axi web --detach`)
   * session — stop when TTY/chat exits (`/web`)
   * Default orphan when detach true, else unused (caller starts foreground).
   */
  ownership?: "orphan" | "session"
  /** @deprecated use ownership — true maps to orphan */
  detach?: boolean
  waitMs?: number
}): Promise<LaunchWebResult> {
  const port = opts.port && opts.port > 0 ? opts.port : getWebPort()
  const workspace = path.resolve(opts.workspace?.trim() || process.cwd())
  const url = `http://127.0.0.1:${port}`
  const dir = ensureWebTree()
  ensureDist()
  ensureWebDeps(dir)

  const ownership: "orphan" | "session" =
    opts.ownership ?? (opts.detach === true ? "orphan" : "session")

  const free = await portFree(port)
  let alreadyRunning = !free
  let started = false
  let pid: number | undefined

  if (free) {
    const child = startNext({ dir, port, workspace, mode: ownership })
    pid = child.pid
    started = true
    const ok = await waitReady(url, opts.waitMs ?? 90_000)
    if (!ok) {
      if (pid) killWebProcess(pid)
      sessionOwned.delete(pid ?? -1)
      throw new Error(`web UI did not become ready at ${url}`)
    }
  } else {
    const ok = await waitReady(url, 5_000)
    if (!ok) alreadyRunning = false
  }

  if (opts.open !== false) {
    const host = createNativeHost(workspace)
    await host.openUrl(url)
  }

  return { url, alreadyRunning, started, pid }
}

/** CLI: `axi web [--port N] [--no-open] [--detach] [dir]` */
export async function webCmd(argv: string[]): Promise<void> {
  let rest = [...argv]
  const noOpen = takeFlag(rest, "--no-open")
  rest = noOpen.argv
  const detach = takeFlag(rest, "--detach")
  rest = detach.argv
  const portOpt = takeOpt(rest, "--port")
  rest = portOpt.argv
  const port = portOpt.value ? Number(portOpt.value) : getWebPort()
  if (!Number.isFinite(port) || port <= 0) {
    stderr.write("usage: axi web [--port N] [--no-open] [--detach] [dir]\n")
    process.exitCode = 1
    return
  }
  if (portOpt.value) {
    try {
      setWebPort(port)
    } catch {
      /* ignore — still start on the requested port */
    }
  }

  const workspace = rest[0] && !rest[0].startsWith("-") ? path.resolve(rest[0]) : process.cwd()

  try {
    if (detach.present) {
      const r = await launchWeb({
        workspace,
        port,
        open: !noOpen.present,
        ownership: "orphan",
      })
      stdout.write(
        r.alreadyRunning
          ? `axi web  already running · ${r.url}\n`
          : `axi web  started · ${r.url}\n`,
      )
      return
    }

    const dir = ensureWebTree()
    ensureDist()
    ensureWebDeps(dir)
    const url = `http://127.0.0.1:${port}`
    const free = await portFree(port)

    if (!free) {
      stdout.write(`axi web  already running · ${url}\n`)
      if (!noOpen.present) {
        const host = createNativeHost(workspace)
        await host.openUrl(url)
      }
      return
    }

    stdout.write(`axi web  ${url}\n`)
    stdout.write(`axi web  workspace ${workspace}\n`)
    const child = startNext({ dir, port, workspace, mode: "foreground" })

    const opened = { done: false }
    void (async () => {
      const ok = await waitReady(url, 90_000)
      if (!ok || opened.done) return
      opened.done = true
      if (!noOpen.present) {
        const host = createNativeHost(workspace)
        await host.openUrl(url)
      }
      stdout.write(`axi web  ready · ${url}\n`)
    })()

    await new Promise<void>((resolve) => {
      child.on("exit", (code) => {
        if (code && code !== 0) process.exitCode = code
        resolve()
      })
      const stop = () => {
        const pid = child.pid
        if (pid) killWebProcess(pid)
        else {
          try {
            child.kill("SIGTERM")
          } catch {
            /* ignore */
          }
        }
      }
      process.on("SIGINT", stop)
      process.on("SIGTERM", stop)
    })
  } catch (err) {
    stderr.write(`axi web  ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
