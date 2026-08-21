// Test double for `dsh web`. Modes are driven by env vars:
//   FAKE_MODE=ready       print noise, then the ready line, then stay alive
//   FAKE_MODE=silent      print noise only, never become ready
//   FAKE_MODE=crash       print to stderr and exit non-zero
//   FAKE_MODE=grandchild  like ready, but also fork a child that outlives a naive kill
import { spawn } from 'node:child_process'

const mode = process.env.FAKE_MODE ?? 'ready'
const port = process.env.FAKE_PORT ?? '54321'

console.log('some unrelated startup noise')
console.log('dsh web: warming up')

if (mode === 'crash') {
  console.error('fake server: boom')
  process.exit(3)
}

if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  console.log(`grandchild: ${child.pid}`)
}

if (mode !== 'silent') {
  console.log(`dsh web: http://127.0.0.1:${port} (LAN: http://192.168.1.5:${port})`)
}

setInterval(() => {}, 1000)
