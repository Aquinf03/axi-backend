#!/usr/bin/env node
/**
 * Local bridge for web/ — stdin JSON → runSlashCli / resolveInteractive → JSON result.
 *
 * stdin:  {
 *   line?: string,
 *   resolve?: { kind, optionId?, input?, context?, query? },
 *   workspace?: string,
 *   sessionId?: string,
 *   history?: {role,content}[]
 * }
 * stdout: { ok:true, text, kick?, interactive?, action? } | { ok:false, error }
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
const resolve = body.resolve && typeof body.resolve === "object" ? body.resolve : null

if (!resolve && (!line || !line.startsWith("/") || line === "/")) {
  fail("line must be a slash command (e.g. /status) or pass resolve")
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
const chatName =
  typeof body.chatName === "string" && body.chatName.trim()
    ? body.chatName.trim().slice(0, 80)
    : "new chat"
const spec = {
  id: sessionId,
  name: chatName,
  created: now,
  updated: now,
  workspace_root: workspace,
  train: workspace,
}

try {
  const result = resolve
    ? await slashCli.resolveInteractive(
        {
          kind: String(resolve.kind || ""),
          optionId: typeof resolve.optionId === "string" ? resolve.optionId : undefined,
          input: typeof resolve.input === "string" ? resolve.input : undefined,
          query: typeof resolve.query === "string" ? resolve.query : undefined,
          context:
            resolve.context && typeof resolve.context === "object"
              ? Object.fromEntries(
                  Object.entries(resolve.context).filter(([, v]) => typeof v === "string"),
                )
              : undefined,
        },
        { workspace, sessionId, history, spec },
      )
    : await slashCli.runSlashCli(line, {
        workspace,
        sessionId,
        history,
        spec,
      })
  const text = (result.text ?? "").trim()
  emit({
    ok: true,
    text:
      text ||
      (result.interactive || result.action || resolve ? "" : "(ok)"),
    kick: typeof result.kick === "string" ? result.kick : undefined,
    interactive: result.interactive ?? undefined,
    action: result.action ?? undefined,
    workspace,
  })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
