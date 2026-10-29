/**
 * Apply a slash command headlessly (axi runline / web bridge).
 * Same runSlash contract as TTY chat; returns text instead of painting the TUI.
 */

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

export type SlashCliResult = {
  text: string
  /** Follow-up user message — caller should run one agent turn. */
  kick?: string
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

async function applyWeb(r: SlashResult, workspace: string): Promise<string> {
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
    return webStatusText(await webRuntimeStatusAsync())
  }
  if (r.web === "off") {
    const before = await webRuntimeStatusAsync()
    if (!before.running) return webStatusText(before)
    if (!before.sessionOwned) {
      return `${webStatusText(before)}\nweb UI  not owned by this session — stop the process on :${before.port} yourself`
    }
    stopSessionOwnedWeb()
    return webStatusText(runtimeStatus())
  }
  const lines: string[] = []
  if (r.webPort != null) {
    try {
      const saved = setWebPort(r.webPort)
      if (saved.includes("\n\n")) lines.push(saved)
    } catch (e) {
      return `web UI  ${e instanceof Error ? e.message : String(e)}`
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
    lines.push(
      launched.alreadyRunning
        ? `${webStatusText({ running: true, sessionOwned: false, port, url: launched.url })} (not owned by this session)`
        : `${webStatusText({ running: true, sessionOwned: true, port, url: launched.url })} · holding until ctrl+c`,
    )
  } catch (e) {
    return `web UI  ${e instanceof Error ? e.message : String(e)}`
  }
  return lines.join("\n")
}

/**
 * Run one slash line. Returns reply text (+ optional kick for a follow-up agent turn).
 */
export async function runSlashCli(line: string, opts: SlashCliOpts): Promise<SlashCliResult> {
  const { workspace, sessionId, history, spec } = opts
  const host = createNativeHost(workspace)
  const r = runSlash(line, { workspace, sessionId })
  const lines: string[] = []
  const push = (t: string) => {
    const s = t.replace(/\n+$/, "")
    if (s) lines.push(s)
  }
  const done = (kick?: string): SlashCliResult => ({
    text: lines.join("\n"),
    ...(kick ? { kick } : {}),
  })

  if (r.quit) {
    push("exit")
    return done()
  }

  if (r.openUrl) {
    const href = normalizeOpenUrl(r.openUrl)
    if (!href) {
      push("usage: /url <host|http(s)|file|mailto>  (bare hosts get https://)")
      return done()
    }
    const ok = await host.openUrl(href)
    push(ok ? `opened  ${href}` : `could not open  ${href}`)
    return done()
  }

  if (r.web) {
    push(await applyWeb(r, workspace))
    return done()
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
      push("nothing to copy")
      return done()
    }
    const ok = await host.writeClipboard(text)
    push(ok ? `copied  ${text.length} chars` : "clipboard unavailable")
    return done()
  }

  if (r.refine) {
    try {
      if (r.refine.deployApprove) {
        push(formatRefinementNotice(await approvePendingDeploy("user")))
      } else if (r.refine.rollbackId) {
        push(formatRefinementNotice(await runRefineRollback(r.refine.rollbackId, sessionId, "user")))
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
          push(refined.diff)
          push('staged — approve with: axi runline "/refine deploy approve"')
        } else {
          push(formatRefinementNotice(refined.result))
        }
      }
    } catch (e) {
      push(e instanceof Error ? e.message : String(e))
    }
    return done()
  }

  if (r.undo) {
    push("undo  nothing to undo here (no prior turn in this request)")
    return done()
  }

  if (r.newChat || r.rename || r.open || r.delete || r.deleteAll) {
    push("chat navigation is TTY-only — use axi chat / axi")
    return done()
  }

  if (r.chats) {
    const all = listChats(workspace)
    push(
      all.length
        ? all.map((c) => `${c.id === spec.id ? "*" : " "} ${c.id}  ${c.name}`).join("\n")
        : "no chats",
    )
    return done()
  }

  if (r.context) {
    const snap = measureContext(workspace, history, contextWindow())
    const parts = snap.parts.map((p) => `  ${p.label.padEnd(8)}  ${p.tokens}`).join("\n")
    push(`${snap.line}\n${parts}`)
    return done()
  }

  if (r.history) {
    push("history empty  (no input-line history in this surface)")
    return done()
  }

  if (r.status) {
    push(statusText(workspace, spec, history))
    return done()
  }

  if (r.doctor) {
    const { checks } = await runDoctor(workspace)
    push(formatDoctor(checks))
    return done()
  }

  if (r.spawn) {
    push(formatAgents(workspace, sessionId))
    return done()
  }

  if (r.agentsView) {
    push(formatAgentsRoster(workspace, sessionId))
    return done()
  }

  if (r.arlView) {
    push("arl browse is TTY-only — use /arl list [query] or axi")
    return done()
  }

  if (r.spawnList) {
    push(formatAgents(workspace, sessionId))
    return done()
  }

  if (r.spawnRun) {
    try {
      const a = await startAgent(workspace, r.spawnRun, { parentId: sessionId })
      push(`spawned  ${a.id}  ${a.status}  ${a.name}`)
    } catch (e) {
      push(e instanceof Error ? e.message : String(e))
    }
    return done()
  }

  if (r.spawnLog) {
    try {
      push(agentLog(workspace, r.spawnLog))
    } catch (e) {
      push(e instanceof Error ? e.message : String(e))
    }
    return done()
  }

  if (r.spawnCancel) {
    try {
      const a = await cancelAgent(workspace, r.spawnCancel, {
        why: r.spawnCancelWhy || "canceled via /spawn cancel",
        sessionId,
      })
      push(`canceled  ${a.id}  ${a.status}\n${a.receipt.text}`)
    } catch (e) {
      push(e instanceof Error ? e.message : String(e))
    }
    return done()
  }

  if (r.openKey || r.promptKey) {
    push("paste keys via: axi provider <name>")
    return done()
  }

  if (r.factoryStart) {
    try {
      const state = await startFactory({
        sessionId,
        workspace,
        machine: r.factoryStart,
      })
      push(formatFactoryStatus(state))
    } catch (e) {
      push(`factory failed  ${e instanceof Error ? e.message : String(e)}`)
    }
    return done()
  }

  if (r.decisionDecide) {
    try {
      push(formatDecideAnswer(await decide(r.decisionDecide)))
    } catch (e) {
      push(`decision failed  ${e instanceof Error ? e.message : String(e)}`)
    }
    return done()
  }

  if (r.compact) {
    push("compact needs a full TTY chat session — use axi")
    return done()
  }

  if (r.image) {
    push("image attach is TTY-only — use axi chat · /image")
    return done()
  }

  if (r.text) push(r.text)

  if (r.missionKick) return done(r.missionKick)

  return done()
}

export function isSlashLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith("/") && t !== "/"
}
