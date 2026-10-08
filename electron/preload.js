const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getServerUrl: () => 'http://127.0.0.1:8765',
  onPyLog: (callback) => ipcRenderer.on('py-log', (_event, line) => callback(line)),
  copyToClipboard: (text) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
})
