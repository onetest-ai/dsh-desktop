/**
 * Vendor the file-type icons the tree draws.
 *
 * `vscode-icons-js` ships the extension-to-icon mapping but not the icons
 * themselves, which live in the vscode-icons repository (MIT). This fetches
 * exactly the icons that mapping can name for the file types listed below,
 * plus the defaults, so the tree carries a few dozen small SVGs rather than
 * the project's full set of a thousand.
 *
 * Run it to refresh or to widen the list; it overwrites what it fetches and
 * leaves everything else alone.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getIconForFile, getIconForFolder, getIconForOpenFolder, DEFAULT_FILE } from 'vscode-icons-js'

/** The upstream tag this vendoring is pinned to. */
const TAG = 'v12.14.0'
const BASE = `https://raw.githubusercontent.com/vscode-icons/vscode-icons/${TAG}/icons`
const OUT = join(import.meta.dirname, '..', 'vendor', 'vscode-icons', 'icons')

/**
 * Names covering what a project this app opens is actually made of.
 *
 * Written as file names rather than extensions because the mapping keys on
 * whole names too — `package.json` and `Dockerfile` are not extensions.
 */
const NAMES = [
  'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.json', 'a.jsonc', 'a.jsonl',
  'a.md', 'a.markdown', 'a.txt', 'a.log', 'a.rst', 'a.adoc',
  'a.html', 'a.htm', 'a.css', 'a.scss', 'a.sass', 'a.less', 'a.vue', 'a.svelte',
  'a.py', 'a.rb', 'a.go', 'a.rs', 'a.java', 'a.kt', 'a.swift', 'a.c', 'a.h', 'a.cpp', 'a.hpp',
  'a.cs', 'a.php', 'a.lua', 'a.pl', 'a.r', 'a.scala', 'a.dart', 'a.ex', 'a.elm', 'a.clj',
  'a.sh', 'a.bash', 'a.zsh', 'a.fish', 'a.ps1', 'a.bat',
  'a.yml', 'a.yaml', 'a.toml', 'a.ini', 'a.cfg', 'a.conf', 'a.env', 'a.properties',
  'a.xml', 'a.csv', 'a.tsv', 'a.sql', 'a.graphql', 'a.proto',
  'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.svg', 'a.webp', 'a.ico', 'a.icns', 'a.bmp',
  'a.pdf', 'a.zip', 'a.tar', 'a.gz', 'a.tgz', 'a.dmg', 'a.mp4', 'a.mov', 'a.mp3', 'a.wav',
  'a.woff', 'a.woff2', 'a.ttf', 'a.otf', 'a.lock', 'a.map', 'a.patch', 'a.diff',
  'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml',
  'Makefile', 'LICENSE', 'README.md', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc',
  '.eslintrc.json', '.prettierrc', 'vite.config.ts', 'webpack.config.js', 'jest.config.js',
  'a.test.ts', 'a.spec.ts', 'a.min.js', 'a.d.ts', 'a.ipynb', 'a.tf', 'a.bicep', 'a.gradle',
]

/**
 * Directory names that get an icon of their own.
 *
 * The mapping knows hundreds; these are the ones a project this app opens
 * actually contains. Anything else falls back to the plain folder, which the
 * tree does on its own when an icon is missing.
 */
const FOLDERS = [
  'src', 'test', 'tests', 'spec', 'e2e', 'docs', 'doc', 'dist', 'build', 'out', 'lib', 'bin',
  'node_modules', 'public', 'assets', 'images', 'img', 'media', 'styles', 'css', 'scripts',
  'config', 'components', 'hooks', 'utils', 'helpers', 'api', 'server', 'client', 'database',
  'templates', 'tools', 'examples', 'vendor', 'temp', 'tmp', 'logs', 'log', 'coverage',
  '.github', '.vscode', '.git', 'android', 'ios', 'python', 'java', 'packages', 'plugins',
]

const wanted = new Set([DEFAULT_FILE, getIconForFolder('x'), getIconForOpenFolder('x')])
for (const name of NAMES) wanted.add(getIconForFile(name))
for (const name of FOLDERS) {
  wanted.add(getIconForFolder(name))
  wanted.add(getIconForOpenFolder(name))
}

mkdirSync(OUT, { recursive: true })
let written = 0
for (const icon of [...wanted].sort()) {
  const response = await fetch(`${BASE}/${icon}`)
  if (!response.ok) {
    console.warn(`skipped ${icon}: ${String(response.status)}`)
    continue
  }
  writeFileSync(join(OUT, icon), await response.text())
  written += 1
}
console.log(`${String(written)} icons from vscode-icons ${TAG}`)
