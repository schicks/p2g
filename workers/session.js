// @automerge/automerge's default entrypoint picks the "node" exports
// condition under Bare (which advertises a 'node' condition for broad
// compat) and that build hard-requires Node's real 'fs' module to load its
// wasm binary, which Bare doesn't have. The base64 entrypoint embeds the
// wasm as a string instead, so require it directly by path to sidestep the
// "node" condition. It also needs TextEncoder/TextDecoder and WebCrypto
// (for actor-id generation), which aren't Bare globals by default.
require('bare-encoding/global')
require('bare-crypto/global')
const Automerge = require('../node_modules/@automerge/automerge/dist/cjs/fullfat_base64.cjs')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')

// mobile doesn't have the executable path (argv[0]) and the worker entry
// path (argv[1]) in the worker's argv, same convention as hello-pear-worker
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

const storageDir = argv(4) || dir.persistent()

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(storageDir, 'session-store'))

// one named hypercore per session participant - "self" is a stand-in until
// sessions have real participant identities to name cores after
const core = store.get({ name: 'self' })

// placeholder until sessions are keyed to a real file/invite - every peer
// using this constant topic will find each other
const TOPIC = crypto.hash(Buffer.from('hello-pear-electron:session-topic'))
const GENESIS_GRACE_MS = 2000

const swarm = new Hyperswarm()
swarm.on('error', (err) => console.error('swarm error:', err && err.stack))
swarm.dht.on('ready', () => console.log('dht ready'))
const peerCores = new Map() // hex key -> hypercore
const appliedLength = new Map() // hex key -> changes already applied from it

let doc = Automerge.init()
let genesisOwnerDecided = false

function sendState(type) {
  pipe.write(
    JSON.stringify({
      type,
      key: core.key.toString('hex'),
      length: core.length,
      peers: swarm.connections.size,
      markdown: doc.markdown
    })
  )
}

async function appendLastChange() {
  const change = Automerge.getLastLocalChange(doc)
  if (change) await core.append(change)
}

async function initGenesis() {
  if (genesisOwnerDecided) return
  genesisOwnerDecided = true
  doc = Automerge.change(doc, 'init', (d) => {
    d.markdown = ''
  })
  await appendLastChange()
  sendState('doc')
}

async function catchUp(peerCore) {
  const hex = peerCore.key.toString('hex')
  let from = appliedLength.get(hex) || 0
  await peerCore.update()

  if (from < peerCore.length) {
    while (from < peerCore.length) {
      const change = await peerCore.get(from)
      ;[doc] = Automerge.applyChanges(doc, [change])
      from++
    }
    appliedLength.set(hex, from)
    // an existing peer's history arrived - never mint our own competing
    // genesis once we've adopted someone else's (independently-created
    // docs have unrelated causal histories and can't text-merge, see the
    // automerge-bare-runtime-fix memory note)
    genesisOwnerDecided = true
    sendState('doc')
    return
  }

  // the peer's core is still empty too - nobody has created a genesis
  // between us yet. Agree on exactly one creator deterministically (lower
  // core key wins) instead of racing a timer, since two peers starting at
  // nearly the same instant would otherwise both mint their own genesis
  if (!genesisOwnerDecided && Buffer.compare(core.key, peerCore.key) < 0) {
    await initGenesis()
  }
}

swarm.on('connection', (connection, info) => {
  console.log('connection opened, peer public key:', info.publicKey.toString('hex'))
  connection.on('error', (err) => console.error('connection error:', err && err.stack))
  connection.on('close', () => console.log('connection closed'))
  connection.once('data', async (data) => {
    const hex = data.toString('hex')
    console.log('learned peer core key:', hex)
    if (peerCores.has(hex)) return
    const peerCore = store.get(data)
    await peerCore.ready()
    peerCores.set(hex, peerCore)
    peerCore.on('append', () => catchUp(peerCore))
    await catchUp(peerCore)
  })
  connection.write(core.key)
  store.replicate(connection)
  sendState('doc')
})

pipe.on('data', async (data) => {
  const message = JSON.parse(data.toString())

  if (message.type === 'edit') {
    doc = Automerge.change(doc, 'edit', (d) => {
      Automerge.updateText(d, ['markdown'], message.text)
    })
    await appendLastChange()
    sendState('doc')
  }
})

async function start() {
  await core.ready()
  console.log('my core key:', core.key.toString('hex'))
  console.log('topic:', TOPIC.toString('hex'))

  const discovery = swarm.join(TOPIC, { client: true, server: true })
  discovery.flushed().then(() => console.log('discovery flushed'))
  swarm.flush().then(() => console.log('swarm flushed, connections =', swarm.connections.size))

  setInterval(() => console.log('connections:', swarm.connections.size), 5000).unref?.()

  // give any existing peer a grace window to connect before assuming we're
  // alone and minting our own genesis - if a peer is connected by then, the
  // deterministic key-comparison in catchUp() decides ownership instead,
  // since a fixed timer alone would let two simultaneously-starting peers
  // both mint their own genesis
  setTimeout(() => {
    if (swarm.connections.size === 0) initGenesis()
  }, GENESIS_GRACE_MS)

  sendState('ready')
}

start().catch((err) => {
  console.error('session worker failed to start:', err)
})
