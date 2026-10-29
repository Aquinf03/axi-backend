/** `axi runline "<prompt>"` — one chat turn or slash, no TTY UI. Same path as normal chat. */

import { existsSync, statSync } from "node:fs"
import { stdout, stderr } from "node:process"
import path from "node:path"
import { runTurn, type ChatMsg } from "../agent/agent-loop.js"
import { flushArlAfterTurn, setArlSessionId, withArlDigest } from "../arl.js"
import { createAskHost } from "../hosts.js"
import { createChat, nameChat, saveChat } from "../session.js"
import { beginTrajectoryTurn, closeTrajectoryTurn } from "../trajectory.js"
import { renderMarkdown } from "../../ui/markdown.js"
import { isTrain } from "../schema.js"
import { isSlashLine, runSlashCli } from "./slash-cli.js"
import { hasSessionOwnedWeb, holdSessionOwnedWeb, stopSessionOwnedWeb } from "./web.js"

const USAGE = 'usage: axi runline [dir] "<prompt>"'

function isWorkspaceDir(raw: string): boolean {
  const p = path.resolve(raw)
  if (isTrain(p)) return true
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

function parseRunline(argv: string[]): { workspace: string; prompt: string } {
  for (const a of argv) {
    if (a.startsWith("-")) throw new Error(`unknown flag: ${a}\n${USAGE}`)
  }
  if (!argv.length) throw new Error(USAGE)

  let workspace = path.resolve(".")
  let words = [...argv]
  if (argv.length >= 2 && isWorkspaceDir(argv[0]!)) {
    workspace = path.resolve(argv[0]!)
    words = argv.slice(1)
  }
  const prompt = words.join(" ").trim()
  if (!prompt) throw new Error(USAGE)
  return { workspace, prompt }
}

async function runAgentOnce(opts: {
  workspace: string
  sessionId: string
  prompt: string
  history: ChatMsg[]
}): Promise<{ reply: string; streamed: boolean }> {
  const tools: { name: string; args: string }[] = []
  const streamed = { value: false }
  const host = createAskHost({ workspace: opts.workspace, streamed }, tools)

  const withDigest = withArlDigest(
    [...opts.history, { role: "user" as const, content: opts.prompt }],
    { recentTexts: [opts.prompt] },
  )
  opts.history.length = 0
  opts.history.push(...withDigest)

  beginTrajectoryTurn({ sessionId: opts.sessionId, userText: opts.prompt })
  setArlSessionId(opts.sessionId)
  let reply = ""
  try {
    const out = await runTurn(opts.history, host)
    reply = out.text
  } finally {
    setArlSessionId(undefined)
  }

  opts.history.push({ role: "assistant", content: reply })
  try {
    const flushed = await flushArlAfterTurn(opts.history, opts.sessionId)
    if (flushed?.notice) stderr.write(`${flushed.notice}\n`)
  } catch (e) {
    stderr.write(`refine failed  ${e instanceof Error ? e.message : String(e)}\n`)
  }

  try {
    closeTrajectoryTurn({ sessionId: opts.sessionId, assistantText: reply })
  } catch {
    /* optional */
  }

  return { reply, streamed: streamed.value }
}

export async function runline(argv: string[]): Promise<void> {
  let workspace: string
  let prompt: string
  try {
    ;({ workspace, prompt } = parseRunline(argv))
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
    return
  }

  const spec = createChat(workspace)
  const history: ChatMsg[] = []

  try {
    if (isSlashLine(prompt)) {
      const slash = await runSlashCli(prompt, {
        workspace,
        sessionId: spec.id,
        history,
        spec,
      })
      if (slash.text) stdout.write(slash.text.endsWith("\n") ? slash.text : `${slash.text}\n`)
      if (slash.kick) {
        const { reply, streamed } = await runAgentOnce({
          workspace,
          sessionId: spec.id,
          prompt: slash.kick,
          history,
        })
        saveChat(workspace, spec, history)
        try {
          await nameChat(workspace, spec, slash.kick, reply, history)
        } catch {
          /* best-effort */
        }
        if (streamed) {
          if (!reply.endsWith("\n")) stdout.write("\n")
        } else {
          stdout.write(renderMarkdown(reply.trim(), undefined, { baseDir: workspace }) + "\n")
        }
      } else {
        saveChat(workspace, spec, history)
      }
    } else {
      const { reply, streamed } = await runAgentOnce({
        workspace,
        sessionId: spec.id,
        prompt,
        history,
      })
      saveChat(workspace, spec, history)
      try {
        await nameChat(workspace, spec, prompt, reply, history)
      } catch {
        /* best-effort */
      }
      if (streamed) {
        if (!reply.endsWith("\n")) stdout.write("\n")
      } else {
        stdout.write(renderMarkdown(reply.trim(), undefined, { baseDir: workspace }) + "\n")
      }
    }

    // /web on keeps this process in the foreground until ctrl+c / ctrl+z (not detached).
    if (hasSessionOwnedWeb()) {
      await holdSessionOwnedWeb()
    }
  } catch (e) {
    stopSessionOwnedWeb()
    throw e
  }
}
