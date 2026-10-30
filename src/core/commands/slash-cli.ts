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
  arlMenuRows,
  formatArlBoard,
  formatArlEntryDetail,
  formatRefinementNotice,
  runRefine,
  runRefineRollback,
} from "../arl.js"
import { measureContext } from "../agent/context.js"
import { loadImage, type ChatImage } from "../agent/image.js"
import { agentLog, cancelAgent, formatAgents, startAgent } from "../agent/spawn.js"
import { formatDoctor, runDoctor } from "./doctor.js"
import { decide, formatDecideAnswer } from "../decision.js"
import { formatFactoryStatus, startFactory } from "../factory.js"
import { createNativeHost, normalizeOpenUrl } from "../hosts.js"
import {
  createChat,
  deleteAllChats,
  deleteChat,
  listChats,
  loadMessages,
  loadSpec,
  renameChat,
  type ChatSpec,
} from "../session.js"
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

/** Option row for WebUI interactive Chat panel (mirrors TTY menu labels). */
export type InteractiveOption = {
  id: string
  label: string
  hint?: string
  disabled?: boolean
}

export type InteractiveSpec = {
  kind:
    | "chats"
    | "chat"
    | "chat-delete"
    | "chat-rename"
    | "arl"
    | "arl-entry"
    | "image-attach"
  prompt: string
  options: InteractiveOption[]
  input?: { value?: string; placeholder?: string }
  context?: Record<string, string>
}

export type SlashAction =
  | { type: "new-chat"; id: string; name: string }
  | {
      type: "open-chat"
      id: string
      name: string
      messages: { role: "user" | "assistant"; content: string }[]
    }
  | { type: "rename-chat"; id: string; name: string }
  | { type: "delete-chat"; id: string }
  | { type: "delete-all-chats"; count: number; id: string; name: string }
  | { type: "attach-image"; image: ChatImage; caption?: string }
  | { type: "arl-detail"; text: string }

export type SlashCliResult = {
  text: string
  /** Follow-up user message — caller should run one agent turn. */
  kick?: string
  /** WebUI Chat panel: exact options + prompt (Cancel / OK). */
  interactive?: InteractiveSpec
  /** Side-effect the WebUI should apply. */
  action?: SlashAction
}

export type InteractiveResolve = {
  kind: InteractiveSpec["kind"]
  optionId?: string
  input?: string
  context?: Record<string, string>
  /** Filter query for arl / chats browse. */
  query?: string
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

/** Store chat, or the live WebUI/session tab when it is not persisted yet. */
function findChatFocus(
  workspace: string,
  chatId: string,
  session: { id: string; name: string },
): { id: string; name: string; ephemeral: boolean } | null {
  const hit = listChats(workspace).find((c) => c.id === chatId)
  if (hit) return { id: hit.id, name: hit.name, ephemeral: false }
  if (chatId && chatId === session.id) {
    return { id: session.id, name: session.name || "new chat", ephemeral: true }
  }
  return null
}

function chatsInteractive(
  workspace: string,
  current: { id: string; name: string },
  query = "",
): InteractiveSpec {
  const q = query.trim().toLowerCase()
  const all = listChats(workspace).filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q),
  )
  // WebUI tabs often use ephemeral ids (c_…) that are not in ~/.axi/chats yet.
  if (
    current.id &&
    !all.some((c) => c.id === current.id) &&
    (!q || current.name.toLowerCase().includes(q) || current.id.includes(q))
  ) {
    all.unshift({
      id: current.id,
      name: current.name || "new chat",
      created: "",
      updated: "",
      workspace_root: workspace,
      train: workspace,
    })
  }
  const options: InteractiveOption[] = []
  if (!q) options.push({ id: "new", label: "new chat", hint: "" })
  for (const c of all) {
    options.push({
      id: c.id,
      label: c.name,
      hint: c.id === current.id ? `${c.id}  ←` : c.id,
    })
  }
  options.push({ id: "back", label: "back", hint: "" })
  return { kind: "chats", prompt: "chats", options, input: { value: query, placeholder: "filter" } }
}

