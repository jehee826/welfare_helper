const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", Object.freeze({
  command: (action, payload) => ipcRenderer.invoke("panel:command", action, payload),
  layoutVersion: () => ipcRenderer.invoke("stage:version"),
  onMeasure: callback => {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on("stage:measure", listener);
    return () => ipcRenderer.removeListener("stage:measure", listener);
  },
  reportTarget: rect => ipcRenderer.send("stage:target", rect),
  clicked: () => ipcRenderer.send("stage:clicked"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("panel:state", listener);
    return () => ipcRenderer.removeListener("panel:state", listener);
  },
}));
