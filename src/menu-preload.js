const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('menu', {
  onEntries: fn => ipcRenderer.on('menu-entries', (_e, data) => fn(data)),
  size: (width, height) => ipcRenderer.send('menu-size', { width, height }),
  choose: id => ipcRenderer.send('menu-choose', id),
  close: () => ipcRenderer.send('menu-close'),
})