function chatFocusInteractive(focus: { id: string; name: string }): InteractiveSpec {
  return {
    kind: "chat",
    prompt: focus.name,
    options: [
      { id: "open", label: "open", hint: focus.name },
      { id: "rename", label: "rename", hint: "type a new name" },
      { id: "delete", label: "delete", hint: focus.id },
      { id: "back", label: "back", hint: "" },
    ],
    context: { chatId: focus.id, chatName: focus.name },
  }
}

function chatDeleteInteractive(focus: { id: string; name: string }, all = false, n = 1): InteractiveSpec {
  return {
    kind: "chat-delete",
    prompt: all
      ? `delete all ${n} chat${n === 1 ? "" : "s"} for this train?`
      : "delete this chat?",
    options: [
      { id: "delete", label: "delete", hint: all ? `${n}` : focus.name },
      // Match TTY slash confirm (askDelete): delete · keep
      { id: "keep", label: "keep", hint: "" },
    ],
    context: {
      chatId: focus.id,
      chatName: focus.name,
      ...(all ? { deleteAll: "1" } : {}),
    },
  }
}

function arlInteractive(sessionId: string, query = ""): InteractiveSpec {
  const rows = arlMenuRows(sessionId, query)
  return {
    kind: "arl",
    prompt: "harness",
    options: [
      ...rows.map((a) => ({
        id: a.id,
        label: a.label,
        hint: a.hint,
        disabled: a.section === "header" || a.section === "meta" || a.id.startsWith("_"),
      })),
      { id: "back", label: "back", hint: "" },
    ],
    input: { value: query, placeholder: "filter" },
  }
}

function matchChats(workspace: string, q: string): ChatSpec[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return listChats(workspace).filter(
    (c) => c.id === q.trim() || c.id.startsWith(needle) || c.name.toLowerCase().includes(needle),
  )
}

function openChatAction(workspace: string, id: string): SlashAction {
  const spec = loadSpec(workspace, id)
  const msgs = loadMessages(workspace, id)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
  return { type: "open-chat", id: spec.id, name: spec.name, messages: msgs }
}

/**
 * Apply an interactive panel OK (WebUI Cancel/OK).
 */
