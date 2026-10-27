const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whale', {
  onUsage: fn => ipcRenderer.on('usage', (_e, usage) => fn(usage)),
  onConfig: fn => ipcRenderer.on('config', (_e, config) => fn(config)),
  onShowBubble: fn => ipcRenderer.on('show-bubble', () => fn()),
  mouseOverPet: over => ipcRenderer.send('mouse-over-pet', over),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  resizeStep: direction => ipcRenderer.send('resize-step', direction),
})
