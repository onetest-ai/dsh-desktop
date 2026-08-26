// A minimal stdio MCP server, for probing without a network round trip.
//
// Modes, chosen by argv[2]:
//   ok            handshake, then two tools
//   slow          the same, after a delay longer than any naive bound
//   noisy         writes progress to stderr first, as `npx` does while downloading
//   refuse        answers initialize with an error
//   crash         exits before answering anything
//   garbage       writes non-JSON to stdout, then behaves like `ok`
const mode = process.argv[2] ?? 'ok'
const delayMs = Number(process.argv[3] ?? '0')

if (mode === 'crash') process.exit(3)
if (mode === 'noisy') process.stderr.write('npm warn exec fetching package\nProgress: 42%\n')

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      const reply = () => {
        if (mode === 'refuse') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'not today' } })
        if (mode === 'garbage') process.stdout.write('starting up, please wait\n')
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } })
      }
      if (delayMs > 0) setTimeout(reply, delayMs)
      else reply()
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'alpha' }, { name: 'beta' }] } })
    }
  }
})

setInterval(() => {}, 1000)