export async function resolveInteractive(
  req: InteractiveResolve,
  opts: SlashCliOpts,
): Promise<SlashCliResult> {
  const { workspace, sessionId, history, spec } = opts
  const optionId = req.optionId ?? ""
  const ctx = req.context ?? {}

  const sessionFocus = { id: sessionId, name: spec.name || "new chat" }

  if (req.kind === "chats") {
    if (optionId === "back") return { text: "" }
    if (!optionId) {
      return {
        text: "",
        interactive: chatsInteractive(workspace, sessionFocus, req.query ?? ""),
      }
    }
    if (optionId === "new") {
      const created = createChat(workspace)
      return {
        text: `new chat  ${created.id}`,
        action: { type: "new-chat", id: created.id, name: created.name },
      }
    }
    const focus = findChatFocus(workspace, optionId, sessionFocus)
    if (!focus) return { text: `no chat  ${optionId}` }
    return { text: "", interactive: chatFocusInteractive(focus) }
  }

  if (req.kind === "chat") {
    const chatId = ctx.chatId || optionId
    const focus =
      findChatFocus(workspace, chatId, sessionFocus) ||
      (ctx.chatId
        ? { id: ctx.chatId, name: ctx.chatName || ctx.chatId, ephemeral: true }
        : null)
    if (!focus) return { text: `no chat  ${chatId}` }
    if (optionId === "back") {
      return { text: "", interactive: chatsInteractive(workspace, sessionFocus) }
    }
    if (optionId === "open") {
      if (focus.ephemeral) {
        return {
          text: `opened  ${focus.name}  ${focus.id}`,
          action: {
            type: "open-chat",
            id: focus.id,
            name: focus.name,
            messages: history
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
          },
        }
      }
      return {
        text: `opened  ${focus.name}  ${focus.id}`,
        action: openChatAction(workspace, focus.id),
      }
    }
    if (optionId === "rename") {
      return {
        text: "",
        interactive: {
          kind: "chat-rename",
          prompt: "name: ",
          options: [],
          input: {
            value: focus.name === "new chat" ? "" : focus.name,
            placeholder: "type a new name",
          },
          context: { chatId: focus.id, chatName: focus.name },
        },
      }
    }
    if (optionId === "delete") {
      return { text: "", interactive: chatDeleteInteractive(focus) }
    }
    return { text: "" }
  }

  if (req.kind === "chat-rename") {
    const name = (req.input ?? "").replace(/\s+/g, " ").trim()
    if (!name) return { text: "name required" }
    const chatId = ctx.chatId || sessionId
    try {
      const target = loadSpec(workspace, chatId)
      const msgs = chatId === sessionId ? history : loadMessages(workspace, chatId)
      const next = renameChat(workspace, target, name, msgs)
      return {
        text: `renamed  ${next.name}  ${next.id}`,
        action: { type: "rename-chat", id: next.id, name: next.name },
      }
    } catch {
      // Ephemeral WebUI tab — rename locally only.
      return {
        text: `renamed  ${name}  ${chatId}`,
        action: { type: "rename-chat", id: chatId, name },
      }
    }
  }

  if (req.kind === "chat-delete") {
    if (optionId === "keep" || optionId === "cancel" || !optionId) return { text: "kept" }
    if (optionId !== "delete") return { text: "kept" }
    if (ctx.deleteAll === "1") {
      const n = listChats(workspace).length
      if (!n) return { text: "no chats" }
      const gone = deleteAllChats(workspace)
      const created = createChat(workspace)
      return {
        text: `deleted  ${gone} chat${gone === 1 ? "" : "s"}`,
        action: {
          type: "delete-all-chats",
          count: gone,
          id: created.id,
          name: created.name,
        },
      }
    }
    const chatId = ctx.chatId || sessionId
    const chatName = ctx.chatName || chatId
    try {
      const target = loadSpec(workspace, chatId)
      deleteChat(workspace, chatId)
      return {
        text: `deleted  ${target.name}  ${target.id}`,
        action: { type: "delete-chat", id: chatId },
      }
    } catch {
      // Ephemeral WebUI tab (c_…) — close the tab even though it was never persisted.
      return {
        text: `deleted  ${chatName}  ${chatId}`,
        action: { type: "delete-chat", id: chatId },
      }
    }
  }

  if (req.kind === "arl") {
    if (optionId === "back" || !optionId) {
      if (req.query != null && req.query !== "") {
        return { text: "", interactive: arlInteractive(sessionId, req.query) }
      }
      return { text: "" }
    }
    return {
      text: "",
      interactive: {
        kind: "arl-entry",
        prompt: optionId,
        options: [
          { id: "show", label: "show", hint: optionId },
          { id: "back", label: "back", hint: "" },
        ],
        context: { arlId: optionId },
      },
    }
  }

  if (req.kind === "arl-entry") {
    if (optionId === "back") return { text: "", interactive: arlInteractive(sessionId) }
    if (optionId === "show") {
      const rowId = ctx.arlId || ""
      const detail = formatArlEntryDetail(sessionId, rowId)
      return { text: detail, action: { type: "arl-detail", text: detail } }
    }
    return { text: "" }
  }

  if (req.kind === "image-attach") {
    const raw = (req.input ?? "").trim()
    if (!raw) return { text: "usage: /image <path> [text]" }
    const sp = raw.search(/\s/)
    const file = sp < 0 ? raw : raw.slice(0, sp)
    const caption = sp < 0 ? "" : raw.slice(sp).trim()
    try {
      const img = loadImage(workspace, file)
      return {
        text: `attached  ${img.path}`,
        action: {
          type: "attach-image",
          image: img,
          ...(caption ? { caption } : {}),
        },
      }
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e) }
    }
  }

  return { text: "" }
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
  const done = (
    kick?: string,
    extra?: Pick<SlashCliResult, "interactive" | "action">,
  ): SlashCliResult => ({
    text: lines.join("\n"),
    ...(kick ? { kick } : {}),
    ...extra,
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

  if (r.newChat) {
    const created = createChat(workspace)
    push(`new chat  ${created.id}`)
    return done(undefined, {
      action: { type: "new-chat", id: created.id, name: created.name },
    })
  }

  if (r.rename) {
    if (r.rename !== true && String(r.rename).trim()) {
      const name = String(r.rename).replace(/\s+/g, " ").trim()
      try {
        const next = renameChat(workspace, spec, name, history)
        push(`renamed  ${next.name}  ${next.id}`)
        return done(undefined, {
          action: { type: "rename-chat", id: next.id, name: next.name },
        })
      } catch (e) {
        push(e instanceof Error ? e.message : String(e))
        return done()
      }
    }
    return done(undefined, {
      interactive: {
        kind: "chat-rename",
        prompt: "name: ",
        options: [],
        input: {
          value: spec.name === "new chat" ? "" : spec.name,
          placeholder: "type a new name",
        },
        context: { chatId: spec.id, chatName: spec.name },
      },
    })
  }

  if (r.open !== undefined) {
    const q = typeof r.open === "string" ? r.open.trim() : ""
    if (!q) {
      return done(undefined, {
        interactive: chatsInteractive(workspace, { id: sessionId, name: spec.name }),
      })
    }
    const hits = matchChats(workspace, q)
    if (!hits.length) {
      push(`no chat  ${q}`)
      return done()
    }
    if (hits.length > 1) {
      push(hits.map((c) => `  ${c.id}  ${c.name}`).join("\n"))
      return done(undefined, {
        interactive: chatsInteractive(workspace, { id: sessionId, name: spec.name }, q),
      })
    }
    const hit = hits[0]!
    push(`opened  ${hit.name}  ${hit.id}`)
    return done(undefined, { action: openChatAction(workspace, hit.id) })
  }

  if (r.deleteAll) {
    const n = listChats(workspace).length
    if (!n) {
      push("no chats")
      return done()
    }
    return done(undefined, {
      interactive: chatDeleteInteractive(
        { id: spec.id, name: spec.name },
        true,
        n,
      ),
    })
  }

  if (r.delete) {
    const id = r.delete === true ? spec.id : matchChats(workspace, r.delete)[0]?.id
    if (!id) {
      push("no chat to delete")
      return done()
    }
    let focus = { id, name: id }
    try {
      const s = loadSpec(workspace, id)
      focus = { id: s.id, name: s.name }
    } catch {
      /* use id */
    }
    return done(undefined, { interactive: chatDeleteInteractive(focus) })
  }

  if (r.chats) {
    const all = listChats(workspace)
    push(
      all.length
        ? all.map((c) => `${c.id === spec.id ? "*" : " "} ${c.id}  ${c.name}`).join("\n")
        : "no chats",
    )
    return done(undefined, {
      interactive: chatsInteractive(workspace, { id: sessionId, name: spec.name }),
    })
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
    push(formatArlBoard(sessionId))
    return done(undefined, { interactive: arlInteractive(sessionId) })
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
    try {
      const img = loadImage(workspace, r.image.path)
      push(`attached  ${img.path}`)
      return done(undefined, {
        action: {
          type: "attach-image",
          image: img,
          ...(r.image.caption ? { caption: r.image.caption } : {}),
        },
      })
    } catch (e) {
      push(e instanceof Error ? e.message : String(e))
      return done()
    }
  }

  if (r.text) {
    // Bare `/image` → interactive path prompt for WebUI.
    if (/^usage:\s*\/image\b/i.test(r.text.trim())) {
      return done(undefined, {
        interactive: {
          kind: "image-attach",
          prompt: "attach image",
          options: [],
          input: { placeholder: "path · png jpg gif webp  [caption]" },
        },
      })
    }
    push(r.text)
  }

  if (r.missionKick) return done(r.missionKick)

  return done()
}

export function isSlashLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith("/") && t !== "/"
}
