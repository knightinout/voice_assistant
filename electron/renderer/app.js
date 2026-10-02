'use strict'

// ── Markdown setup ────────────────────────────────────────────────────────────
marked.use({ breaks: true, gfm: true })

const SERVER = window.electronAPI.getServerUrl()

const TOOL_LABELS = {
  get_datetime:    'date & time',
  get_system_info: 'system info',
  list_directory:  'listing files',
  search_files:    'searching files',
  read_file:       'reading file',
  apt_search:      'searching packages',
  list_installed:  'installed packages',
  create_note:     'creating note',
  move_file:       'moving file',
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot      = document.getElementById('statusDot')
const statusText     = document.getElementById('statusText')
const voiceSelect    = document.getElementById('voiceSelect')
const clearBtn       = document.getElementById('clearBtn')
const chat           = document.getElementById('chat')
const waveform       = document.getElementById('waveform')
const micBtn         = document.getElementById('micBtn')
const stopBtn        = document.getElementById('stopBtn')
const micLabel       = document.getElementById('micLabel')
const textInput      = document.getElementById('textInput')
const sendBtn        = document.getElementById('sendBtn')
const speedBtn       = document.getElementById('speedBtn')
const speedMenu      = document.getElementById('speedMenu')

// Doc panel
const docPanel       = document.getElementById('docPanel')
const docCount       = document.getElementById('docCount')
const docList        = document.getElementById('docList')
const docToggle      = document.getElementById('docToggle')
const uploadBtn      = document.getElementById('uploadBtn')
const fileInput      = document.getElementById('fileInput')
const uploadSpinner  = document.getElementById('uploadSpinner')
const uploadError    = document.getElementById('uploadError')

// ── State ─────────────────────────────────────────────────────────────────────
let conversationHistory = []
let isRecording   = false
let isProcessing  = false

let currentAudio      = null   // currently playing Audio object

const SPEEDS = [1, 1.25, 1.5, 2, 2.5, 3]
let playbackSpeed = 1

let audioCtx          = null
let micStream         = null
let scriptNode        = null
let analyserNode      = null
let audioChunks       = []
let browserSampleRate = 44100
let rafId             = null

// ── Health polling ────────────────────────────────────────────────────────────
async function pollHealth() {
  let data
  try {
    const res = await fetch(`${SERVER}/health`)
    data = await res.json()
  } catch (_) {
    statusDot.className    = 'dot dot--connecting'
    statusText.textContent = 'Server starting… (loading Whisper)'
    setTimeout(pollHealth, 2000)
    return
  }

  if (data.status === 'ok') {
    statusDot.className    = 'dot dot--ok'
    statusText.textContent = `LM Studio: connected — ${data.model}`
    await loadVoices()
    await refreshDocList()
    return
  }

  statusDot.className    = 'dot dot--error'
  statusText.textContent = 'LM Studio unreachable — open LM Studio, load a model, start server'
  setTimeout(pollHealth, 3000)
}

// ── Voice selection ───────────────────────────────────────────────────────────
async function loadVoices() {
  try {
    const res  = await fetch(`${SERVER}/voices`)
    const data = await res.json()
    voiceSelect.innerHTML = ''
    for (const v of data.voices) {
      const opt = document.createElement('option')
      opt.value = v.id
      opt.textContent = v.name
      if (v.current) opt.selected = true
      voiceSelect.appendChild(opt)
    }
  } catch (_) {}
}

voiceSelect.addEventListener('change', async () => {
  try {
    await fetch(`${SERVER}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: voiceSelect.value }),
    })
  } catch (e) {
    console.error('Voice switch error:', e)
  }
})

// ── Document panel ────────────────────────────────────────────────────────────
docToggle.addEventListener('click', () => {
  const expanded = docPanel.classList.contains('doc-panel--expanded')
  docPanel.classList.toggle('doc-panel--expanded', !expanded)
  docPanel.classList.toggle('doc-panel--collapsed', expanded)
})

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files)
  if (!files.length) return
  fileInput.value = ''

  // Auto-expand panel during upload
  docPanel.classList.remove('doc-panel--collapsed')
  docPanel.classList.add('doc-panel--expanded')

  setUploadError('')
  uploadSpinner.classList.remove('hidden')
  uploadBtn.style.pointerEvents = 'none'

  for (const file of files) {
    try {
      const form = new FormData()
      form.append('file', file)
      const res  = await fetch(`${SERVER}/upload`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) {
        setUploadError(data.detail || 'Upload failed')
      }
    } catch (e) {
      setUploadError(`Upload error: ${e.message}`)
    }
  }

  uploadSpinner.classList.add('hidden')
  uploadBtn.style.pointerEvents = ''
  await refreshDocList()
})

async function refreshDocList() {
  try {
    const res  = await fetch(`${SERVER}/documents`)
    const data = await res.json()
    renderDocList(data.documents)
  } catch (_) {}
}

function renderDocList(docs) {
  docList.innerHTML = ''
  if (!docs.length) {
    docCount.textContent = 'No documents attached'
    return
  }
  docCount.textContent = `${docs.length} document${docs.length > 1 ? 's' : ''} attached`

  for (const doc of docs) {
    const chip = document.createElement('div')
    chip.className = 'doc-chip'
    chip.innerHTML = `
      <span class="doc-chip__name" title="${doc.filename}">${doc.filename}</span>
      <span class="doc-chip__meta">${doc.chunks} chunks</span>
      <button class="doc-chip__remove" title="Remove document" data-id="${doc.doc_id}">×</button>
    `
    chip.querySelector('.doc-chip__remove').addEventListener('click', () => removeDoc(doc.doc_id))
    docList.appendChild(chip)
  }
}

async function removeDoc(docId) {
  try {
    await fetch(`${SERVER}/documents/${docId}`, { method: 'DELETE' })
    await refreshDocList()
  } catch (e) {
    setUploadError(`Remove error: ${e.message}`)
  }
}

function setUploadError(msg) {
  uploadError.textContent = msg
  uploadError.classList.toggle('hidden', !msg)
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text)
    btn.innerHTML = CHECK_ICON
    btn.classList.add('bubble__copy-btn--ok')
    setTimeout(() => {
      btn.innerHTML = COPY_ICON
      btn.classList.remove('bubble__copy-btn--ok')
    }, 1500)
  } catch (_) {}
}

function addBubble(role, text, ragSources) {
  const isUser = role === 'user'
  const el = document.createElement('div')
  el.className = `bubble bubble--${isUser ? 'user' : 'bot'}`
  el.dataset.rawText = text

  // Content area (renders markdown for bot, plain text for user)
  const content = document.createElement('div')
  content.className = 'bubble__content'
  if (isUser) {
    content.textContent = text
  } else {
    content.innerHTML = marked.parse(text)
  }
  el.appendChild(content)

  // Copy button (visible on hover)
  const copyBtn = document.createElement('button')
  copyBtn.className = 'bubble__copy-btn'
  copyBtn.title = 'Copy message'
  copyBtn.innerHTML = COPY_ICON
  copyBtn.addEventListener('click', () => copyText(el.dataset.rawText, copyBtn))
  el.appendChild(copyBtn)

  if (ragSources && ragSources.length) {
    const hint = document.createElement('span')
    hint.className = 'bubble__rag-hint'
    hint.textContent = `📎 From: ${ragSources.join(', ')}`
    el.appendChild(hint)
  }
  chat.appendChild(el)
  chat.scrollTop = chat.scrollHeight
  return el
}

clearBtn.addEventListener('click', () => {
  conversationHistory = []
  chat.innerHTML = ''
})

// ── Recording ─────────────────────────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
  if (isProcessing) return
  if (!isRecording) {
    await startRecording()
  } else {
    await stopAndProcess()
  }
})

async function startRecording() {
  try {
    audioCtx = new AudioContext()
    browserSampleRate = audioCtx.sampleRate
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

    const source = audioCtx.createMediaStreamSource(micStream)
    analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 1024
    source.connect(analyserNode)

    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1)
    audioChunks = []
    scriptNode.onaudioprocess = (e) => {
      audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    source.connect(scriptNode)
    scriptNode.connect(audioCtx.destination)

    isRecording = true
    setMicState('recording')
    startWaveform()
  } catch (e) {
    console.error('Mic error:', e)
    statusDot.className    = 'dot dot--error'
    statusText.textContent = `Mic error: ${e.message}`
  }
}

async function stopAndProcess() {
  isRecording = false
  stopWaveform()
  setMicState('processing')

  if (scriptNode)  { scriptNode.disconnect();  scriptNode  = null }
  if (analyserNode){ analyserNode.disconnect(); analyserNode = null }
  if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  if (audioCtx)    { audioCtx.close(); audioCtx = null }

  const totalLen = audioChunks.reduce((s, c) => s + c.length, 0)
  const merged   = new Float32Array(totalLen)
  let offset = 0
  for (const chunk of audioChunks) { merged.set(chunk, offset); offset += chunk.length }
  audioChunks = []

  if (merged.length < browserSampleRate * 0.2) {
    setMicState('idle')
    return
  }

  isProcessing = true

  try {
    // 1. Transcribe
    const tRes = await fetch(
      `${SERVER}/transcribe?sample_rate=${browserSampleRate}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: merged.buffer }
    )
    const { transcript } = await tRes.json()

    if (!transcript) { setMicState('idle'); isProcessing = false; return }

    addBubble('user', transcript)
    const thinkingBubble = addBubble('bot', 'Thinking…')
    thinkingBubble.classList.add('bubble--thinking')

    // 2. Chat (RAG + agentic loop happen server-side)
    const cRes  = await fetch(`${SERVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, history: conversationHistory }),
    })
    const data = await cRes.json()

    if (data.error) {
      thinkingBubble.querySelector('.bubble__content').textContent = `Error: ${data.error}`
      thinkingBubble.dataset.rawText = `Error: ${data.error}`
      thinkingBubble.classList.remove('bubble--thinking')
      setMicState('idle')
      isProcessing = false
      return
    }

    // Replace thinking bubble with final reply
    thinkingBubble.querySelector('.bubble__content').innerHTML = marked.parse(data.reply)
    thinkingBubble.dataset.rawText = data.reply
    thinkingBubble.classList.remove('bubble--thinking')

    // Show tool activity hint
    if (data.tools_used && data.tools_used.length) {
      const labels = [...new Set(data.tools_used)].map(t => TOOL_LABELS[t] || t)
      const hint = document.createElement('span')
      hint.className = 'bubble__tool-hint'
      hint.textContent = `⚙ ${labels.join(' · ')}`
      thinkingBubble.appendChild(hint)
    }

    // Show RAG sources hint
    if (data.rag_sources && data.rag_sources.length) {
      const hint = document.createElement('span')
      hint.className = 'bubble__rag-hint'
      hint.textContent = `📎 From: ${data.rag_sources.join(', ')}`
      thinkingBubble.appendChild(hint)
    }

    chat.scrollTop = chat.scrollHeight

    conversationHistory.push({ role: 'user',      content: transcript })
    conversationHistory.push({ role: 'assistant', content: data.reply  })

    if (data.audio_b64) playBase64Wav(data.audio_b64)
  } catch (e) {
    console.error('Processing error:', e)
  }

  isProcessing = false
  setMicState('idle')
}

// ── Text input ────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const text = textInput.value.trim()
  if (text) sendTextMessage(text)
})

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = textInput.value.trim()
    if (text) sendTextMessage(text)
  }
})

async function sendTextMessage(text) {
  if (isProcessing || isRecording) return

  textInput.value = ''
  textInput.disabled = true
  sendBtn.disabled  = true
  isProcessing = true

  addBubble('user', text)
  const thinkingBubble = addBubble('bot', 'Thinking…')
  thinkingBubble.classList.add('bubble--thinking')

  try {
    const cRes = await fetch(`${SERVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: text, history: conversationHistory }),
    })
    const data = await cRes.json()

    if (data.error) {
      thinkingBubble.querySelector('.bubble__content').textContent = `Error: ${data.error}`
      thinkingBubble.dataset.rawText = `Error: ${data.error}`
      thinkingBubble.classList.remove('bubble--thinking')
    } else {
      thinkingBubble.querySelector('.bubble__content').innerHTML = marked.parse(data.reply)
      thinkingBubble.dataset.rawText = data.reply
      thinkingBubble.classList.remove('bubble--thinking')

      if (data.tools_used && data.tools_used.length) {
        const labels = [...new Set(data.tools_used)].map(t => TOOL_LABELS[t] || t)
        const hint = document.createElement('span')
        hint.className = 'bubble__tool-hint'
        hint.textContent = `⚙ ${labels.join(' · ')}`
        thinkingBubble.appendChild(hint)
      }

      if (data.rag_sources && data.rag_sources.length) {
        const hint = document.createElement('span')
        hint.className = 'bubble__rag-hint'
        hint.textContent = `📎 From: ${data.rag_sources.join(', ')}`
        thinkingBubble.appendChild(hint)
      }

      chat.scrollTop = chat.scrollHeight
      conversationHistory.push({ role: 'user',      content: text       })
      conversationHistory.push({ role: 'assistant', content: data.reply })

      if (data.audio_b64) playBase64Wav(data.audio_b64)
    }
  } catch (e) {
    thinkingBubble.querySelector('.bubble__content').textContent = `Error: ${e.message}`
    thinkingBubble.dataset.rawText = `Error: ${e.message}`
    thinkingBubble.classList.remove('bubble--thinking')
    console.error('Text send error:', e)
  }

  isProcessing = false
  textInput.disabled = false
  sendBtn.disabled  = false
  textInput.focus()
}

