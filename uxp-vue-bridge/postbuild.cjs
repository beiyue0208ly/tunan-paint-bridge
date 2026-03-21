const fs = require('fs')
const path = require('path')

const dist = path.join(__dirname, 'dist')
const pub = path.join(__dirname, 'public')
const manifestTemplate = path.join(pub, 'manifest.template.json')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function copyDirectoryRecursive(src, dest) {
  if (!fs.existsSync(src)) return

  ensureDir(dest)

  fs.readdirSync(src, { withFileTypes: true }).forEach((entry) => {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath)
      return
    }

    fs.copyFileSync(srcPath, destPath)
  })
}

ensureDir(dist)

fs.copyFileSync(manifestTemplate, path.join(dist, 'manifest.json'))
console.log('  Generated dist/manifest.json from manifest.template.json')

;['index.html', 'host.js'].forEach((file) => {
  fs.copyFileSync(path.join(pub, file), path.join(dist, file))
  console.log(`  Copied ${file} -> dist/`)
})

copyDirectoryRecursive(path.join(pub, 'host'), path.join(dist, 'host'))
console.log('  Copied host/ -> dist/host/')

copyDirectoryRecursive(path.join(pub, 'icons'), path.join(dist, 'icons'))
console.log('  Copied icons/ -> dist/icons/')

console.log('  Post-build: UXP host layer files placed in dist/')
