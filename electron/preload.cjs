const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  get: () => ipcRenderer.invoke('pulse:get'),
  refresh: () => ipcRenderer.invoke('pulse:refresh'),
  login: () => ipcRenderer.invoke('pulse:login'),
  settings: patch => ipcRenderer.invoke('pulse:settings', patch),
  layout: (single, credits, usage) => ipcRenderer.invoke('pulse:layout', { single, credits, usage }),
  hide: () => ipcRenderer.send('pulse:hide'),
  quit: () => ipcRenderer.send('pulse:quit'),
  drag: action => ipcRenderer.send('pulse:drag', action),
  /** 仅转发界面所需状态，返回取消订阅方法。 */
  subscribe(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pulse:state', listener);
    return () => ipcRenderer.removeListener('pulse:state', listener);
  },
});
