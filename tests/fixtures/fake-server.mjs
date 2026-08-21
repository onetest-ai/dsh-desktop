// Test double for `dsh web`. Modes are driven by env vars:
//   FAKE_MODE=ready       print noise, then the ready line, then stay alive
//   FAKE_MODE=silent      print noise only, never become ready
//   FAKE_MODE=crash       print to stderr and exit non-zero
//   FAKE_MODE=grandchild  like ready, but also fork a child that outlives a naive kill
//   FAKE_MODE=stubborn    like ready, but ignores SIGTERM, so only SIGKILL ends it
//   FAKE_MODE=exiting     forks a grandchild in the same process group, becomes
//                         ready, then exits on its own, leaving the grandchild
//   FAKE_MODE=split       like ready, but the ready line arrives split across two
//                         stdout chunks (mid-URL) with a real gap between them, so
//                         they cannot coalesce into a single `data` event
import { spawn } from 'node:child_process'

const mode = process.env.FAKE_MODE ?? 'ready'
const port = process.env.FAKE_PORT ?? '54321'

console.log('some unrelated startup noise')
console.log('dsh web: warming up')

if (mode === 'crash') {
  console.error('fake server: boom')
  process.exit(3)
}

if (mode === 'stubborn') {
  process.on('SIGTERM', () => {})
}

if (mode === 'grandchild' || mode === 'exiting') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  console.log(`grandchild: ${child.pid}`)
}

if (mode === 'exiting') {
  setTimeout(() => process.exit(0), 200)
}

if (mode === 'split') {
  process.stdout.write(`dsh web: http://127.0.0.1:`)
  setTimeout(() => {
    process.stdout.write(`${port} (LAN: http://192.168.1.5:${port})\n`)
  }, 50)
} else if (mode !== 'silent') {
  console.log(`dsh web: http://127.0.0.1:${port} (LAN: http://192.168.1.5:${port})`)
}

setInterval(() => {}, 1000)