// ── Audio playback ────────────────────────────────────────────────────────────
function playBase64Wav(b64) {
  stopAudio()  // stop any previous playback

  const binary = atob(b64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob  = new Blob([bytes], { type: 'audio/wav' })
  const url   = URL.createObjectURL(blob)

  currentAudio = new Audio(url)
  currentAudio.playbackRate = playbackSpeed
  stopBtn.classList.remove('hidden')

  currentAudio.addEventListener('ended', () => {
    URL.revokeObjectURL(url)
    currentAudio = null
    stopBtn.classList.add('hidden')
  })
  currentAudio.play().catch(e => console.error('Playback error:', e))
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
  stopBtn.classList.add('hidden')
}

stopBtn.addEventListener('click', stopAudio)

// ── Waveform ──────────────────────────────────────────────────────────────────
function startWaveform() {
  waveform.classList.add('active')
  const ctx = waveform.getContext('2d')
  const buf = new Uint8Array(analyserNode ? analyserNode.frequencyBinCount : 512)

  function draw() {
    if (!isRecording) return
    rafId = requestAnimationFrame(draw)
    if (!analyserNode) return
    analyserNode.getByteTimeDomainData(buf)

    const w = waveform.width  = waveform.offsetWidth
    const h = waveform.height = waveform.offsetHeight
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = '#7c6af5'
    ctx.lineWidth   = 2
    ctx.beginPath()

    const sliceW = w / buf.length
    let x = 0
    for (let i = 0; i < buf.length; i++) {
      const y = (buf[i] / 128) * h / 2
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      x += sliceW
    }
    ctx.lineTo(w, h / 2)
    ctx.stroke()
  }
  draw()
}

function stopWaveform() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null }
  waveform.classList.remove('active')
  waveform.getContext('2d').clearRect(0, 0, waveform.width, waveform.height)
}

