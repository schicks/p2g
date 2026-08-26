const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

document.getElementById('v').innerText += bridge.pkg().version

function showUpdateReady() {
  document.getElementById('v').innerText = 'Update ready!'
  const btn = document.getElementById('update-btn')
  btn.style.display = 'inline-block'
  btn.onclick = async () => {
    btn.disabled = true
    btn.innerText = 'Updating...'
    try {
      await bridge.applyUpdate()
      await bridge.appAfterUpdate()
    } catch (err) {
      document.getElementById('v').innerText = 'Update failed: ' + err.message
      btn.style.display = 'none'
    }
  }
}

function onWorkerUpdaterEvent(name) {
  if (name === 'updating') {
    document.getElementById('v').innerText = 'UPDATING...'
    return
  }
  if (name === 'updated') showUpdateReady()
}

const workers = {
  main: '/workers/main.js',
  session: '/workers/session.js'
}

bridge.startWorker(workers.main)
let sentHello = false

const offWorkerStdout = bridge.onWorkerStdout(workers.main, (data) => {
  console.log('worker stdout', '[', workers.main, ']:', decoder.decode(data))
})

const offWorkerStderr = bridge.onWorkerStderr(workers.main, (data) => {
  console.error('worker stderr', '[', workers.main, ']:', decoder.decode(data))
})

const offWorkerIpc = bridge.onWorkerIPC(workers.main, (data) => {
  const message = decoder.decode(data)
  console.log('worker ipc', '[', workers.main, ']:', message)
  onWorkerUpdaterEvent(message)

  if (!sentHello) {
    sentHello = true
    bridge.writeWorkerIPC(workers.main, 'Hello from renderer')
  }
})

const offWorkerExit = bridge.onWorkerExit(workers.main, (code) => {
  console.log('Worker exited with code', code)
  offWorkerStdout()
  offWorkerStderr()
  offWorkerIpc()
  offWorkerExit()
})

bridge.startWorker(workers.session)

const syncedDocEl = document.getElementById('synced-doc')
const coreInfoEl = document.getElementById('core-info')
const editorEl = document.getElementById('editor')

editorEl.disabled = true

function onSessionMessage(message) {
  editorEl.disabled = message.markdown === undefined
  syncedDocEl.innerText = message.markdown ?? '(waiting for session doc...)'
  coreInfoEl.innerText = `my hypercore ${message.key} (length ${message.length}) - connected peers: ${message.peers}`

  // reflect the current doc into the editor, but never while the user is
  // actively typing in it - otherwise a remote/persisted update would stomp
  // on whatever they're mid-keystroke on
  if (document.activeElement !== editorEl && message.markdown !== undefined) {
    editorEl.value = message.markdown
  }
}

bridge.onWorkerIPC(workers.session, (data) => {
  const message = JSON.parse(decoder.decode(data))
  console.log('session worker ipc:', message)
  onSessionMessage(message)
})

bridge.onWorkerStdout(workers.session, (data) => {
  console.log('session worker stdout:', decoder.decode(data))
})

bridge.onWorkerStderr(workers.session, (data) => {
  console.error('session worker stderr:', decoder.decode(data))
})

editorEl.addEventListener('input', () => {
  bridge.writeWorkerIPC(workers.session, JSON.stringify({ type: 'edit', text: editorEl.value }))
})
