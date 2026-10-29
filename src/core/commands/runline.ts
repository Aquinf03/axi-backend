/** `axi runline "<prompt>"` — one chat turn, no TTY UI. Same agent loop as normal chat. */

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

export async function runline(argv: string[]): Promise<void> {
  let workspace: string
  let prompt: string
  try {
    ;({ workspace, prompt } = parseRunline(argv))
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
    return
  }

  const spec = createChat(workspace)
  const tools: { name: string; args: string }[] = []
  const streamed = { value: false }
  const host = createAskHost({ workspace, streamed }, tools)

  const history: ChatMsg[] = withArlDigest([{ role: "user", content: prompt }], {
    recentTexts: [prompt],
  })
  beginTrajectoryTurn({ sessionId: spec.id, userText: prompt })

  setArlSessionId(spec.id)
  let reply = ""
  try {
    const out = await runTurn(history, host)
    reply = out.text
  } finally {
    setArlSessionId(undefined)
  }

  history.push({ role: "assistant", content: reply })
  try {
    const flushed = await flushArlAfterTurn(history, spec.id)
    if (flushed?.notice) stderr.write(`${flushed.notice}\n`)
  } catch (err) {
    stderr.write(`refine failed  ${err instanceof Error ? err.message : String(err)}\n`)
  }

  try {
    closeTrajectoryTurn({ sessionId: spec.id, assistantText: reply })
  } catch {
    /* trajectory optional */
  }

  saveChat(workspace, spec, history)
  try {
    await nameChat(workspace, spec, prompt, reply, history)
  } catch {
    /* naming is best-effort */
  }

  if (streamed.value) {
    if (!reply.endsWith("\n")) stdout.write("\n")
    return
  }
  stdout.write(renderMarkdown(reply.trim(), undefined, { baseDir: workspace }) + "\n")
}
