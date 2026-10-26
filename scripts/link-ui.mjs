#!/usr/bin/env node
/**
 * Before tsc: point src/ui at the monorepo TTY UI when available, else install stubs.
 *
 * Detection order:
 *   1. AXI_UI_PATH (absolute or relative to cwd)
 *   2. ../src/ui when ../.axi_root exists, or ../src/ui/chat-ui.ts exists alone
 *
 * Stubs live in scripts/ui-stubs/ and are the committed default under src/ui/.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const uiDest = path.join(pkgRoot, "src", "ui")
const uiBak = path.join(pkgRoot, "src", "ui.bak")
const distUi = path.join(pkgRoot, "dist", "ui")
const stubsDir = path.join(pkgRoot, "scripts", "ui-stubs")
const uiGitState = path.join(pkgRoot, "scripts", "ui-git-state.sh")

function runUiGitState(cmd) {
  const r = spawnSync("bash", [uiGitState, cmd], { cwd: pkgRoot, encoding: "utf8" })
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim()
    console.warn(`link-ui: ui-git-state ${cmd} failed${detail ? `: ${detail}` : ""}`)
  } else if (r.stdout?.trim()) {
    console.log(r.stdout.trim())
  }
}

function hasChatUi(dir) {
  return (
    fs.existsSync(path.join(dir, "chat-ui.ts")) ||
    fs.existsSync(path.join(dir, "chat-ui.js"))
  )
}

function resolveFrontendUi() {
  if (process.env.AXI_UI_PATH) {
    const resolved = path.resolve(process.cwd(), process.env.AXI_UI_PATH)
    if (!hasChatUi(resolved)) {
      throw new Error(`AXI_UI_PATH=${process.env.AXI_UI_PATH} has no chat-ui.ts/js`)
    }
    return resolved
  }

  const parent = path.join(pkgRoot, "..")
  const candidate = path.join(parent, "src", "ui")
  const marked = fs.existsSync(path.join(parent, ".axi_root"))
  if (hasChatUi(candidate)) return candidate
  if (marked) {
    console.warn("link-ui: ../.axi_root present but ../src/ui/chat-ui.* missing — using stubs")
  }
  return null
}

function removeUiDest() {
  try {
    fs.lstatSync(uiDest)
  } catch {
    return
  }
  fs.rmSync(uiDest, { recursive: true, force: true })
}

/** Move a real (non-symlink) src/ui aside before replacing it with a frontend link. */
function backupUiDestIfReal() {
  let st
  try {
    st = fs.lstatSync(uiDest)
  } catch {
    return
  }
  if (st.isSymbolicLink()) return

  if (fs.existsSync(uiBak)) {
    fs.rmSync(uiBak, { recursive: true, force: true })
  }
  fs.renameSync(uiDest, uiBak)
  console.log("link-ui: backed up src/ui → src/ui.bak")
}

/** Drop compiled UI so mode switches (link ↔ stub) do not leave stale modules. */
function clearDistUi() {
  fs.rmSync(distUi, { recursive: true, force: true })
}

function alreadyLinkedTo(targetAbs) {
  try {
    const st = fs.lstatSync(uiDest)
    if (!st.isSymbolicLink()) return false
    const current = path.resolve(path.dirname(uiDest), fs.readlinkSync(uiDest))
    return current === path.resolve(targetAbs)
  } catch {
    return false
  }
}

function installStubs() {
  try {
    const st = fs.lstatSync(uiDest)
    if (st.isDirectory() && !st.isSymbolicLink() && hasChatUi(uiDest)) {
      // Refresh from scripts/ui-stubs so edits there win.
      fs.cpSync(stubsDir, uiDest, { recursive: true })
      console.log("link-ui: refreshed UI stubs (standalone)")
      runUiGitState("unskip")
      return
    }
  } catch {
    /* missing or broken */
  }
  removeUiDest()
  fs.mkdirSync(path.dirname(uiDest), { recursive: true })
  fs.cpSync(stubsDir, uiDest, { recursive: true })
  console.log("link-ui: installed UI stubs (standalone)")
  runUiGitState("unskip")
}

function linkFrontend(uiSrc) {
  if (alreadyLinkedTo(uiSrc)) {
    console.log(`link-ui: src/ui already → ${uiSrc}`)
    runUiGitState("skip")
    return
  }
  backupUiDestIfReal()
  removeUiDest()
  const rel = path.relative(path.dirname(uiDest), uiSrc)
  fs.symlinkSync(rel, uiDest)
  console.log(`link-ui: linked src/ui → ${rel} (${uiSrc})`)
  // Hide linked frontend files from git; only the real src/ui dir is committable.
  runUiGitState("skip")
}

runUiGitState("install-hooks")
clearDistUi()
const frontend = resolveFrontendUi()
if (frontend) linkFrontend(frontend)
else installStubs()
