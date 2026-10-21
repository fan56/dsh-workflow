#!/usr/bin/env node
/**
 * Integrate @aiwayds/dsh-workflow into a dsh profile — and uninstall it.
 *
 * Install (dev: link this checkout into the profile):
 *   node scripts/install-profile.mjs --profile tui
 * Install from npm instead of a local link:
 *   node scripts/install-profile.mjs --profile tui --npm [version]
 * Verify a finished install (static tree check):
 *   node scripts/install-profile.mjs --profile tui --check
 * Uninstall:
 *   node scripts/install-profile.mjs --profile tui --uninstall
 *
 * Install steps, in order:
 *   1. back up <profile>/package.json and cordis.patch.yml (timestamped .bak)
 *   2. abort if the profile patch already carries the `dsh-workflow` entry id
 *      (duplicate entry ids across patch layers crash the cordis loader)
 *   3. add the dependency (`link:` to this checkout, or an npm version with
 *      --npm) and append the bundle to dsh.profile.bundles
 *   4. run pnpm install against the official npm registry (profiles are
 *      pnpm-managed; npm crashes on the arborist layout)
 *
 * No agent files are copied: this plugin references the USER's roster
 * (~/.dsh/agents/*.md) by name — installing agent definitions is not its job.
 *
 * The dsh home resolves from --dsh-home, then DSH_HOME, then ~/.dsh.
 */
import { access, copyFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@aiwayds/dsh-workflow'
const REGISTRY = 'https://registry.npmjs.org'
// Entry ids this plugin's bundle patch ships. If the target profile's patch
// already carries any of them, installing would duplicate ids across patch
// layers and the loader rejects the tree.
const SHIPPED_ROW_IDS = ['dsh-workflow']

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const profile = value('--profile')
const dshHome = path.resolve(value('--dsh-home') ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh'))
const uninstall = flag('--uninstall')
const check = flag('--check')
const npmArg = value('--npm')
const useNpm = args.includes('--npm') || (npmArg !== undefined && !npmArg.startsWith('--'))
const depSpec = useNpm ? (npmArg && !npmArg.startsWith('--') ? npmArg : 'latest') : `link:${REPO_ROOT}`

const fail = (message) => {
  console.error(`install-profile: ${message}`)
  process.exit(1)
}
const exists = (p) => access(p).then(() => true, () => false)
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const backup = async (file) => {
  if (!(await exists(file))) return null
  const target = `${file}.bak-${stamp()}`
  await copyFile(file, target)
  return target
}
const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (r.error?.code === 'ENOENT') {
    fail(`\`${cmd}\` not found on PATH${cmd === 'pnpm' ? ' — profiles are pnpm-managed; npm crashes on the arborist layout' : ''}`)
  }
  if (r.status !== 0) fail(`\`${cmd} ${cmdArgs.join(' ')}\` exited ${r.status}${r.error ? ` (${r.error.message})` : ''}`)
}

if (flag('--help') || flag('-h') || !profile) {
  console.log('usage: node scripts/install-profile.mjs --profile <name> [--npm [version]] [--check] [--force-agent]')
  console.log('       node scripts/install-profile.mjs --profile <name> --uninstall [--purge-agent]')
  if (!profile) {
    const dir = path.join(dshHome, 'profiles')
    const list = await readdir(dir).catch(() => [])
    console.log(`\navailable profiles under ${dir}: ${list.join(', ') || '(none)'}`)
  }
  process.exit(profile ? 0 : 1)
}

const profileDir = path.join(dshHome, 'profiles', profile)
if (!(await exists(profileDir))) fail(`profile "${profile}" not found under ${path.join(dshHome, 'profiles')}`)
const pkgFile = path.join(profileDir, 'package.json')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

// ---- uninstall -------------------------------------------------------------
if (uninstall) {
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PACKAGE_NAME) && !pkg.dependencies?.[PACKAGE_NAME]) {
    console.log(`install-profile: ${PACKAGE_NAME} is not mounted in profile "${profile}" — nothing to do`)
  } else {
    await backup(pkgFile)
    delete pkg.dependencies[PACKAGE_NAME]
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME)
    await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`install-profile: removed the bundle entry and dependency from profile "${profile}"`)
    run('pnpm', ['install', '--registry', REGISTRY], { cwd: profileDir })
  }
  console.log('install-profile: done — restart the profile to drop the plugin')
  process.exit(0)
}

// ---- install ---------------------------------------------------------------
const patch = await readFile(patchFile, 'utf8').catch(() => '')
const conflicts = SHIPPED_ROW_IDS.filter((id) => new RegExp(`^\\s*- id: ${id}\\b`, 'm').test(patch))
if (conflicts.length) {
  fail([
    `cordis.patch.yml already carries entry id(s): ${conflicts.join(', ')}`,
    'this plugin ships the same rows, and duplicate ids across patch layers crash the loader.',
    'Remove those rows from the profile patch first, then re-run.',
  ].join('\n  '))
}

const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
if (!pkg?.dsh?.profile) fail('profile package.json has no dsh.profile section — not a dsh profile?')
if (!Array.isArray(pkg.dsh.profile.bundles ?? [])) fail('dsh.profile.bundles is not a list — refusing to edit')
pkg.dependencies ??= {}
const bundles = pkg.dsh.profile.bundles ?? (pkg.dsh.profile.bundles = [])
const changes = []
if (!bundles.includes(PACKAGE_NAME)) {
  await backup(pkgFile)
  bundles.push(PACKAGE_NAME)
  changes.push('bundle appended to dsh.profile.bundles')
}
if (pkg.dependencies[PACKAGE_NAME] !== depSpec) {
  if (!changes.length) await backup(pkgFile)
  pkg.dependencies[PACKAGE_NAME] = depSpec
  changes.push(`dependency "${PACKAGE_NAME}": "${depSpec}"${useNpm ? '' : ' (dev link to this checkout)'}`)
}
if (changes.length) {
  await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`install-profile: package.json — ${changes.join('; ')}`)
  run('pnpm', ['install', '--registry', REGISTRY], { cwd: profileDir })
} else {
  console.log('install-profile: bundle and dependency already in place')
}

// No agent files are installed: workflow steps reference the USER's roster
// by name — what exists in ~/.dsh/agents is the author's choice, not ours.
const rosterDir = path.join(dshHome, 'agents')
const rosterNames = (await exists(rosterDir))
  ? (await readdir(rosterDir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  : []
if (check) {
  console.log('install-profile: dsh --dump-config…')
  run('dsh', ['--profile', profile, '--dump-config'], { timeout: 180_000 })
  console.log(`install-profile: static tree OK — roster agents available: ${rosterNames.join(', ') || '(none)'}`)
  console.log('install-profile: restart the profile, then /workflow run <file.workflow.yaml>')
} else {
  console.log(`install-profile: done — roster agents available: ${rosterNames.join(', ') || '(none)'}`)
  console.log('install-profile: restart the profile, then verify with --check')
}
