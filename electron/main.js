const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

// Suppress EPIPE so a broken terminal pipe never crashes the main process
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err })

const PYTHON_BIN = process.platform === 'win32'
  ? path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe')
  : path.join(__dirname, '..', 'venv', 'bin', 'python')
const SERVER_PORT = 8765

let mainWindow = null
let pythonProcess = null

function startPythonServer() {
  pythonProcess = spawn(
    PYTHON_BIN,
    ['-m', 'uvicorn', 'server:app',
      '--host', '127.0.0.1',
      '--port', String(SERVER_PORT),
      '--workers', '1'],
    { cwd: path.join(__dirname, '..'), shell: process.platform === 'win32' }
  )

  // Forward Python output to terminal AND renderer DevTools console
  const forward = (data) => {
    const lines = data.toString().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try { process.stdout.write(`[py] ${line}\n`) } catch (_) {}
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('py-log', line)
        }
      } catch (_) {}
    }
  }

  pythonProcess.stdout.on('data', forward)
  pythonProcess.stderr.on('data', forward)
  pythonProcess.on('exit', (code) => {
    const msg = `[py] process exited with code ${code}`
    console.log(msg)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-log', msg)
    }
  })
}

function buildMenu() {
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { type: 'separator' },
        {
          label: 'Toggle DevTools',
          accelerator: 'F12',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Open DevTools (Python logs visible here)',
          accelerator: 'F12',
          click: () => mainWindow && mainWindow.webContents.openDevTools(),
        },
        { type: 'separator' },
        {
          label: `Server URL: http://127.0.0.1:${SERVER_PORT}`,
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'Restart Python Server',
          click: () => {
            if (pythonProcess) pythonProcess.kill('SIGTERM')
            setTimeout(startPythonServer, 500)
            if (mainWindow) mainWindow.webContents.reload()
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    backgroundColor: '#0f0f1a',
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  buildMenu()
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  startPythonServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill('SIGTERM')
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