// ── Mic button states ─────────────────────────────────────────────────────────
function setMicState(state) {
  micBtn.className = `mic-btn mic-btn--${state}`
  micLabel.textContent = { idle: 'Click to record', recording: 'Click to stop', processing: 'Processing…' }[state] || ''
}

// ── Speed control ─────────────────────────────────────────────────────────────
const BOLT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`

function buildSpeedMenu() {
  speedMenu.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'speed-menu__header'
  header.innerHTML = `${BOLT_SVG}<span>Playback speed</span><span class="speed-menu__current">${playbackSpeed === 1 ? '1×' : `${playbackSpeed}×`}</span>`
  speedMenu.appendChild(header)

  const divider = document.createElement('div')
  divider.className = 'speed-menu__divider'
  speedMenu.appendChild(divider)

  for (const s of SPEEDS) {
    const item = document.createElement('button')
    item.className = 'speed-menu__item' + (s === playbackSpeed ? ' speed-menu__item--active' : '')
    item.textContent = s === 1 ? '1× Normal' : `${s}×`
    item.addEventListener('click', () => setSpeed(s))
    speedMenu.appendChild(item)
  }
}

function setSpeed(s) {
  playbackSpeed = s
  if (currentAudio) currentAudio.playbackRate = s
  speedMenu.classList.add('hidden')
  buildSpeedMenu()
}

speedBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  speedMenu.classList.toggle('hidden')
})

document.addEventListener('click', () => speedMenu.classList.add('hidden'))

// ── Boot ──────────────────────────────────────────────────────────────────────
window.electronAPI.onPyLog((line) => console.log(`%c[py] ${line}`, 'color:#7c6af5'))
buildSpeedMenu()
pollHealth()
