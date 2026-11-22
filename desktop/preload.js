/**
 * The one thing the page can ask of the window: the title bar's colours, so
 * the bar matches the theme the app is showing (src/ui/app/useShellTheme.js).
 * Nothing else crosses: no Node, no file system, no other message.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meterShell", {
  setTitleBar: ({ color, symbol } = {}) => ipcRenderer.send("meter:title-bar", { color, symbol }),
});
