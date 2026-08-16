// ===== Мост для окна входа Ely.by =====
// Окно ely-login.html общается с "начинкой" (main.js) через эти каналы.
// Редактировать не нужно.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ely", {
  submit: (username, password) => ipcRenderer.send("ely-submit", { username: username, password: password }),
  cancel: () => ipcRenderer.send("ely-cancel"),
  onError: (cb) => ipcRenderer.on("ely-error", (e, m) => cb(m))
});
