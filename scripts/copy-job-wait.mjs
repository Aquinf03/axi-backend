#!/usr/bin/env node
/** Cross-platform post-tsc step — copy non-TS assets beside dist. */
import { copyFileSync, chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// Portable CLI shim — always rewrite so a host-absolute node path never ships.
const binDir = path.join(root, "bin")
mkdirSync(binDir, { recursive: true })
const launcher = path.join(binDir, "axi")
writeFileSync(launcher, '#!/usr/bin/env node\nimport "../dist/cli.js"\n')
chmodSync(launcher, 0o755)

const jobDir = path.join(root, "dist", "core", "job")
mkdirSync(jobDir, { recursive: true })
copyFileSync(path.join(root, "src", "core", "job", "job-wait.mjs"), path.join(jobDir, "job-wait.mjs"))

const codemodeDir = path.join(root, "dist", "core", "codemode")
mkdirSync(codemodeDir, { recursive: true })
copyFileSync(
  path.join(root, "src", "core", "codemode", "worker.mjs"),
  path.join(codemodeDir, "worker.mjs"),
)

const factoryMachinesSrc = path.join(root, "src", "core", "factory", "machines")
const factoryMachinesDest = path.join(root, "dist", "core", "factory", "machines")
mkdirSync(factoryMachinesDest, { recursive: true })
for (const name of readdirSync(factoryMachinesSrc)) {
  if (!name.endsWith(".json") && !name.endsWith(".md")) continue
  copyFileSync(path.join(factoryMachinesSrc, name), path.join(factoryMachinesDest, name))
}
