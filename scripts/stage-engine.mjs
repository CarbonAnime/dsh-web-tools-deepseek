/**
 * Copy the built engine into `bin/` under the name the JS bridge looks for.
 *
 * The release workflow builds one binary per platform and commits nothing; this
 * script is what turns `target/release/<name>` into the
 * `bin/<name>-<platform>-<arch>[.exe]` that `lib/engine.js` resolves first — so a
 * repository checkout, a pnpm install and a packed tarball all find their engine
 * without any configuration.
 *
 * Usage:
 *   node scripts/stage-engine.mjs [--debug] [--platform win32] [--arch x64] [--from target/<triple>/release]
 *
 * `--from` exists because a cross-compiled build lands in `target/<triple>/<profile>/`
 * rather than `target/<profile>/`, which is how CI produces both macOS architectures
 * from one runner.
 *
 * @module dsh-web-tools-deepseek/scripts/stage-engine
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} flag @returns {string | undefined} The value after `flag`, when present. */
function arg(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const profile = process.argv.includes('--debug') ? 'debug' : 'release'
const platform = arg('--platform') ?? process.platform
const arch = arg('--arch') ?? process.arch
const extension = platform === 'win32' ? '.exe' : ''
const basename = `dsh-web-tools-deepseek${extension}`

const directory = arg('--from') ?? path.join('target', profile)
const source = path.resolve(root, directory, basename)
if (!existsSync(source)) {
  console.error(`stage-engine: ${source} does not exist — run \`cargo build --release\` first.`)
  process.exit(1)
}

const destination = path.join(root, 'bin', `dsh-web-tools-deepseek-${platform}-${arch}${extension}`)
mkdirSync(path.dirname(destination), { recursive: true })
copyFileSync(source, destination)
if (platform !== 'win32') chmodSync(destination, 0o755)

const kib = Math.round(statSync(destination).size / 1024)
console.log(`stage-engine: ${path.relative(root, source)} → ${path.relative(root, destination)} (${kib} KiB)`)
