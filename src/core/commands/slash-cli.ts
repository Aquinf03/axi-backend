/**
 * Apply a slash command in headless CLI (axi runline).
 * Same runSlash contract as TTY chat; side-effects that need a host run here.
 */

import { stdout, stderr } from "node:process"
import {
  activeId,
  activeLabel,
  contextWindow,
  hasCreds,
  runSlash,
  temperatureLabel,
  type SlashResult,
} from "../../gateway.js"
import {
  approvePendingDeploy,
  formatRefinementNotice,
  runRefine,
  runRefineRollback,
} from "../arl.js"
import { measureContext } from "../agent/context.js"
import { agentLog, cancelAgent, formatAgents, startAgent } from "../agent/spawn.js"
import { formatDoctor, runDoctor } from "./doctor.js"
import { decide, formatDecideAnswer } from "../decision.js"
import { formatFactoryStatus, startFactory } from "../factory.js"
import { createNativeHost, normalizeOpenUrl } from "../hosts.js"
import { listChats, type ChatSpec } from "../session.js"
import { resolveConfig } from "../config.js"
import { webRuntimeStatus } from "./web.js"
import type { ChatMsg } from "../agent/agent-loop.js"
import { frameworkVersion } from "../version.js"
import { shortPath } from "../paths.js"
import { isTrain } from "../schema.js"
import { codemodeModeStatusText } from "../codemode.js"
import { stanceStatusText } from "../stance.js"
import { formatAgentsRoster } from "../daemon.js"

export type SlashCliOpts = {
  workspace: string
  sessionId: string
  /** Mutable chat history for refine / context. */
  history: ChatMsg[]
  spec: ChatSpec
}

function out(text: string): void {
  const t = text.endsWith("\n") ? text : text + "\n"
  stdout.write(t)
}

function err(text: string): void {
  stderr.write(text.endsWith("\n") ? text : text + "\n")
}

function statusText(workspace: string, spec: ChatSpec, history: ChatMsg[]): string {
  const id = activeId()
  const snap = measureContext(workspace, history, contextWindow())
  const web = webRuntimeStatus()
  const row = (k: string, v: string) => `  ${k.padEnd(12)}  ${v}`
  return [
    "status",
    row("axi", frameworkVersion().version),
    row("path", shortPath(workspace)),
    row("cwd", workspace),
    row("train", isTrain(workspace) ? "yes" : "no"),
    row("provider", id ?? "none"),
    row("model", id ? activeLabel() : "—"),
    row("temp", temperatureLabel()),
    row("key", id ? (hasCreds(id) ? "set" : "missing") : "—"),
    row("window", String(snap.window)),
    row("context", snap.line),
    row("mode", resolveConfig(workspace).permission_mode),
    row("codemode", codemodeModeStatusText().replace(/^codemode\s+/, "")),
    row("stance", stanceStatusText(spec.id).replace(/^stance\s+/, "")),
    row("web", `${web.running ? "on" : "off"} · :${web.port}`),
    row("chat", `${spec.name}  ${spec.id}`),
    row("messages", String(history.length)),
  ].join("\n")
}

