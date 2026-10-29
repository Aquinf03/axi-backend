#!/usr/bin/env node
/**
 * Local bridge for web/ — stdin JSON → runSlashCli → JSON result.
 *
 * stdin:  { line: string, workspace?: string, sessionId?: string, history?: {role,content}[] }
 * stdout: { ok:true, text, kick? } | { ok:false, error }
 */
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

function fail(msg, code = 1) {
  emit({ ok: false, error: msg })
  process.exit(code)
}

if (!existsSync(path.join(dist, "core/commands/slash-cli.js"))) {
  fail("axi dist missing — run `npm run build` in the axi repo (need slash-cli)")
}

const raw = readFileSync(0, "utf8").trim()
if (!raw) fail("empty stdin — expected JSON body")

let body
try {
  body = JSON.parse(raw)
} catch {
  fail("stdin is not JSON")
}

const line = typeof body.line === "string" ? body.line.trim() : ""
if (!line || !line.startsWith("/") || line === "/") {
  fail("line must be a slash command (e.g. /status)")
}

const workspace = path.resolve(
  typeof body.workspace === "string" && body.workspace.trim()
    ? body.workspace.trim()
    : process.env.AXI_WEB_WORKSPACE?.trim() || root,
)

const sessionId =
  typeof body.sessionId === "string" && body.sessionId.trim()
    ? body.sessionId.trim()
    : `web_${Date.now().toString(36)}`

const historyIn = Array.isArray(body.history) ? body.history : []
const history = historyIn
  .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  .map((m) => ({ role: m.role, content: m.content }))

const slashCli = await import(pathToFileURL(path.join(dist, "core/commands/slash-cli.js")).href)

const now = new Date().toISOString()
const spec = {
  id: sessionId,
  name: "web",
  created: now,
  updated: now,
  workspace_root: workspace,
  train: workspace,
}

try {
  const result = await slashCli.runSlashCli(line, {
    workspace,
    sessionId,
    history,
    spec,
  })
  emit({
    ok: true,
    text: (result.text ?? "").trim() || "(ok)",
    kick: typeof result.kick === "string" ? result.kick : undefined,
    workspace,
  })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
