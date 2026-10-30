/**
 * `/config reload` — force re-read of every on-disk config layer and
 * return a live effective snapshot (loaders already hit the filesystem;
 * this is the explicit "pick up edits I made outside axi" command).
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { shortPath } from "../paths.js"
import { axiHome } from "../home.js"
import {
  configGateEnabled,
  configGateStatusText,
  pendingConfigPath,
  pendingConfigStatusText,
} from "./pending.js"
import { loadProfileConfig, settingsPath } from "./profile.js"
import { ignoredProjectKeys, loadProjectConfig, projectConfigPath } from "./project.js"
import { resolveConfig } from "./resolve.js"

export type ConfigReloadBits = {
  /** Active provider label e.g. `ollama/qwen2.5-coder:14b`. */
  provider?: string
  sound?: boolean
  notify?: boolean
  temperature?: string
  webPort?: number
  aquinLogin?: boolean
  /** Extra blocks already formatted (arl status, etc.). */
  extras?: string[]
}

function row(k: string, v: string): string {
  return `  ${k.padEnd(14)}  ${v}`
}

function fileState(p: string): string {
  return existsSync(p) ? shortPath(p) : `${shortPath(p)}  (missing)`
}

/**
 * Re-read profile, project, gate, pending — then format a status board.
 * Pass provider / arl bits from the gateway (avoids config↔arl cycles).
 */
export function formatConfigReload(workspace: string, bits: ConfigReloadBits = {}): string {
  // Force disk reads.
  loadProfileConfig()
  loadProjectConfig(workspace)
  const resolved = resolveConfig(workspace)
  configGateEnabled()

  const providersPath = path.join(axiHome(), "config.json")
  const ignored = ignoredProjectKeys(workspace)
  const lines = [
    "config  reloaded",
    row("workspace", shortPath(workspace)),
    row("axi home", shortPath(axiHome())),
    "",
    "files",
    row("providers", fileState(providersPath)),
    row("settings", fileState(settingsPath())),
    row("project", fileState(projectConfigPath(workspace))),
    row("pending", fileState(pendingConfigPath())),
    "",
    "effective",
    row("provider", bits.provider?.trim() || "none"),
    row("mode", `${resolved.permission_mode}  (${resolved.sources.permission_mode})`),
    row("max steps", `${resolved.max_agent_steps}  (${resolved.sources.max_agent_steps})`),
    row(
      "tool bytes",
      `${resolved.max_tool_result_bytes}  (${resolved.sources.max_tool_result_bytes})`,
    ),
  ]
  if (resolved.context != null) {
    lines.push(
      row("context", `${resolved.context}%  (${resolved.sources.context ?? "project"})`),
    )
  }
  if (bits.temperature != null) lines.push(row("temp", bits.temperature))
  if (bits.sound != null) lines.push(row("sound", bits.sound ? "on" : "off"))
  if (bits.notify != null) lines.push(row("notify", bits.notify ? "on" : "off"))
  if (bits.webPort != null) lines.push(row("web port", String(bits.webPort)))
  if (bits.aquinLogin != null) {
    lines.push(row("aquin", bits.aquinLogin ? "signed in" : "signed out"))
  }

  for (const block of bits.extras ?? []) {
    const t = block.trim()
    if (!t) continue
    lines.push("")
    lines.push(t)
  }

  lines.push("")
  lines.push(configGateStatusText())
  const pending = pendingConfigStatusText().trim()
  if (pending) {
    lines.push("")
    lines.push(pending)
  }
  if (ignored.length) {
    lines.push("")
    lines.push(`ignored in .axi.json  ${ignored.join(", ")}`)
  }
  return lines.join("\n")
}
