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
  pkg_search:      'searching packages',
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
const settingsBtn    = document.getElementById('settingsBtn')
const settingsMenu   = document.getElementById('settingsMenu')

// Chat sessions
const chatSelect     = document.getElementById('chatSelect')
const newChatBtn     = document.getElementById('newChatBtn')
const deleteChatBtn  = document.getElementById('deleteChatBtn')

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
let chatSessions = [{ id: 1, name: 'Chat 1', history: [], bubbles: '' }]
let activeChatId = 1
let nextChatId   = 2
let conversationHistory = chatSessions[0].history
const MAX_HISTORY = 10   // send only last N messages to avoid stale context
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

function copyText(text, btn) {
  try {
    window.electronAPI.copyToClipboard(text)
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
    // Split on explicit newlines first
    let paragraphs = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
    // If still a single block longer than 100 chars, break at sentence boundaries
    if (paragraphs.length === 1 && paragraphs[0].length > 100) {
      paragraphs = paragraphs[0]
        .split(/(?<=[.!?])\s+(?=[A-Z"'\(])/)
        .reduce((acc, sentence) => {
          if (!acc.length) return [sentence]
          const last = acc[acc.length - 1]
          if (last.length + sentence.length < 120) {
            acc[acc.length - 1] = last + ' ' + sentence
          } else {
            acc.push(sentence)
          }
          return acc
        }, [])
    }
    for (const para of paragraphs) {
      const p = document.createElement('p')
      p.textContent = para
      content.appendChild(p)
    }
    if (!content.childNodes.length) content.textContent = text
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
      body: JSON.stringify({ transcript, history: conversationHistory.slice(-MAX_HISTORY) }),
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
    autoNameSession(transcript)

    if (data.audio_b64 && ttsEnabled) playBase64Wav(data.audio_b64)
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

textInput.addEventListener('paste', (e) => {
  e.preventDefault()
  const pasted = e.clipboardData
    ? e.clipboardData.getData('text/plain')
    : window.electronAPI.readClipboard()
  if (!pasted) return
  const start = textInput.selectionStart
  const end = textInput.selectionEnd
  const before = textInput.value.slice(0, start)
  const after = textInput.value.slice(end)
  textInput.value = before + pasted + after
  textInput.selectionStart = textInput.selectionEnd = start + pasted.length
  textInput.dispatchEvent(new Event('input'))
})

textInput.addEventListener('input', () => {
  textInput.style.height = 'auto'
  textInput.style.height = Math.min(textInput.scrollHeight, 200) + 'px'
})

async function sendTextMessage(text) {
  if (isProcessing || isRecording) return

  textInput.value = ''
  textInput.style.height = 'auto'
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
      body: JSON.stringify({ transcript: text, history: conversationHistory.slice(-MAX_HISTORY) }),
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
      autoNameSession(text)

      if (data.audio_b64 && ttsEnabled) playBase64Wav(data.audio_b64)
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

// ── Settings menu ─────────────────────────────────────────────────────────────
let settingsView = 'main'  // 'main' or 'speed'
let ttsEnabled   = true

function buildSettingsMenu() {
  settingsMenu.innerHTML = ''

  if (settingsView === 'speed') {
    const back = document.createElement('button')
    back.className = 'settings-menu__item settings-menu__back'
    back.innerHTML = `<span class="settings-menu__arrow">‹</span> Playback speed`
    back.addEventListener('click', (e) => { e.stopPropagation(); settingsView = 'main'; buildSettingsMenu() })
    settingsMenu.appendChild(back)

    const divider = document.createElement('div')
    divider.className = 'settings-menu__divider'
    settingsMenu.appendChild(divider)

    for (const s of SPEEDS) {
      const item = document.createElement('button')
      item.className = 'settings-menu__item' + (s === playbackSpeed ? ' settings-menu__item--active' : '')
      item.textContent = s === 1 ? '1× Normal' : `${s}×`
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        playbackSpeed = s
        if (currentAudio) currentAudio.playbackRate = s
        settingsView = 'main'
        buildSettingsMenu()
      })
      settingsMenu.appendChild(item)
    }
    return
  }

  // Main settings view
  const speedItem = document.createElement('button')
  speedItem.className = 'settings-menu__item settings-menu__nav'
  speedItem.innerHTML = `<span>Playback speed</span><span class="settings-menu__value">${playbackSpeed === 1 ? 'Normal' : `${playbackSpeed}×`}<span class="settings-menu__arrow">›</span></span>`
  speedItem.addEventListener('click', (e) => { e.stopPropagation(); settingsView = 'speed'; buildSettingsMenu() })
  settingsMenu.appendChild(speedItem)

  const divider = document.createElement('div')
  divider.className = 'settings-menu__divider'
  settingsMenu.appendChild(divider)

  const ttsItem = document.createElement('button')
  ttsItem.className = 'settings-menu__item settings-menu__toggle'
  ttsItem.innerHTML = `<span>Read aloud</span><span class="settings-menu__switch ${ttsEnabled ? 'settings-menu__switch--on' : ''}"></span>`
  ttsItem.addEventListener('click', (e) => {
    e.stopPropagation()
    ttsEnabled = !ttsEnabled
    if (!ttsEnabled) stopAudio()
    buildSettingsMenu()
  })
  settingsMenu.appendChild(ttsItem)
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  settingsView = 'main'
  buildSettingsMenu()
  settingsMenu.classList.toggle('hidden')
})

document.addEventListener('click', () => settingsMenu.classList.add('hidden'))

// ── Chat sessions ────────────────────────────────────────────────────────────
function getActiveSession() {
  return chatSessions.find(s => s.id === activeChatId)
}

function autoNameSession(firstMsg) {
  const session = getActiveSession()
  if (session.history.length > 2) return
  const words = firstMsg.split(/\s+/).slice(0, 5).join(' ')
  session.name = words.length > 30 ? words.slice(0, 30) + '…' : words
  renderChatSelect()
}

function renderChatSelect() {
  chatSelect.innerHTML = ''
  for (const s of chatSessions) {
    const opt = document.createElement('option')
    opt.value = s.id
    opt.textContent = s.name
    if (s.id === activeChatId) opt.selected = true
    chatSelect.appendChild(opt)
  }
}

function saveBubbles() {
  const session = getActiveSession()
  if (session) session.bubbles = chat.innerHTML
}

function switchToChat(id) {
  saveBubbles()
  activeChatId = id
  const session = getActiveSession()
  conversationHistory = session.history
  chat.innerHTML = session.bubbles || ''
  chat.scrollTop = chat.scrollHeight
  renderChatSelect()
}

newChatBtn.addEventListener('click', () => {
  saveBubbles()
  const session = { id: nextChatId++, name: `Chat ${chatSessions.length + 1}`, history: [], bubbles: '' }
  chatSessions.push(session)
  switchToChat(session.id)
})

deleteChatBtn.addEventListener('click', () => {
  if (chatSessions.length <= 1) return
  chatSessions = chatSessions.filter(s => s.id !== activeChatId)
  switchToChat(chatSessions[chatSessions.length - 1].id)
})

chatSelect.addEventListener('change', () => {
  switchToChat(Number(chatSelect.value))
})

clearBtn.addEventListener('click', () => {
  const session = getActiveSession()
  session.history = []
  session.bubbles = ''
  conversationHistory = session.history
  chat.innerHTML = ''
})

// ── Boot ──────────────────────────────────────────────────────────────────────
window.electronAPI.onPyLog((line) => console.log(`%c[py] ${line}`, 'color:#7c6af5'))
buildSettingsMenu()
renderChatSelect()
pollHealth()