async function applyWeb(r: SlashResult, workspace: string): Promise<void> {
  const {
    getWebPort,
    launchWeb,
    setWebPort,
    stopSessionOwnedWeb,
    webRuntimeStatus: runtimeStatus,
    webRuntimeStatusAsync,
    webStatusText,
  } = await import("./web.js")
  if (r.web === "status") {
    out(webStatusText(await webRuntimeStatusAsync()))
    return
  }
  if (r.web === "off") {
    const before = await webRuntimeStatusAsync()
    if (!before.running) {
      out(webStatusText(before))
      return
    }
    if (!before.sessionOwned) {
      out(
        `${webStatusText(before)}\nweb UI  not owned by this session — stop the process on :${before.port} yourself`,
      )
      return
    }
    stopSessionOwnedWeb()
    out(webStatusText(runtimeStatus()))
    return
  }
  if (r.webPort != null) {
    try {
      const saved = setWebPort(r.webPort)
      if (saved.includes("\n\n")) out(saved)
    } catch (e) {
      err(`web UI  ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const before = runtimeStatus()
    if (before.sessionOwned && before.port !== r.webPort) stopSessionOwnedWeb()
  }
  try {
    const launched = await launchWeb({
      workspace,
      port: r.webPort,
      open: true,
      ownership: "session",
    })
    const port = Number(new URL(launched.url).port) || r.webPort || getWebPort()
    out(
      launched.alreadyRunning
        ? `${webStatusText({ running: true, sessionOwned: false, port, url: launched.url })} (not owned by this session)`
        : `${webStatusText({ running: true, sessionOwned: true, port, url: launched.url })} · holding until ctrl+c`,
    )
  } catch (e) {
    err(`web UI  ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Run one slash line. Returns a follow-up user message when the slash kicks a turn
 * (e.g. /mission continuation) — caller should run the agent loop once with it.
 */
export async function runSlashCli(line: string, opts: SlashCliOpts): Promise<{ kick?: string }> {
  const { workspace, sessionId, history, spec } = opts
  const host = createNativeHost(workspace)
  const r = runSlash(line, { workspace, sessionId })

  if (r.quit) return {}

  if (r.openUrl) {
    const href = normalizeOpenUrl(r.openUrl)
    if (!href) {
      out("usage: /url <host|http(s)|file|mailto>  (bare hosts get https://)")
      return {}
    }
    const ok = await host.openUrl(href)
    out(ok ? `opened  ${href}` : `could not open  ${href}`)
    return {}
  }

  if (r.web) {
    await applyWeb(r, workspace)
    return {}
  }

  if (r.copy !== undefined) {
    let text = typeof r.copy === "string" ? r.copy : ""
    if (!text) {
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]!
        if (m.role === "assistant" && m.content.trim()) {
          text = m.content
          break
        }
      }
    }
    if (!text.trim()) {
      out("nothing to copy")
      return {}
    }
    const ok = await host.writeClipboard(text)
    out(ok ? `copied  ${text.length} chars` : "clipboard unavailable")
    return {}
  }

  if (r.refine) {
    try {
      if (r.refine.deployApprove) {
        const result = await approvePendingDeploy("user")
        out(formatRefinementNotice(result))
      } else if (r.refine.rollbackId) {
        const result = await runRefineRollback(r.refine.rollbackId, sessionId, "user")
        out(formatRefinementNotice(result))
      } else {
        const refined = await runRefine({
          history,
          sessionId,
          instructions: r.refine.instructions,
          global: r.refine.global,
          force: r.refine.force,
          source: "user",
        })
        if (refined.kind === "pending_deploy") {
          out(refined.diff)
          out('staged — approve with: axi runline "/refine deploy approve"')
        } else {
          out(formatRefinementNotice(refined.result))
        }
      }
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    }
    return {}
  }

  if (r.undo) {
    out("undo  nothing to undo in runline (single turn)")
    return {}
  }

  if (r.newChat || r.rename || r.open || r.delete || r.deleteAll) {
    out("chat navigation is TTY-only — use axi chat / axi")
    return {}
  }

  if (r.chats) {
    const all = listChats(workspace)
    out(
      all.length
        ? all.map((c) => `${c.id === spec.id ? "*" : " "} ${c.id}  ${c.name}`).join("\n")
        : "no chats",
    )
    return {}
  }

  if (r.context) {
    const snap = measureContext(workspace, history, contextWindow())
    const parts = snap.parts.map((p) => `  ${p.label.padEnd(8)}  ${p.tokens}`).join("\n")
    out(`${snap.line}\n${parts}`)
    return {}
  }

  if (r.history) {
    out("history empty  (runline has no input-line history)")
    return {}
  }

  if (r.status) {
    out(statusText(workspace, spec, history))
    return {}
  }

  if (r.doctor) {
    const { checks } = await runDoctor(workspace)
    out(formatDoctor(checks))
    return {}
  }

  if (r.spawn) {
    out(formatAgents(workspace, sessionId))
    return {}
  }

  if (r.agentsView) {
    out(formatAgentsRoster(workspace, sessionId))
    return {}
  }

  if (r.arlView) {
    out("arl browse is TTY-only — use /arl list [query] or axi")
    return {}
  }

  if (r.spawnList) {
    out(formatAgents(workspace, sessionId))
    return {}
  }

  if (r.spawnRun) {
    try {
      const a = await startAgent(workspace, r.spawnRun, { parentId: sessionId })
      out(`spawned  ${a.id}  ${a.status}  ${a.name}`)
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    }
    return {}
  }

  if (r.spawnLog) {
    try {
      out(agentLog(workspace, r.spawnLog))
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    }
    return {}
  }

  if (r.spawnCancel) {
    try {
      const a = await cancelAgent(workspace, r.spawnCancel, {
        why: r.spawnCancelWhy || "canceled via /spawn cancel",
        sessionId,
      })
      out(`canceled  ${a.id}  ${a.status}\n${a.receipt.text}`)
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    }
    return {}
  }

  if (r.openKey || r.promptKey) {
    out("paste keys via: axi provider <name>")
    return {}
  }

  if (r.factoryStart) {
    try {
      const state = await startFactory({
        sessionId,
        workspace,
        machine: r.factoryStart,
      })
      out(formatFactoryStatus(state))
    } catch (e) {
      err(`factory failed  ${e instanceof Error ? e.message : String(e)}`)
    }
    return {}
  }

  if (r.decisionDecide) {
    try {
      const ans = await decide(r.decisionDecide)
      out(formatDecideAnswer(ans))
    } catch (e) {
      err(`decision failed  ${e instanceof Error ? e.message : String(e)}`)
    }
    return {}
  }

  if (r.compact) {
    out("compact needs chat history — use axi chat")
    return {}
  }

  if (r.image) {
    out("image attach is TTY-only — use axi chat · /image")
    return {}
  }

  if (r.text) out(r.text)

  if (r.missionKick) return { kick: r.missionKick }

  return {}
}

export function isSlashLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith("/") && t !== "/"
}
