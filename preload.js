// ===== Мост между интерфейсом (HTML) и "начинкой" (main.js) =====
// Даёт интерфейсу безопасный доступ к входу и запуску игры.
// Редактировать не нужно.

const { contextBridge, ipcRenderer } = require("electron");

// Сообщаем начинке, что страница отрисована и шрифты на месте: по этому сигналу
// закрывается загрузочный экран и показывается само окно лаунчера. Разметку это
// не задевает — сигнал уходит отсюда, из моста.
window.addEventListener("load", () => {
  // Через requestAnimationFrame сигнал слать НЕЛЬЗЯ: пока окно скрыто, кадры не
  // рисуются вовсе, и вызов не наступает никогда — окно висело до страховки в 9 с.
  let sent = false;
  const fire = () => setTimeout(() => {
    if (sent) return; sent = true;
    try { ipcRenderer.send("ui-ready"); } catch (e) {}
  }, 60);
  const fonts = document.fonts && document.fonts.ready;
  if (fonts && fonts.then) fonts.then(fire, fire); else fire();
  setTimeout(fire, 3000);   // шрифты не пришли из сети — ждать их дальше незачем
});

contextBridge.exposeInMainWorld("javelin", {
  // вход через Microsoft -> вернёт { name, uuid }
  login: () => ipcRenderer.invoke("login"),
  restoreSession: () => ipcRenderer.invoke("restore-session"),
  // сколько памяти и ядер у игрока -> { ok, totalGb, cores }
  sysInfo: () => ipcRenderer.invoke("sys-info"),
  // каталог модов: поиск, установка, обновление списка
  catalogSearch: (q, mc, loader, offset, exact, limit, type) => ipcRenderer.invoke("catalog-search", q, mc, loader, offset, exact, limit, type),
  catalogInstall: (slug, mc, loader, packId, type) => ipcRenderer.invoke("catalog-install", slug, mc, loader, packId, type),
  // свои сборки модов: список, создание, папка, моды внутри
  packsList: () => ipcRenderer.invoke("packs-list"),
  packsCreate: (data) => ipcRenderer.invoke("packs-create", data),
  packsUpdate: (id, data) => ipcRenderer.invoke("packs-update", id, data),
  packsDelete: (id) => ipcRenderer.invoke("packs-delete", id),
  packsOpen: (id) => ipcRenderer.invoke("packs-open", id),
  packsMods: (id) => ipcRenderer.invoke("packs-mods", id),
  packsModRemove: (id, name) => ipcRenderer.invoke("packs-mod-remove", id, name),
  packsForgeBuilds: (mc) => ipcRenderer.invoke("packs-forge-builds", mc),
  // всё содержимое сборки по видам + удаление вещей и самой сборки
  packsContent: (id) => ipcRenderer.invoke("packs-content", id),
  packsItemRemove: (id, where, name) => ipcRenderer.invoke("packs-item-remove", id, where, name),
  packsDeleteFiles: (id) => ipcRenderer.invoke("packs-delete-files", id),
  // ход скачивания из каталога: проценты
  onCatalogProgress: (cb) => ipcRenderer.on("catalog-progress", (e, p) => cb(p)),
  // перевод описаний модов на язык лаунчера
  translateTexts: (texts, lang) => ipcRenderer.invoke("translate-texts", texts, lang),
  // страница мода в браузере (для модов, которые нельзя скачать из лаунчера)
  openModPage: (url) => ipcRenderer.invoke("open-mod-page", url),
  catalogRefresh: (mc, loader) => ipcRenderer.invoke("catalog-refresh", mc, loader),
  catalogProject: (slug) => ipcRenderer.invoke("catalog-project", slug),
  catalogTags: () => ipcRenderer.invoke("catalog-tags"),
  catalogWarmup: (mc, loader) => ipcRenderer.invoke("catalog-warmup", mc, loader),
  onCatalogLog: (cb) => ipcRenderer.on("catalog-log", (e, m) => cb(m)),
  // настройка «мощная видеокарта для игры» -> { ok, high, supported }
  gpuPrefGet: () => ipcRenderer.invoke("gpu-pref-get"),
  gpuPrefSet: (high) => ipcRenderer.invoke("gpu-pref-set", high),
  logout: () => ipcRenderer.invoke("logout"),
  // запуск игры (можно передать { ram, version, serverIp ... } чтобы переопределить config.json)
  launch: (opts) => ipcRenderer.invoke("launch", opts),
  // синхронизация модов с сервером (скачать/удалить лишнее) -> { ok, count, downloaded, removed }
  syncMods: (opts) => ipcRenderer.invoke("sync-mods", opts),
  // только список модов сервера для показа на экране (без скачивания) -> { ok, mods:[{name,size}] }
  listMods: () => ipcRenderer.invoke("list-mods"),
  // отличается ли сборка игрока от серверной -> { ok, needsUpdate, missing, changed, extra, extrasChanged }
  modsStatus: (opts) => ipcRenderer.invoke("mods-status", opts),
  // запросы к Supabase через начинку лаунчера (регистрация, вход, новости)
  sbRpc: (fn, args) => ipcRenderer.invoke("sb-rpc", fn, args),
  sbGet: (path) => ipcRenderer.invoke("sb-get", path),
  sbUpload: (bucket, path, base64, mime) => ipcRenderer.invoke("sb-upload", bucket, path, base64, mime),
  // ===== обновления лаунчера =====
  // ручная проверка (кнопка "Проверить")
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  // скачать найденный патч (зелёная кнопка "Обновить лаунчер")
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  // установить скачанное обновление и перезапустить лаунчер
  installUpdate: () => ipcRenderer.invoke("install-update"),
  // открыть страницу релизов на GitHub (ручная загрузка, если авто-загрузка застряла)
  openReleasePage: () => ipcRenderer.invoke("open-release-page"),
  openModsPage: () => ipcRenderer.invoke("open-mods-page"),
  // постоянный id этой копии лаунчера (нужен счётчику онлайна)
  clientId: () => ipcRenderer.invoke("client-id"),
  // настоящий сайт Ely.by в окне лаунчера: смена ника и пароля
  openElyProfile: (sub) => ipcRenderer.invoke("open-ely-profile", sub),
  // узнать текущий ник по UUID (после смены ника на сайте)
  elyName: (uuid) => ipcRenderer.invoke("ely-name", uuid),
  onElyProfileClosed: (cb) => ipcRenderer.on("ely-profile-closed", () => cb()),
  getVersions: () => ipcRenderer.invoke("get-versions"),
  isVersionInstalled: (id) => ipcRenderer.invoke("is-version-installed", id),
  // какие версии поддерживают Forge/Fabric, что уже скачано, удаление сборки
  getLoaders: () => ipcRenderer.invoke("get-loaders"),
  listOptifine: () => ipcRenderer.invoke("list-optifine"),
  cancelLaunch: () => ipcRenderer.invoke("cancel-launch"),
  // режим игрока: свои моды и шейдеры
  playerModsList: (v, l) => ipcRenderer.invoke("player-mods-list", v, l),
  playerModsAdd: (v, l) => ipcRenderer.invoke("player-mods-add", v, l),
  playerModsRemove: (v, l, name) => ipcRenderer.invoke("player-mods-remove", v, l, name),
  playerShadersList: (v, l) => ipcRenderer.invoke("player-shaders-list", v, l),
  playerShadersAdd: (v, l) => ipcRenderer.invoke("player-shaders-add", v, l),
  playerShadersRemove: (v, l, name) => ipcRenderer.invoke("player-shaders-remove", v, l, name),
  playerOpenFolder: (v, l) => ipcRenderer.invoke("player-open-folder", v, l),
  // папки сборки режима игрока (mods/config/saves/logs/...) — своя, отдельная от серверной
  playerOpenDir: (v, l, which) => ipcRenderer.invoke("player-open-dir", v, l, which),
  // общие файлы игры (versions/assets/libraries) — одни на все сборки
  openSharedDir: (which) => ipcRenderer.invoke("open-shared-dir", which),
  // папки полной серверной сборки — используются только в админ-консоли
  serverOpenDir: (v, l, which) => ipcRenderer.invoke("server-open-dir", v, l, which),
  // собрать extras.zip из папок сборки (config, tacz и т.п.) — тоже только админка
  buildExtras: (v, l) => ipcRenderer.invoke("build-extras", v, l),
  listInstances: () => ipcRenderer.invoke("list-instances"),
  deleteInstance: (id) => ipcRenderer.invoke("delete-instance", id),
  // подписки на события из игры/обновлений
  onLog: (cb) => ipcRenderer.on("mc-log", (e, l) => cb(l)),
  onProgress: (cb) => ipcRenderer.on("mc-progress", (e, p) => cb(p)),
  onModProgress: (cb) => ipcRenderer.on("mc-modprogress", (e, p) => cb(p)),
  onClosed: (cb) => ipcRenderer.on("mc-closed", (e, c) => cb(c)),
  // разобранная причина вылета — приходит перед mc-closed
  onReason: (cb) => ipcRenderer.on("mc-reason", (e, r) => cb(r)),
  // игра действительно запустилась (а не «идёт подготовка»)
  onStarted: (cb) => ipcRenderer.on("mc-started", (e, v) => cb(v)),
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (e, v) => cb(v)),
  onUpdateNone: (cb) => ipcRenderer.on("update-none", () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (e, p) => cb(p)),
  onUpdateReady: (cb) => ipcRenderer.on("update-ready", (e, v) => cb(v)),
  onUpdateError: (cb) => ipcRenderer.on("update-error", (e, m) => cb(m))
});
