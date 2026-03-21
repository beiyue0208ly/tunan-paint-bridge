const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..')
const hostRoot = path.join(projectRoot, 'public', 'host')

const forbiddenArtifacts = [
  'devserver.log',
  'style_dump.css',
  'fix.cjs',
  'fix_app.cjs',
  'fix_css.cjs',
  'fix_gap.cjs',
  'temp.txt',
  'temp2.txt',
  'temp3.txt',
  'temp4.txt',
  'temp5.txt',
  'temp6.txt',
  'temp7.txt',
  'temp_css.txt',
  'dist-verify',
]

const requiredDistFiles = [
  path.join(projectRoot, 'dist', 'manifest.json'),
  path.join(projectRoot, 'dist', 'host.js'),
  path.join(projectRoot, 'dist', 'webview', 'index.html'),
]

function runStep(label, command, args, options = {}) {
  console.log(`[release-check] ${label}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`)
  }
}

function collectJsFiles(dir) {
  if (!fs.existsSync(dir)) return []

  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath))
      continue
    }

    if (entry.isFile() && fullPath.endsWith('.js')) {
      files.push(fullPath)
    }
  }

  return files.sort()
}

function assertForbiddenArtifactsRemoved() {
  const leftovers = forbiddenArtifacts.filter((relativePath) =>
    fs.existsSync(path.join(projectRoot, relativePath)),
  )

  if (leftovers.length > 0) {
    throw new Error(
      `Found leftover release artifacts: ${leftovers.join(', ')}`,
    )
  }
}

function assertDistOutputsExist() {
  const missingFiles = requiredDistFiles.filter((targetPath) => !fs.existsSync(targetPath))
  if (missingFiles.length > 0) {
    throw new Error(`Build output is incomplete: ${missingFiles.join(', ')}`)
  }
}

function main() {
  assertForbiddenArtifactsRemoved()
  assertDistOutputsExist()

  const hostFiles = collectJsFiles(hostRoot)
  if (hostFiles.length === 0) {
    throw new Error('No host JS files found under public/host')
  }

  for (const hostFile of hostFiles) {
    runStep(`node --check ${path.relative(projectRoot, hostFile)}`, process.execPath, [
      '--check',
      hostFile,
    ])
  }

  const syntaxCheckScript = path.join(repoRoot, 'comfyui-nodes', 'tests', 'syntax_check.py')
  if (fs.existsSync(syntaxCheckScript)) {
    runStep('ComfyUI syntax check', 'python', [syntaxCheckScript], { cwd: repoRoot })
  }

  console.log('[release-check] All release checks passed.')
}

try {
  main()
} catch (error) {
  console.error(`[release-check] ${error.message}`)
  process.exit(1)
}
