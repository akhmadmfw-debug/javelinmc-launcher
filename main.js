// ===== JavelinMC launcher — главный процесс (Node.js) =====
// Вход через Ely.by (бесплатные аккаунты), запуск Minecraft, автообновление.
// Настройки сервера — в файле config.json. Этот файл редактировать не нужно.

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("minecraft-launcher-core");
const { autoUpdater } = require("electron-updater");
const { execFile } = require("child_process");

// На части домашних сетей IPv6 объявлен, но фактически не работает. Node в таком
// случае честно пытается ходить по IPv6 и падает с невнятным «fetch failed».
// Просим сначала пробовать IPv4 — это снимает добрую половину жалоб на вход.
try { require("dns").setDefaultResultOrder("ipv4first"); } catch (e) {}

// Сеть у игроков часто «моргает»: один неудачный запрос ещё не значит, что всё сломано.
// Пробуем несколько раз с нарастающей паузой и со своим ограничением по времени —
// иначе запрос может висеть минутами, а игрок думает, что лаунчер завис.
async function fetchRetry(url, opts, tries) {
  tries = tries || 3;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 15000);
      try {
        return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }));
      } finally { clearTimeout(timer); }
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw last || new Error("нет связи");
}

// Понятное объяснение вместо «Ошибка сети: fetch failed». Игрок должен видеть,
// что именно ему делать, а не техническую строчку.
function netErrorText(err) {
  const raw = String((err && err.message) || err || "");
  const code = String((err && err.cause && err.cause.code) || "");
  const all = raw + " " + code;
  if (/abort|timeout|ETIMEDOUT/i.test(all))
    return "Ely.by не ответил вовремя. Проверь интернет и попробуй ещё раз.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(all))
    return "Не удаётся найти сервер Ely.by. Обычно это интернет или DNS: перезапусти роутер либо смени DNS на 8.8.8.8.";
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ECONNABORTED/i.test(all))
    return "Связь с Ely.by оборвалась. Чаще всего мешает антивирус или VPN — отключи их и попробуй снова.";
  if (/certificate|self.signed|TLS|SSL|UNABLE_TO_VERIFY/i.test(all))
    return "Антивирус вмешивается в защищённое соединение с Ely.by. Отключи в нём проверку HTTPS или добавь лаунчер в исключения.";
  if (/fetch failed/i.test(all))
    return "Нет связи с Ely.by. Проверь интернет, выключи VPN и добавь лаунчер в исключения антивируса.";
  return "Ошибка сети: " + raw;
}

const launcher = new Client();
let win = null;

// Последняя линия обороны. Если где-то в начинке всё-таки вылетит необработанная
// ошибка, Electron показывает игроку страшное окно «A JavaScript error occurred in
// the main process». Ничего полезного оно не сообщает, зато пугает. Теперь такие
// ошибки просто пишутся в файл, а лаунчер продолжает работать.
function crashLog(tag, err) {
  try {
    const dir = app.getPath("userData");
    const line = "[" + new Date().toISOString() + "] " + tag + ": " +
      ((err && (err.stack || err.message)) || String(err)) + "\n";
    fs.appendFileSync(path.join(dir, "errors.log"), line);
  } catch (e) { /* даже записать не смогли — молчим */ }
  try { console.error(tag, err); } catch (e) {}
}
process.on("uncaughtException", (err) => crashLog("Сбой в начинке", err));
process.on("unhandledRejection", (err) => crashLog("Незавершённая операция", err));

// Безопасная отправка в интерфейс. Раньше сюда писали напрямую, и если игрок
// закрывал лаунчер во время игры, движок Minecraft продолжал присылать события
// в уже уничтоженное окно — Electron показывал ошибку. Теперь молча пропускаем.
function sendUI(channel) {
  try {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send.apply(wc, arguments);
  } catch (e) { /* окно уже закрыто — ничего страшного */ }
}
let authToken = null;     // данные входа игрока (Ely.by)
let clientToken = null;   // постоянный идентификатор клиента
let activeProc = null;    // текущий запущенный процесс игры (чтобы не было двух Minecraft сразу)
let launchGen = 0;        // поколение запуска: новый запуск отменяет старый

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
  } catch (e) {
    return { serverIp: "", serverPort: 25565, version: "1.20.1", type: "release", ram: 7, forgeInstaller: "", authlibInjector: "authlib-injector.jar" };
  }
}

// постоянный clientToken (нужен Ely.by), хранится в данных приложения
function getClientToken() {
  if (clientToken) return clientToken;
  const f = path.join(app.getPath("userData"), "client-token.txt");
  try { clientToken = fs.readFileSync(f, "utf-8").trim(); } catch (e) {}
  if (!clientToken) {
    clientToken = crypto.randomUUID();
    try { fs.writeFileSync(f, clientToken); } catch (e) {}
  }
  return clientToken;
}

// ===== запоминание входа Ely.by (храним только токены, НЕ пароль) =====
function accountFile() { return path.join(app.getPath("userData"), "account.json"); }
function saveAccount(t) {
  try {
    fs.writeFileSync(accountFile(), JSON.stringify({
      access_token: t.access_token, client_token: t.client_token, uuid: t.uuid, name: t.name
    }));
  } catch (e) {}
}
function loadSavedAccount() {
  try { return JSON.parse(fs.readFileSync(accountFile(), "utf-8")); } catch (e) { return null; }
}
function clearAccount() { try { fs.unlinkSync(accountFile()); } catch (e) {} }

// ===== ЗАГРУЗОЧНЫЙ ЭКРАН =====
// Пока главное окно готовится (а это пара секунд: страница большая, шрифты
// тянутся из сети), игрок видел сначала мелькнувшую сверху пустую рамку, потом
// чёрный прямоугольник. Теперь вместо этого сразу показывается маленькое окно
// с надписью JavelinMC — то же оформление, что и при смене темы.
let splash = null;

function openSplash() {
  try {
    splash = new BrowserWindow({
      width: 460, height: 260,
      frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, center: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    splash.removeMenu();
    splash.once("ready-to-show", () => { try { splash.show(); } catch (e) {} });
    splash.loadFile(path.join(__dirname, "splash.html"));
  } catch (e) { splash = null; }
}

function closeSplash() {
  if (!splash) return;
  const s = splash; splash = null;
  // Убираем сразу, без плавного угасания. Гасили плавно — и заставка ещё треть
  // секунды висела поверх уже открытого лаунчера: игрок видел на экране сразу
  // и то, и другое. Прячем и показываем лаунчер в один и тот же миг — тогда
  // заставка не «уходит», а просто сменяется лаунчером.
  try { if (!s.isDestroyed()) s.hide(); } catch (e) {}
  setTimeout(() => { try { if (!s.isDestroyed()) s.destroy(); } catch (e) {} }, 250);
}

function createWindow() {
  // Сразу создаём окно размером под экран. Раньше окно делалось 1280x800, а потом
  // разворачивалось — страница верстался дважды, и это было заметно при открытии.
  let startW = 1280, startH = 800;
  try {
    const { screen } = require("electron");
    const wa = screen.getPrimaryDisplay().workAreaSize;
    if (wa && wa.width > 900 && wa.height > 600) { startW = wa.width; startH = wa.height; }
  } catch (e) { /* нет доступа к экрану — останутся размеры по умолчанию */ }

  // Окно сразу создаём на месте и по размеру рабочего стола. Раньше оно
  // разворачивалось уже показанным: страница пересчитывалась на лету, и по краям
  // успевали мелькнуть чёрные полосы.
  let startX, startY;
  try {
    const { screen } = require("electron");
    const wa = screen.getPrimaryDisplay().workArea;
    if (wa) { startX = wa.x; startY = wa.y; }
  } catch (e) {}

  win = new BrowserWindow({
    width: startW,
    height: startH,
    x: startX,
    y: startY,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,          // 1.0.40: окно можно тянуть и разворачивать на весь экран
    maximizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#05060f",
    // свой значок в окне и на панели задач вместо стандартного электронного
    icon: path.join(__dirname, "icon.png"),
    show: false,              // не показываем пустое окно: иначе видно белый «мигающий» кадр
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Разворачиваем на весь экран ПОКА ОКНО СКРЫТО: тогда страница сразу верстается
  // под полный размер. На Windows maximize() умеет показать скрытое окно, и её
  // как раз и видно той самой плашкой, мелькающей сверху доли секунды. Поэтому
  // перед разворотом делаем окно полностью прозрачным: показывать нечего.
  try { win.setOpacity(0); } catch (e) {}
  try { win.maximize(); win.hide(); } catch (e) {}
  win.removeMenu();
  // ВАЖНО: maximize() НЕ вызываем до показа. На Windows этот вызов сам делает
  // скрытое окно видимым — и игрок успевал увидеть пустое белое окно ещё до того,
  // как страница вообще начала загружаться. Разворачиваем уже готовое окно.
  let shown = false;
  const bornAt = Date.now();
  const showOnce = () => {
    if (shown) return; shown = true;
    // Загрузочный экран держим хотя бы 900 мс — иначе на быстрой машине он
    // просто мигнёт, а мигание мы как раз и убираем.
    const left = Math.max(0, 900 - (Date.now() - bornAt));
    setTimeout(() => {
      // Окно уже развёрнуто и свёрстано — возвращаем видимость и показываем.
      // Разворот сделан ДО показа, иначе по краям мелькают чёрные полосы.
      // Показываем окно ещё прозрачным и даём ему нарисовать первый настоящий
      // кадр. Если показать и сразу проявить, между показом и первым кадром
      // успевает мелькнуть пустой прямоугольник — то чёрный, то белый.
      try { win.setOpacity(0); win.show(); } catch (e) {}
      setTimeout(() => {
        // Заставку убираем и лаунчер проявляем ОДНИМ ходом, без промежуточных
        // шагов: иначе одно наползает на другое и видно сразу оба. К этому
        // моменту окно уже нарисовано, показывать его целиком безопасно.
        closeSplash();
        try { win.setOpacity(1); win.focus(); } catch (e) {}
      }, 200);
    }, left);
  };
  // ready-to-show срабатывает, когда страница только-только получила первый кадр —
  // на нём лаунчер ещё чёрный. Ждём сигнала от самой страницы: она сообщает, что
  // всё отрисовано и шрифты подгружены. Сигнал шлёт preload.js, разметку не трогаем.
  ipcMain.once("ui-ready", showOnce);
  // На ready-to-show полагаться нельзя: скрытому окну оно приходит только после
  // показа. Запасной отсчёт ведём от загрузки страницы.
  win.webContents.once("did-finish-load", () => setTimeout(showOnce, 3000));
  setTimeout(showOnce, 8000);            // страховка: не оставлять окно невидимым
  // F12 — консоль, F11 — полноэкранный режим
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      win.webContents.toggleDevTools();
    }
    if (input.type === "keyDown" && input.key === "F11") {
      try { win.setFullScreen(!win.isFullScreen()); } catch (e) {}
    }
  });
  win.loadFile(path.join(__dirname, "javelinmc-launcher.html"));
}

app.whenReady().then(() => {
  openSplash();   // сначала загрузочный экран, потом уже долгая сборка главного окна
  createWindow();
  // тихая проверка при запуске: если есть патч — кнопка в интерфейсе загорится зелёным
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 2500);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ===== ВХОД через Ely.by =====
// Открывает маленькое окно входа (логин/пароль Ely.by), проверяет на сервере Ely.by.
let activeLoginWin = null; // не открывать второе окно входа, пока открыто одно
ipcMain.handle("login", async () => {
  if (activeLoginWin && !activeLoginWin.isDestroyed()) {
    try { activeLoginWin.focus(); } catch (e) {}
    return Promise.reject(new Error("Окно входа Ely.by уже открыто"));
  }
  return new Promise((resolve, reject) => {
    const loginWin = new BrowserWindow({
      width: 430, height: 520, resizable: false, parent: win, modal: true,
      autoHideMenuBar: true, title: "Вход в аккаунт", backgroundColor: "#0b0918",
      webPreferences: {
        preload: path.join(__dirname, "ely-preload.js"),
        contextIsolation: true, nodeIntegration: false
      }
    });
    activeLoginWin = loginWin;
    loginWin.removeMenu();
    loginWin.loadFile(path.join(__dirname, "ely-login.html"));

    let done = false;
    function cleanup() {
      ipcMain.removeListener("ely-submit", onSubmit);
      ipcMain.removeListener("ely-cancel", onCancel);
    }

    async function onSubmit(e, creds) {
      try {
        const res = await fetchRetry("https://authserver.ely.by/auth/authenticate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: { name: "Minecraft", version: 1 },
            username: creds.username,
            password: creds.password,
            clientToken: getClientToken(),
            requestUser: true
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.accessToken || !data.selectedProfile) {
          const msg = (data && data.errorMessage) ? data.errorMessage : "Неверный логин или пароль Ely.by";
          if (!loginWin.isDestroyed()) loginWin.webContents.send("ely-error", msg);
          return;
        }
        authToken = mkAuth(data.accessToken, getClientToken(), data.selectedProfile.id, data.selectedProfile.name);
        saveAccount(authToken); // запоминаем вход, чтобы не логиниться снова
        done = true; cleanup();
        if (!loginWin.isDestroyed()) loginWin.close();
        resolve({ name: authToken.name, uuid: authToken.uuid });
      } catch (err) {
        if (!loginWin.isDestroyed()) loginWin.webContents.send("ely-error", netErrorText(err));
      }
    }
    function onCancel() {
      done = true; cleanup();
      if (!loginWin.isDestroyed()) loginWin.close();
      reject(new Error("Вход отменён"));
    }

    ipcMain.on("ely-submit", onSubmit);
    ipcMain.on("ely-cancel", onCancel);
    loginWin.on("closed", () => { activeLoginWin = null; if (!done) { cleanup(); reject(new Error("Вход отменён")); } });
  });
});

// собрать объект авторизации для движка Minecraft
function mkAuth(access, client, uuid, name) {
  return {
    access_token: access,
    client_token: client,
    uuid: uuid,
    name: name,
    user_properties: "{}",
    meta: { type: "msa" }
  };
}

// запрос к серверу Ely.by с повторами: сетевой сбой != «токен мёртв».
// Возвращает { status, data } если сервер ответил, либо { netFail: true } если связи нет.
async function elyPost(pathname, bodyObj, tries) {
  tries = tries || 3;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchRetry("https://authserver.ely.by" + pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj)
      });
      const text = await res.text().catch(() => "");
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {}
      return { status: res.status, data: data };
    } catch (e) {
      // нет интернета / DNS не отвечает — ждём и пробуем ещё раз
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return { netFail: true };
}

// Восстановить вход при старте — так, чтобы окно Ely.by больше не всплывало.
// Порядок действий:
//   1) /auth/validate — токен ещё живой? Тогда ничего не трогаем (важно: refresh
//      каждый раз меняет токен, и две копии лаунчера начинали выбивать друг друга).
//   2) протух — продлеваем через /auth/refresh (с повторами при сетевых сбоях).
//   3) сети нет — работаем со старым токеном, вход не спрашиваем.
//   4) только если Ely.by прямо ответил «токен недействителен» — просим войти заново.
// Возвращает { name, uuid, source } или null (null = нужен обычный вход).
// настройка видеокарты: прочитать и записать (для раздела «Настройки»)
ipcMain.handle("gpu-pref-get", () => {
  const p = readGpuPref();
  return { ok: true, high: p ? !!p.high : true, supported: process.platform === "win32" };
});
ipcMain.handle("gpu-pref-set", (e, high) => {
  writeGpuPref({ high: !!high });
  return { ok: true, high: !!high };
});

// сколько оперативной памяти реально стоит у игрока (для ограничения ползунка)
ipcMain.handle("sys-info", async () => {
  try {
    const os = require("os");
    // safeGb — сколько реально можно отдать игре. Ползунок раньше доходил до
    // всей памяти машины, и выставленный максимум ломал запуск.
    return { ok: true, totalGb: Math.round(os.totalmem() / 1073741824),
             safeGb: safeMaxGb(), cores: os.cpus().length };
  } catch (e) { return { ok: false, totalGb: 0, cores: 0 }; }
});

ipcMain.handle("restore-session", async () => {
  const saved = loadSavedAccount();
  if (!saved || !saved.access_token) return null;
  const ct = saved.client_token || getClientToken();

  // 1) токен ещё действителен? (200/204 = да, тело пустое)
  const v = await elyPost("/auth/validate", { accessToken: saved.access_token, clientToken: ct }, 2);
  if (v.status === 200 || v.status === 204) {
    authToken = mkAuth(saved.access_token, ct, saved.uuid, saved.name);
    return { name: saved.name, uuid: saved.uuid, source: "valid" };
  }

  // 2) сервер ответил, но токен просрочен — продлеваем
  if (!v.netFail) {
    const r = await elyPost("/auth/refresh", { accessToken: saved.access_token, clientToken: ct, requestUser: true }, 3);
    if (r.status === 200 && r.data && r.data.accessToken && r.data.selectedProfile) {
      authToken = mkAuth(r.data.accessToken, r.data.clientToken || ct, r.data.selectedProfile.id, r.data.selectedProfile.name);
      saveAccount(authToken);
      return { name: authToken.name, uuid: authToken.uuid, source: "refreshed" };
    }
    // 4) Ely.by сказал «такого токена нет» (сменили пароль / вход с другого места)
    if (r.status && r.status >= 400 && r.status < 500) {
      clearAccount();
      authToken = null;
      return null;
    }
  }

  // 3) связи нет или Ely.by лежит — оставляем сохранённый вход как есть
  authToken = mkAuth(saved.access_token, ct, saved.uuid, saved.name);
  return { name: saved.name, uuid: saved.uuid, source: "offline" };
});

// ===== Профиль Ely.by прямо в лаунчере =====
// Открывает НАСТОЯЩУЮ страницу account.ely.by в отдельном окне лаунчера.
// Ник и пароль игрок меняет на их сайте — через наш код они не проходят,
// поэтому украсть их из лаунчера нельзя.
// Страницы аккаунта. Пароль вводится на их сайте — через наш код он не проходит.
const ELY_PAGES = {
  "": "https://account.ely.by/",
  register: "https://account.ely.by/register",
  // восстановление пароля и двухшаговый вход — страницы самого Ely.by:
  // письмо и код отправляет он, у нас нет и не может быть его почты
  forgot: "https://account.ely.by/forgot-password",
  twofa: "https://account.ely.by/two-factor-auth",
  skin: "https://ely.by/skins/add",
  skins: "https://laby.net/ru/skins"      // каталог скинов, открывается тут же
};
const ELY_TITLES = {
  "": "Ник и пароль",
  register: "Создание аккаунта",
  forgot: "Восстановление пароля",
  twofa: "Двухшаговый вход",
  skin: "Смена скина",
  skins: "Каталог скинов"
};
// laby.net и так тёмный и свёрстан под себя — нашу перекраску туда не тащим,
// иначе развалятся карточки скинов.
const ELY_NO_THEME = { skins: true };

// Оформление этих страниц живёт в ely-theme-preload.js: он запускается ДО скриптов
// сайта, поэтому чужой светлый вид не успевает мелькнуть на первом кадре.

// Кнопка «Открыть в браузере» из окна Ely.by (когда капчу режет сеть).
// Открываем ТОЛЬКО адреса самого Ely.by — чужую ссылку страница подсунуть не сможет.
ipcMain.on("jv-open-external", (e, url) => {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:") return;
    if (!/(^|.)ely.by$/i.test(u.hostname)) return;
    shell.openExternal(u.href);
  } catch (err) {}
});

// Страница мода в НАСТОЯЩЕМ браузере. Нужна, когда автор запретил скачивание
// сторонними лаунчерами: скачать за игрока мы не можем и не будем, но довести
// его до страницы обязаны. Пускаем только два сайта каталога.
ipcMain.handle("open-mod-page", async (e, url) => {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:") return { ok: false };
    if (!/(^|\.)(modrinth\.com|curseforge\.com)$/i.test(u.hostname)) return { ok: false };
    shell.openExternal(u.href);
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

let elyProfileWin = null;
let skinsWin = null;
ipcMain.handle("open-ely-profile", async (e, sub) => {
  const raw = String(sub || "");
  const key = Object.prototype.hasOwnProperty.call(ELY_PAGES, raw) ? raw : "";

  // Каталог скинов — своё окно и без перекраски: сайт уже тёмный, а наши стили
  // сделали бы карточки скинов прозрачными.
  if (ELY_NO_THEME[key]) {
    if (skinsWin && !skinsWin.isDestroyed()) { try { skinsWin.focus(); } catch (err) {} return true; }
    skinsWin = new BrowserWindow({
      width: 1180, height: 780, parent: win, autoHideMenuBar: true,
      backgroundColor: "#141414", show: false, title: ELY_TITLES[key],
      webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:skins" }
    });
    skinsWin.removeMenu();
    skinsWin.on("page-title-updated", (ev) => ev.preventDefault());
    skinsWin.once("ready-to-show", () => { try { skinsWin.show(); } catch (err) {} });
    skinsWin.loadURL(ELY_PAGES[key]);
    skinsWin.on("closed", () => { skinsWin = null; });
    return true;
  }

  if (elyProfileWin && !elyProfileWin.isDestroyed()) {
    try { elyProfileWin.focus(); elyProfileWin.loadURL(ELY_PAGES[key]); } catch (err) {}
    return true;
  }
  elyProfileWin = new BrowserWindow({
    width: 1000, height: 720, parent: win, autoHideMenuBar: true,
    backgroundColor: "#0b0918", show: false,
    title: ELY_TITLES[key],
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, partition: "persist:ely",
      // стиль лаунчера ставится ещё до отрисовки страницы — без мигания чужого вида
      preload: path.join(__dirname, "ely-theme-preload.js")
    }
  });
  elyProfileWin.removeMenu();
  // заголовок окна остаётся нашим, а не тем, что пришлёт страница
  elyProfileWin.on("page-title-updated", (ev) => ev.preventDefault());
  elyProfileWin.once("ready-to-show", () => { try { elyProfileWin.show(); } catch (err) {} });
  elyProfileWin.loadURL(ELY_PAGES[key]);
  elyProfileWin.on("closed", () => {
    elyProfileWin = null;
    if (win) sendUI("ely-profile-closed"); // лаунчер проверит, не сменился ли ник
  });
  return true;
});

// Текущий ник по UUID (после смены ника на сайте). UUID при смене ника не меняется,
// поэтому профиль игрока в базе не теряется.
ipcMain.handle("ely-name", async (e, uuid) => {
  try {
    const id = String(uuid || "").replace(/-/g, "");
    if (!id) return null;
    const r = await fetch("https://sessionserver.ely.by/session/minecraft/profile/" + id);
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || !d.name) return null;
    // запоминаем новый ник, чтобы игра запускалась уже под ним
    const saved = loadSavedAccount();
    if (saved && saved.name !== d.name) {
      saved.name = d.name;
      saveAccount(saved);
      if (authToken) authToken.name = d.name;
    }
    return d.name;
  } catch (err) { return null; }
});

// Выйти из игрового аккаунта: забываем сохранённый вход.
ipcMain.handle("logout", async () => {
  clearAccount();
  authToken = null;
  return { ok: true };
});

// ===== СИНХРОНИЗАЦИЯ МОДОВ с Supabase Storage =====
// Скачивает все .jar из бакета в папку mods, лишние .jar удаляет.
// Сравнение по имени и размеру: повторно не качает то, что уже есть.
const https = require("https");

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadToFile(url, headers, destPath, onBytes, _hops) {
  return new Promise((resolve, reject) => {
    _hops = _hops || 0;
    if (_hops > 5) return reject(new Error("Слишком много перенаправлений: " + url));
    const tmp = destPath + ".part";
    const file = fs.createWriteStream(tmp);
    https.get(url, { headers: headers || {} }, (res) => {
      // GitHub отдаёт 302 на objects.githubusercontent.com — идём за редиректом
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        res.resume();
        file.close(); try { fs.unlinkSync(tmp); } catch (e) {}
        return resolve(downloadToFile(res.headers.location, headers, destPath, onBytes, _hops + 1));
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(tmp); } catch (e) {}
        return reject(new Error("HTTP " + res.statusCode + " для " + url));
      }
      const total = parseInt(res.headers["content-length"] || 0, 10) || 0;
      res.on("data", (c) => { if (onBytes) onBytes(c.length, total); });
      res.pipe(file);
      file.on("finish", () => file.close(() => {
        try { fs.renameSync(tmp, destPath); resolve(); }
        catch (e) { reject(e); }
      }));
    }).on("error", (err) => {
      file.close(); try { fs.unlinkSync(tmp); } catch (e) {}
      reject(err);
    });
  });
}

// ===== ГДЕ МЫ ЗАПУЩЕНЫ =====
// Лаунчер собирается и под Windows, и под macOS. Различий немного, но они есть,
// и все они собраны здесь, чтобы не искать их по всему файлу.
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
// Имя запускаемого файла Java. На Windows это javaw.exe — «оконная» Java, она не
// открывает лишнее чёрное окно консоли. На macOS и Linux такого отдельного файла
// нет вовсе, там просто java.
const JAVA_BIN = IS_WIN ? "javaw.exe" : "java";

// Java, вложенная в саму программу. Кладём её только в сборку под Windows:
// это 300 МБ, и она всё равно windows-овская. В сборке под macOS её нет —
// там Java скачивается при первом запуске игры.
function bundledJava() {
  const RES = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(RES, "runtime", "bin", JAVA_BIN);
}

// ===== АВТОПОДБОР JAVA ПОД ВЕРСИЮ =====
// Папка для скачанных Java-рантаймов
function runtimesDir() { return path.join(app.getPath("userData"), "runtimes"); }

// нормализуем требуемую версию Java: 16 -> 17 (16 устарела, 17 совместима), всё <8 -> 8
function normalizeJavaMajor(m) {
  if (!m || m < 8) return 8;
  if (m === 16) return 17;
  return m;
}

// Ищем запускаемый файл Java внутри распакованной папки JRE.
// Раскладка отличается: на Windows это <папка>/bin/javaw.exe, а на macOS Java
// приходит завёрнутой в бандл — <папка>/jdk-17.../Contents/Home/bin/java.
function findJava(dir) {
  const тропы = (base) => IS_MAC
    ? [path.join(base, "bin", JAVA_BIN), path.join(base, "Contents", "Home", "bin", JAVA_BIN)]
    : [path.join(base, "bin", JAVA_BIN)];
  try {
    for (const p of тропы(dir)) if (fs.existsSync(p)) return p;
    for (const e of fs.readdirSync(dir)) {
      const sub = path.join(dir, e);
      let st; try { st = fs.statSync(sub); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      for (const p of тропы(sub)) if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return "";
}

// Распаковка архива с Java. tar есть и в Windows 10+, и в macOS «из коробки»,
// и понимает оба вида архива: .zip у Windows и .tar.gz у macOS. Запасной путь
// через PowerShell имеет смысл только на Windows.
function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xf", archivePath, "-C", destDir], (err) => {
      if (!err) return resolve();
      if (!IS_WIN) return reject(new Error("Не удалось распаковать Java: " + (err.message || err)));
      execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "Expand-Archive -LiteralPath '" + archivePath + "' -DestinationPath '" + destDir + "' -Force"], (e2) => {
        if (e2) reject(new Error("Не удалось распаковать Java: " + (e2.message || e2)));
        else resolve();
      });
    });
  });
}

// определить, какая major-версия Java нужна для версии Minecraft
let _mojangManifestCache = null;
async function getRequiredJava(versionId) {
  const root = path.join(app.getPath("appData"), ".javelinmc");
  // 1) если версия уже скачана — берём из её json
  try {
    const localJson = path.join(root, "versions", versionId, versionId + ".json");
    if (fs.existsSync(localJson)) {
      const j = JSON.parse(fs.readFileSync(localJson, "utf-8"));
      return normalizeJavaMajor(j.javaVersion && j.javaVersion.majorVersion ? j.javaVersion.majorVersion : 8);
    }
  } catch (e) {}
  // 2) иначе спрашиваем у Mojang
  try {
    if (!_mojangManifestCache) {
      const u = new URL("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
      const r = await httpsRequest({ hostname: u.hostname, path: u.pathname, method: "GET", headers: { "User-Agent": "JavelinMC" } });
      _mojangManifestCache = JSON.parse(r.body);
    }
    const v = (_mojangManifestCache.versions || []).find((x) => x.id === versionId);
    if (!v) return 17;
    const u2 = new URL(v.url);
    const r2 = await httpsRequest({ hostname: u2.hostname, path: u2.pathname + (u2.search || ""), method: "GET", headers: { "User-Agent": "JavelinMC" } });
    const j = JSON.parse(r2.body);
    return normalizeJavaMajor(j.javaVersion && j.javaVersion.majorVersion ? j.javaVersion.majorVersion : 8);
  } catch (e) { return 17; }
}

// гарантировать наличие Java нужной версии: вернуть путь к javaw.exe (скачать при необходимости)
async function ensureJava(major, progress) {
  // Java 17 вложена в саму программу — но только в сборке под Windows
  if (major === 17) {
    const bundled = bundledJava();
    if (fs.existsSync(bundled)) return bundled;
  }
  const base = path.join(runtimesDir(), "java-" + major);
  let jw = findJava(base);
  if (jw) return jw; // уже скачана ранее
  try { fs.mkdirSync(base, { recursive: true }); } catch (e) {}
  // Adoptium раздаёт Java под каждую систему отдельно. Windows отдаёт .zip,
  // macOS — .tar.gz; tar распакует и то, и другое.
  const OS_TAG = IS_WIN ? "windows" : (IS_MAC ? "mac" : "linux");
  const ARCH_TAG = process.arch === "arm64" ? "aarch64" : "x64";
  const zipPath = path.join(base, IS_WIN ? "jre.zip" : "jre.tar.gz");
  const url = "https://api.adoptium.net/v3/binary/latest/" + major + "/ga/" +
    OS_TAG + "/" + ARCH_TAG + "/jre/hotspot/normal/eclipse";
  let got = 0, lastMb = 0;
  if (progress) progress("Скачиваю Java " + major + " (один раз, ~40 МБ)…", 0);
  await downloadToFile(url, { "User-Agent": "JavelinMC" }, zipPath, (n) => {
    got += n; const mb = Math.floor(got / 1048576);
    if (progress && mb > lastMb) { lastMb = mb; progress("Скачиваю Java " + major + "… " + mb + " МБ", 0); }
  });
  if (progress) progress("Распаковываю Java " + major + "…", 0);
  await extractArchive(zipPath, base);
  try { fs.unlinkSync(zipPath); } catch (e) {}
  jw = findJava(base);
  if (!jw) throw new Error("Java " + major + " скачана, но " + JAVA_BIN + " не найден.");
  // на macOS право на запуск иногда теряется при распаковке — возвращаем
  if (!IS_WIN) { try { fs.chmodSync(jw, 0o755); } catch (e) {} }
  return jw;
}

// ===== ЛОАДЕРЫ: Forge и Fabric под любую версию =====
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "JavelinMC" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

let _forgePromos = null, _fabricGames = null;

// какие версии поддерживает Forge и какая сборка у них рекомендована
async function forgePromos() {
  if (!_forgePromos) {
    // именно files.minecraftforge.net — на maven этот файл отдаёт HTML-страницу, а не JSON
    const d = await fetchJson("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
    _forgePromos = (d && d.promos) || {};
  }
  return _forgePromos;
}

// скачать инсталлятор Forge нужной версии (кладём в общую папку, качается один раз)
async function ensureForgeInstaller(root, mc, progress, wantBuild) {
  const p = await forgePromos();
  // wantBuild — когда игрок сам выбрал сборку Forge в своей сборке модов
  const build = wantBuild || p[mc + "-recommended"] || p[mc + "-latest"];
  if (!build) throw new Error("Forge не выпускался для " + mc);
  const full = mc + "-" + build;
  const dest = path.join(root, "forge", "forge-" + full + "-installer.jar");
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (progress) progress("Скачиваю Forge " + build + " для " + mc + "…", 0);
  await downloadToFile(
    "https://maven.minecraftforge.net/net/minecraftforge/forge/" + full + "/forge-" + full + "-installer.jar",
    { "User-Agent": "JavelinMC" }, dest
  );
  return dest;
}

// Все выпуски Forge под конкретную версию игры — чтобы игрок мог выбрать сборку сам.
// Список берём один раз и держим в памяти: он большой и меняется редко.
let _forgeAll = null;
async function forgeAllBuilds() {
  if (!_forgeAll) {
    const r = await fetchRetry(
      "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
      { headers: { "User-Agent": "JavelinMC" } }, 2
    );
    if (!r.ok) throw new Error("HTTP " + r.status);
    const t = await r.text();
    _forgeAll = (t.match(/<version>([^<]+)<\/version>/g) || [])
      .map((m) => m.replace(/<\/?version>/g, ""));
  }
  return _forgeAll;
}
// сборки под одну версию игры, новые сверху.
// В списке maven порядок не по номерам (43.5.2 стоит раньше 43.0.0), поэтому
// сортируем сами по числам — иначе игрок увидит старьё первым.
async function forgeBuildsFor(mc) {
  const all = await forgeAllBuilds();
  const pre = String(mc) + "-";
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const v = all[i];
    if (v.indexOf(pre) !== 0) continue;
    // встречается вид 1.20.1-47.4.13-1.20.1 — хвост с повтором версии игры убираем
    let b = v.slice(pre.length);
    const tail = "-" + mc;
    if (b.length > tail.length && b.slice(-tail.length) === tail) b = b.slice(0, -tail.length);
    if (out.indexOf(b) < 0) out.push(b);
  }
  out.sort((a, b) => cmpVer(b, a));
  return out;
}

// ===== NeoForge =====
// Отдельный проект (не Forge): свой maven, своя структура установщика.
// ForgeWrapper из библиотеки его не понимает, поэтому ставим НАСТОЯЩИМ установщиком
// в тихом режиме (--install-client), а потом запускаем как кастомный профиль.
let _neoVers = null;
async function neoVersions() {
  if (!_neoVers) {
    const r = await fetch("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml", { headers: { "User-Agent": "JavelinMC" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const t = await r.text();
    _neoVers = (t.match(/<version>([^<]+)<\/version>/g) || []).map((m) => m.replace(/<\/?version>/g, ""));
  }
  return _neoVers;
}
// версия NeoForge A.B.C -> Minecraft 1.A.B (21.1.244 -> 1.21.1, 20.2.5 -> 1.20.2)
function neoToMc(v) {
  const m = v.match(/^(\d+)\.(\d+)\.\d+/);
  if (!m) return "";
  const minor = parseInt(m[2], 10);
  return "1." + m[1] + (minor ? ("." + minor) : "");
}
// какие версии Minecraft поддерживает NeoForge (для меню)
async function neoMcVersions() {
  const set = new Set();
  (await neoVersions()).forEach((v) => { if (v.indexOf("beta") === -1) { const mc = neoToMc(v); if (mc) set.add(mc); } });
  return Array.from(set);
}
// сравнить версии вида 21.1.244 по числам (а не по строке)
function cmpVer(a, b) {
  const pa = a.split(/[.\-]/), pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
    if (isNaN(na) || isNaN(nb)) { if (pa[i] !== pb[i]) return (pa[i] || "") < (pb[i] || "") ? -1 : 1; continue; }
    if (na !== nb) return na - nb;
  }
  return 0;
}
// последняя стабильная сборка NeoForge под нужную версию Minecraft
async function latestNeo(mc) {
  const all = await neoVersions();
  let pool = all.filter((v) => neoToMc(v) === mc && v.indexOf("beta") === -1);
  if (!pool.length) pool = all.filter((v) => neoToMc(v) === mc);   // только беты — берём их
  pool.sort(cmpVer);
  return pool.length ? pool[pool.length - 1] : "";
}
// запустить процесс и дождаться кода выхода
function runProcess(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = execFile(exe, args, { cwd: cwd, maxBuffer: 1024 * 1024 * 32 }, (err) => {
      if (err) reject(err); else resolve();
    });
    p.on("error", reject);
  });
}
// установить NeoForge в общую папку и вернуть id профиля (neoforge-A.B.C)
async function ensureNeoforge(root, mc, javaExe, progress) {
  const ver = await latestNeo(mc);
  if (!ver) throw new Error("NeoForge не выпускался для " + mc + " (есть только для 1.20.2 и новее)");
  const id = "neoforge-" + ver;
  const profileJson = path.join(root, "versions", id, id + ".json");
  if (fs.existsSync(profileJson)) return id;               // уже установлен

  // установщику нужен launcher_profiles.json в корне — создаём пустую заглушку
  const lp = path.join(root, "launcher_profiles.json");
  if (!fs.existsSync(lp)) {
    try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(lp, JSON.stringify({ profiles: {}, selectedProfile: "", clientToken: "" })); } catch (e) {}
  }

  const installer = path.join(root, "neoforge", "neoforge-" + ver + "-installer.jar");
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  if (!fs.existsSync(installer)) {
    if (progress) progress("Скачиваю NeoForge " + ver + "…", 0);
    await downloadToFile("https://maven.neoforged.net/releases/net/neoforged/neoforge/" + ver + "/neoforge-" + ver + "-installer.jar", { "User-Agent": "JavelinMC" }, installer);
  }

  if (progress) progress("Устанавливаю NeoForge " + ver + " (один раз)…", 0);
  const javaBin = javaExe.replace(/javaw\.exe$/i, "java.exe");   // консольный java для тихой установки
  const exe = fs.existsSync(javaBin) ? javaBin : javaExe;
  await runProcess(exe, ["-jar", installer, "--install-client", root], root);

  if (!fs.existsSync(profileJson)) throw new Error("NeoForge установлен, но профиль " + id + " не найден");
  return id;
}

// Fabric ставится без инсталлятора: забираем у них готовый профиль запуска
async function ensureFabric(root, mc, progress) {
  const loaders = await fetchJson("https://meta.fabricmc.net/v2/versions/loader/" + encodeURIComponent(mc));
  if (!loaders || !loaders.length) throw new Error("Fabric не поддерживает " + mc);
  const lv = loaders[0].loader.version;
  const id = "fabric-loader-" + lv + "-" + mc;
  const jsonPath = path.join(root, "versions", id, id + ".json");
  if (!fs.existsSync(jsonPath)) {
    if (progress) progress("Ставлю Fabric " + lv + " для " + mc + "…", 0);
    const r = await fetch("https://meta.fabricmc.net/v2/versions/loader/" +
      encodeURIComponent(mc) + "/" + encodeURIComponent(lv) + "/profile/json");
    if (!r.ok) throw new Error("Fabric ответил HTTP " + r.status);
    const txt = await r.text();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, txt);
  }
  return id;
}

// для меню выбора: какие версии поддерживают Forge / Fabric / NeoForge
ipcMain.handle("get-loaders", async () => {
  const out = { forge: [], fabric: [], neoforge: [] };
  try {
    const p = await forgePromos();
    const set = new Set();
    Object.keys(p).forEach((k) => {
      const m = k.match(/^(.+)-(recommended|latest)$/);
      if (m) set.add(m[1]);
    });
    out.forge = Array.from(set);
  } catch (e) {}
  try {
    if (!_fabricGames) _fabricGames = await fetchJson("https://meta.fabricmc.net/v2/versions/game");
    out.fabric = (_fabricGames || []).filter((g) => g && g.stable).map((g) => g.version);
  } catch (e) {}
  try { out.neoforge = await neoMcVersions(); } catch (e) {}
  return out;
});

// прервать подготовку/запуск: игра не откроется, кнопка разблокируется
ipcMain.handle("cancel-launch", () => {
  launchGen++;            // всё, что готовилось, становится «старым» и не стартует
  launching = null;
  if (activeProc) { try { activeProc.kill(); } catch (e) {} activeProc = null; }
  return { ok: true };
});

// ===== OPTIFINE =====
// У OptiFine нет API, поэтому jar'ы лежат в GitHub-релизе владельца сервера.
// Версия берётся из имени файла: OptiFine_1.20.1_HD_U_I6.jar -> 1.20.1
function optifineCfg(cfg) {
  return {
    owner: cfg.optifineOwner || cfg.githubOwner,
    repo: cfg.optifineRepo || cfg.githubRepo,
    tag: cfg.optifineTag || "optifine"
  };
}
async function listOptifine(cfg) {
  const o = optifineCfg(cfg);
  if (!o.owner || !o.repo || !o.tag) return [];
  const r = await ghApiGet("/repos/" + o.owner + "/" + o.repo + "/releases/tags/" + encodeURIComponent(o.tag));
  if (r.status !== 200) return [];
  let d;
  try { d = JSON.parse(r.body); } catch (e) { return []; }
  return (d.assets || [])
    .filter((a) => a && a.name && /\.jar$/i.test(a.name))
    .map((a) => {
      const m = String(a.name).match(/(\d+\.\d+(?:\.\d+)?)/);
      // OptiFine пишет 1.9.0 / 1.8.0, а у Mojang это 1.9 / 1.8 — убираем хвостовой .0
      let mc = m ? m[1] : "";
      if (/^\d+\.\d+\.0$/.test(mc)) mc = mc.replace(/\.0$/, "");
      return { name: a.name, mc: mc, size: a.size || 0, url: a.browser_download_url };
    })
    .filter((x) => x.mc);
}
// для меню: под какие версии OptiFine залит
ipcMain.handle("list-optifine", async () => {
  try { return await listOptifine(loadConfig()); } catch (e) { return []; }
});
// прочитать json ванильной версии (локально или у Mojang) — нужен для стиля аргументов
async function getVanillaJson(versionId) {
  const root = path.join(app.getPath("appData"), ".javelinmc");
  const localJson = path.join(root, "versions", versionId, versionId + ".json");
  if (fs.existsSync(localJson)) {
    try { return JSON.parse(fs.readFileSync(localJson, "utf-8")); } catch (e) {}
  }
  if (!_mojangManifestCache) {
    const u = new URL("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
    const r = await httpsRequest({ hostname: u.hostname, path: u.pathname, method: "GET", headers: { "User-Agent": "JavelinMC" } });
    _mojangManifestCache = JSON.parse(r.body);
  }
  const v = (_mojangManifestCache.versions || []).find((x) => x.id === versionId);
  if (!v) return null;
  const u2 = new URL(v.url);
  const r2 = await httpsRequest({ hostname: u2.hostname, path: u2.pathname + (u2.search || ""), method: "GET", headers: { "User-Agent": "JavelinMC" } });
  return JSON.parse(r2.body);
}

// OptiFine БЕЗ Forge (standalone): свой профиль запуска через launchwrapper.
// Повторяем ровно то, что делает установщик OptiFine, но без его окна — кладём
// сам OptiFine и launchwrapper в libraries и пишем версию-профиль.
async function ensureOptifineStandalone(cfg, mc, root, progress) {
  const AdmZip = require("adm-zip");
  const all = await listOptifine(cfg);
  const item = all.find((x) => x.mc === mc);
  if (!item) throw new Error("OptiFine для " + mc + " не залит в релиз «" + optifineCfg(cfg).tag + "»");

  // OptiFine_1.20.1_HD_U_I6.jar -> версия 1.20.1, издание HD_U_I6
  const nm = item.name.replace(/\.jar$/i, "");
  const em = nm.match(/OptiFine[_-](\d+\.\d+(?:\.\d+)?)_(.+)$/);
  if (!em) throw new Error("Не разобрать имя файла OptiFine: " + item.name);
  const mcName = em[1], edition = em[2];
  const id = mcName + "-OptiFine_" + edition;                 // 1.20.1-OptiFine_HD_U_I6
  const jsonPath = path.join(root, "versions", id, id + ".json");
  if (fs.existsSync(jsonPath)) return id;

  // 1) скачать сам jar OptiFine
  const ofJar = path.join(root, "optifine", item.name);
  fs.mkdirSync(path.dirname(ofJar), { recursive: true });
  if (!fs.existsSync(ofJar)) {
    if (progress) progress("Скачиваю OptiFine для " + mc + "…", 0);
    await downloadToFile(item.url, { "User-Agent": "JavelinMC-Launcher" }, ofJar);
  }
  if (progress) progress("Ставлю OptiFine " + edition + "…", 0);

  const libRoot = path.join(root, "libraries", "optifine");
  const zip = new AdmZip(ofJar);

  // 2) launchwrapper из самого jar -> в libraries
  let lwver = "";
  const lwtxt = zip.getEntry("launchwrapper-of.txt");
  if (lwtxt) lwver = zip.readAsText(lwtxt).trim();
  if (lwver) {
    const lwEntry = zip.getEntry("launchwrapper-of-" + lwver + ".jar");
    if (lwEntry) {
      const dest = path.join(libRoot, "launchwrapper-of", lwver, "launchwrapper-of-" + lwver + ".jar");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, lwEntry.getData());
    } else { lwver = ""; }
  }

  // 3) сам OptiFine как библиотека
  const ofLibName = mcName + "_" + edition;
  const ofDest = path.join(libRoot, "OptiFine", ofLibName, "OptiFine-" + ofLibName + ".jar");
  fs.mkdirSync(path.dirname(ofDest), { recursive: true });
  fs.copyFileSync(ofJar, ofDest);

  // 4) профиль запуска. Стиль аргументов берём как у ванильной версии:
  //    старые (<=1.12.2) — minecraftArguments, новые — arguments.game
  let useOldArgs = false;
  try { const vj = await getVanillaJson(mc); useOldArgs = !!(vj && vj.minecraftArguments && !vj.arguments); } catch (e) {}

  const libs = [{ name: "optifine:OptiFine:" + ofLibName }];
  if (lwver) libs.push({ name: "optifine:launchwrapper-of:" + lwver });
  const json = {
    id: id, inheritsFrom: mc, type: "release",
    releaseTime: "1970-01-01T00:00:00+00:00", time: "1970-01-01T00:00:00+00:00",
    libraries: libs, mainClass: "net.minecraft.launchwrapper.Launch"
  };
  if (useOldArgs) json.minecraftArguments = "--tweakClass optifine.OptiFineTweaker";
  else json.arguments = { game: ["--tweakClass", "optifine.OptiFineTweaker"] };

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  return id;
}

// положить OptiFine в папку сборки (он работает как обычный мод к Forge)
async function ensureOptifine(cfg, mc, gameDir, progress) {
  const all = await listOptifine(cfg);
  const item = all.find((x) => x.mc === mc);
  if (!item) throw new Error("OptiFine для " + mc + " не залит в релиз «" + optifineCfg(cfg).tag + "»");
  const modsDir = path.join(gameDir, "mods");
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, item.name);
  try {
    const st = fs.statSync(dest);
    if (!item.size || st.size === item.size) return dest;   // уже лежит
  } catch (e) {}
  if (progress) progress("Скачиваю OptiFine для " + mc + "…", 0);
  await downloadToFile(item.url, { "User-Agent": "JavelinMC-Launcher" }, dest);
  return dest;
}

// какие сборки уже скачаны игроком (для подсветки в меню)
ipcMain.handle("list-instances", () => {
  try {
    const dir = path.join(app.getPath("appData"), ".javelinmc", "instances");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => {
      try {
        const p = path.join(dir, n);
        // пустая папка — это недокачанный запуск, такую сборку скачанной не считаем
        return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
      } catch (e) { return false; }
    });
  } catch (e) { return []; }
});

// ===== РЕЖИМ ИГРОКА: свои моды и шейдеры в отдельной папке =====
// Папка режима игрока = папка серверной сборки + "-player". Серверные моды и
// моды игрока лежат в РАЗНЫХ папках, поэтому не мешают друг другу («заморожены»),
// пока игрок не переключит режим. У режима игрока свои миры.
function playerDir(version, loader) {
  const root = path.join(app.getPath("appData"), ".javelinmc");
  // Серверные настройки разводим прямо здесь, а не только при запуске игры:
  // игрок открывает папку кнопкой «config» задолго до первого запуска и видел
  // там серверный конфиг. Внутри стоит метка — после первого раза это пустой
  // вызов, так что дёргать можно сколько угодно.
  try { freezeServerConfig(root, version, loader); } catch (e) {}
  return instanceDir(root, version, loader) + "-player";
}
function listJars(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f)).map((f) => {
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
      return { name: f, size: size };
    });
  } catch (e) { return []; }
}
function listAny(dir, re) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => {
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
      return { name: f, size: size };
    });
  } catch (e) { return []; }
}

ipcMain.handle("player-mods-list", (e, version, loader) => {
  return listJars(path.join(playerDir(version, loader), "mods"));
});
ipcMain.handle("player-mods-add", async (e, version, loader) => {
  const dir = path.join(playerDir(version, loader), "mods");
  fs.mkdirSync(dir, { recursive: true });
  const r = await dialog.showOpenDialog(win, {
    title: "Выбери моды (.jar)", properties: ["openFile", "multiSelections"],
    filters: [{ name: "Моды Minecraft", extensions: ["jar"] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, mods: listJars(dir) };
  let added = 0;
  for (const src of r.filePaths) {
    try { fs.copyFileSync(src, path.join(dir, path.basename(src))); added++; } catch (err) {}
  }
  return { ok: true, added: added, mods: listJars(dir) };
});
ipcMain.handle("player-mods-remove", (e, version, loader, name) => {
  const dir = path.join(playerDir(version, loader), "mods");
  try { fs.unlinkSync(path.join(dir, path.basename(String(name || "")))); } catch (err) {}
  return { ok: true, mods: listJars(dir) };
});

ipcMain.handle("player-shaders-list", (e, version, loader) => {
  return listAny(path.join(playerDir(version, loader), "shaderpacks"), /\.(zip|jar)$/i);
});
ipcMain.handle("player-shaders-add", async (e, version, loader) => {
  const dir = path.join(playerDir(version, loader), "shaderpacks");
  fs.mkdirSync(dir, { recursive: true });
  const r = await dialog.showOpenDialog(win, {
    title: "Выбери шейдеры (.zip)", properties: ["openFile", "multiSelections"],
    filters: [{ name: "Шейдерпаки", extensions: ["zip", "jar"] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, shaders: listAny(dir, /\.(zip|jar)$/i) };
  let added = 0;
  for (const src of r.filePaths) {
    try { fs.copyFileSync(src, path.join(dir, path.basename(src))); added++; } catch (err) {}
  }
  return { ok: true, added: added, shaders: listAny(dir, /\.(zip|jar)$/i) };
});
ipcMain.handle("player-shaders-remove", (e, version, loader, name) => {
  const dir = path.join(playerDir(version, loader), "shaderpacks");
  try { fs.unlinkSync(path.join(dir, path.basename(String(name || "")))); } catch (err) {}
  return { ok: true, shaders: listAny(dir, /\.(zip|jar)$/i) };
});
// открыть папку модов режима игрока в проводнике
ipcMain.handle("player-open-folder", (e, version, loader) => {
  const dir = path.join(playerDir(version, loader), "mods");
  fs.mkdirSync(dir, { recursive: true });
  try { shell.openPath(dir); } catch (err) {}
  return { ok: true };
});

// ===== Папки режима игрока =====
// Это папка "<сборка>-player" — она физически отдельная от серверной сборки.
// Поэтому что бы игрок тут ни менял, режим сервера этого не видит: при переключении
// назад игра снова стартует из серверной папки, а правки игрока просто ждут его
// возвращения в режим игрока.
const PLAYER_DIRS = {
  root: "", mods: "mods", config: "config", saves: "saves",
  resourcepacks: "resourcepacks", shaderpacks: "shaderpacks",
  logs: "logs", screenshots: "screenshots", crash: "crash-reports"
};
ipcMain.handle("player-open-dir", (e, version, loader, which) => {
  const key = String(which || "root");
  if (!Object.prototype.hasOwnProperty.call(PLAYER_DIRS, key)) {
    return { ok: false, error: "Неизвестная папка: " + key };
  }
  const base = playerDir(version, loader);
  const dir = PLAYER_DIRS[key] ? path.join(base, PLAYER_DIRS[key]) : base;
  try {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  return { ok: true, path: dir };
});

// Папки ПОЛНОЙ серверной сборки — только для админ-консоли. Обычный игрок сюда
// не попадает: кнопки есть лишь в скрытой панели администратора.
ipcMain.handle("server-open-dir", (e, version, loader, which) => {
  const key = String(which || "root");
  if (!Object.prototype.hasOwnProperty.call(PLAYER_DIRS, key)) {
    return { ok: false, error: "Неизвестная папка: " + key };
  }
  const rootDir = path.join(app.getPath("appData"), ".javelinmc");
  const base = instanceDir(rootDir, version || "1.20.1", loader || "forge");
  const dir = PLAYER_DIRS[key] ? path.join(base, PLAYER_DIRS[key]) : base;
  try {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  return { ok: true, path: dir };
});

// Собрать extras.zip из папок серверной сборки — чтобы админу не паковать руками
// (и не получить случайно "extras.zip.zip"). Кладём готовый архив на рабочий стол.
ipcMain.handle("build-extras", async (e, version, loader) => {
  const rootDir = path.join(app.getPath("appData"), ".javelinmc");
  const base = instanceDir(rootDir, version || "1.20.1", loader || "forge");
  if (!fs.existsSync(base)) return { ok: false, error: "Папка сборки не найдена: " + base };

  // берём config + то, что уже раздавали, + известные папки контента модов
  const want = new Set(["config"]);
  const st = readExtrasState(base);
  (Array.isArray(st.paths) ? st.paths : []).forEach((n) => want.add(n));
  // pointblank и defaultconfigs сюда НЕ берём: их моды создают сами при запуске,
  // раздавать их незачем — только раздует архив на сотню мегабайт.
  ["tacz", "kubejs"].forEach((n) => {
    if (fs.existsSync(path.join(base, n))) want.add(n);
  });

  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  const added = [];
  want.forEach(function (name) {
    if (!name || name === "." || name === ".." || name.indexOf("/") !== -1 || name.indexOf("\\") !== -1) return;
    const dir = path.join(base, name);
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
      zip.addLocalFolder(dir, name);
      added.push(name);
    } catch (err) {}
  });
  if (!added.length) return { ok: false, error: "Нечего паковать: нет ни config, ни папок контента." };

  const out = path.join(app.getPath("desktop"), "extras.zip");
  try {
    zip.writeZip(out);
    shell.showItemInFolder(out);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  let size = 0;
  try { size = fs.statSync(out).size; } catch (err) {}
  return { ok: true, path: out, folders: added, size: size };
});

// Общие файлы игры (versions/assets/libraries) — одни на все сборки, чтобы не
// качать одно и то же по нескольку раз. Их видят оба режима, поэтому кнопка идёт
// отдельно и с предупреждением в интерфейсе.
const SHARED_DIRS = { root: "", versions: "versions", assets: "assets", libraries: "libraries" };
ipcMain.handle("open-shared-dir", (e, which) => {
  const key = String(which || "root");
  if (!Object.prototype.hasOwnProperty.call(SHARED_DIRS, key)) {
    return { ok: false, error: "Неизвестная папка: " + key };
  }
  const rootDir = path.join(app.getPath("appData"), ".javelinmc");
  const dir = SHARED_DIRS[key] ? path.join(rootDir, SHARED_DIRS[key]) : rootDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  return { ok: true, path: dir };
});

// удалить сборку вместе с её мирами и модами (спрашивается дважды в интерфейсе)
ipcMain.handle("delete-instance", (e, id) => {
  try {
    const base = path.join(app.getPath("appData"), ".javelinmc", "instances");
    const target = path.join(base, String(id || ""));
    // страховка: удалять можно только внутри папки сборок
    if (path.relative(base, target).indexOf("..") === 0 || target === base) return { ok: false, error: "неверная папка" };
    if (!fs.existsSync(target)) return { ok: true };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// получить список .jar в релизе GitHub (без скачивания)
function ghApiGet(apiPath) {
  return httpsRequest({
    hostname: "api.github.com", path: apiPath, method: "GET",
    headers: { "User-Agent": "JavelinMC-Launcher", "Accept": "application/vnd.github+json" }
  });
}

// Список модов кэшируется на диске. GitHub без токена отдаёт всего 60 запросов
// в час на IP, а список запрашивался при каждом открытии вкладки «Моды» и при
// каждом запуске игры — игроки упирались в лимит и получали HTTP 403.
// Свежий кэш отвечает сразу, а если GitHub отказал — отдаём последний известный
// список, чтобы моды всё равно можно было скачать (сами файлы лимитом не ограничены).
const MODS_CACHE_TTL = 10 * 60 * 1000;
function modsCacheFile() {
  return path.join(app.getPath("appData"), ".javelinmc", "mods-list-cache.json");
}
function readModsCache(key) {
  try {
    const c = JSON.parse(fs.readFileSync(modsCacheFile(), "utf-8"));
    if (c && c.key === key && Array.isArray(c.list) && c.list.length) return c;
  } catch (e) { /* кэша ещё нет */ }
  return null;
}
function writeModsCache(key, list, all) {
  try {
    fs.mkdirSync(path.dirname(modsCacheFile()), { recursive: true });
    fs.writeFileSync(modsCacheFile(), JSON.stringify({
      key: key, at: Date.now(), list: list, all: all || list
    }));
  } catch (e) { /* не смогли записать — не страшно */ }
}

// Читает релиз один раз и запоминает: list — только моды (.jar), all — вообще все
// файлы релиза (нужно, чтобы найти архив с папками сборки).
async function fetchRelease(cfg) {
  const owner = cfg.githubOwner, repo = cfg.githubRepo, tag = cfg.githubTag;
  if (!owner || !repo || !tag) throw new Error("GitHub не настроен в config.json (githubOwner/githubRepo/githubTag).");
  const key = owner + "/" + repo + "@" + tag;
  const cached = readModsCache(key);
  if (cached && (Date.now() - cached.at) < MODS_CACHE_TTL) {
    return { list: cached.list, all: cached.all || cached.list };
  }

  let r;
  try {
    r = await ghApiGet("/repos/" + owner + "/" + repo + "/releases/tags/" + encodeURIComponent(tag));
  } catch (e) {
    if (cached) return { list: cached.list, all: cached.all || cached.list };  // нет сети — работаем по последнему списку
    throw e;
  }
  if (r.status !== 200) {
    if (cached) return { list: cached.list, all: cached.all || cached.list };  // GitHub отказал — выручает кэш
    if (r.status === 403 || r.status === 429) {
      throw new Error("GitHub временно ограничил число запросов (HTTP " + r.status + "). Сборка тут ни при чём: подожди 10–15 минут и нажми «Обновить». Загрузка самих модов лимитом не ограничена.");
    }
    throw new Error("Не удалось получить список модов с GitHub (HTTP " + r.status + "). Проверь репозиторий/тег в config.json.");
  }
  let d;
  try { d = JSON.parse(r.body); } catch (e) {
    if (cached) return { list: cached.list, all: cached.all || cached.list };
    throw new Error("Ответ GitHub повреждён.");
  }
  const all = (d.assets || [])
    .filter((a) => a && a.name)
    .map((a) => ({ name: a.name, size: a.size || 0, url: a.browser_download_url }));
  const list = all.filter((a) => /\.jar$/i.test(a.name));
  writeModsCache(key, list, all);
  return { list: list, all: all };
}

async function listBucketMods(cfg) {
  return (await fetchRelease(cfg)).list;
}

// ===== ПАПКИ СБОРКИ (extras.zip) =====
// Некоторые моды держат свой контент НЕ в mods, а в отдельной папке рядом с игрой:
// TaCZ — в "tacz", Point Blank — в "pointblank", настройки — в "config".
// Такие папки кладём в архив extras.zip в тот же релиз GitHub, что и моды.
// Лаунчер распаковывает его в папку сборки и помнит, что именно раздал: если папку
// убрали из архива — она удаляется и у игрока. То есть работает так же, как моды.
const EXTRAS_ASSET = "extras.zip";
const EXTRAS_STATE = ".javelin-extras.json";

function extrasStatePath(gameDir) { return path.join(gameDir, EXTRAS_STATE); }
function readExtrasState(gameDir) {
  try {
    const s = JSON.parse(fs.readFileSync(extrasStatePath(gameDir), "utf-8"));
    if (s && typeof s === "object") return s;
  } catch (e) {}
  return {};
}
function removeDelivered(gameDir, names) {
  (names || []).forEach(function (n) {
    if (!n || n === "." || n === ".." || n.indexOf("/") !== -1 || n.indexOf("\\") !== -1) return;
    try { fs.rmSync(path.join(gameDir, n), { recursive: true, force: true }); } catch (e) {}
  });
}

async function syncExtras(cfg, gameDir, send) {
  send = send || function () {};
  let asset = null;
  try {
    const all = (await fetchRelease(cfg)).all || [];
    // Windows прячет расширения, поэтому архив часто заливают как "extras.zip.zip".
    // Принимаем любое имя, начинающееся на extras и заканчивающееся на .zip.
    const cands = all.filter(function (a) {
      const n = String(a.name || "").toLowerCase();
      return n === EXTRAS_ASSET || (n.startsWith("extras") && n.endsWith(".zip"));
    });
    // если в релизе лежат и старый, и новый архив — берём точный extras.zip
    asset = cands.find(function (a) { return String(a.name || "").toLowerCase() === EXTRAS_ASSET; })
         || cands[0] || null;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };   // без сети просто пропускаем
  }

  const state = readExtrasState(gameDir);
  const oldNames = Array.isArray(state.paths) ? state.paths : [];

  // архив убрали из релиза — убираем и у игрока всё, что раздавали
  if (!asset) {
    if (oldNames.length) {
      removeDelivered(gameDir, oldNames);
      try { fs.unlinkSync(extrasStatePath(gameDir)); } catch (e) {}
      send("Лишние папки сборки удалены", 100);
    }
    return { ok: true, skipped: true };
  }

  // ничего не поменялось — не качаем заново
  if (state.size === asset.size && state.name === asset.name && oldNames.length) {
    return { ok: true, unchanged: true, paths: oldNames };
  }

  send("Скачиваю папки сборки…", -1);
  const tmp = path.join(gameDir, ".extras-download.zip");
  await downloadToFile(asset.url, { "User-Agent": "JavelinMC" }, tmp);

  const AdmZip = require("adm-zip");
  let zip, entries;
  try {
    zip = new AdmZip(tmp);
    entries = zip.getEntries();
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw new Error("Архив папок сборки повреждён: " + ((e && e.message) || e));
  }

  // защита: внутри архива не должно быть путей наружу папки сборки
  const tops = new Set();
  for (const en of entries) {
    const raw = String(en.entryName || "").replace(/\\/g, "/");
    if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.split("/").indexOf("..") !== -1) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw new Error("В архиве папок сборки есть недопустимый путь: " + raw);
    }
    const top = raw.split("/")[0];
    if (top) tops.add(top);
  }

  // то, что раздавали раньше, но чего больше нет в архиве — удаляем
  removeDelivered(gameDir, oldNames.filter(function (n) { return !tops.has(n); }));

  send("Распаковываю папки сборки…", -1);
  zip.extractAllTo(gameDir, true);
  try { fs.unlinkSync(tmp); } catch (e) {}

  try {
    fs.writeFileSync(extrasStatePath(gameDir), JSON.stringify({
      name: asset.name, size: asset.size, paths: Array.from(tops)
    }));
  } catch (e) {}

  send("Папки сборки обновлены: " + Array.from(tops).join(", "), 100);
  return { ok: true, paths: Array.from(tops) };
}

// какие моды админ «скрыл» (их не качаем игрокам). Список лежит в Supabase.
async function getHiddenMods(cfg) {
  try {
    const base = cfg.supabaseUrl.replace(/\/+$/, "");
    const u = new URL(base + "/rest/v1/rpc/get_hidden_mods");
    const headers = { "apikey": cfg.supabaseKey, "Authorization": "Bearer " + cfg.supabaseKey, "Content-Type": "application/json", "Content-Length": 2 };
    const r = await httpsRequest({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: headers }, "{}");
    if (r.status < 200 || r.status >= 300) return new Set();
    const arr = JSON.parse(r.body);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}

// ===== Общие запросы к Supabase REST (регистрация, вход, новости и т.д.) =====
// Идут через «начинку» лаунчера, минуя ограничения веб-страницы.
function sbFetch(method, restPath, bodyObj) {
  const cfg = loadConfig();
  const base = cfg.supabaseUrl.replace(/\/+$/, "");
  const u = new URL(base + "/rest/v1/" + restPath);
  const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
  const headers = {
    "apikey": cfg.supabaseKey,
    "Authorization": "Bearer " + cfg.supabaseKey,
    "Content-Type": "application/json"
  };
  if (body) headers["Content-Length"] = Buffer.byteLength(body);
  return httpsRequest({
    hostname: u.hostname, path: u.pathname + u.search, method: method, headers: headers
  }, body);
}

ipcMain.handle("sb-rpc", async (e, fn, args) => {
  // Провайдер иногда рвёт соединение на ровном месте (ECONNRESET), и игрок видел
  // «Error: read ECONNRESET» вместо кнопки входа. Пробуем ещё дважды с паузой, а
  // если всё равно не вышло — объясняем по-человечески, что это связь.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await sbFetch("POST", "rpc/" + fn, args || {});
      if (r.status >= 200 && r.status < 300) {
        try { return JSON.parse(r.body); } catch (err) { return null; }
      }
      // 5xx — сервер прилёг, имеет смысл повторить. 4xx — наша ошибка, повтор не поможет.
      last = new Error("HTTP " + r.status + (r.body ? (" " + String(r.body).slice(0, 160)) : ""));
      if (r.status < 500) throw last;
    } catch (err) {
      last = err;
      const soft = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|HTTP 5/i
        .test(String((err && err.message) || err));
      if (!soft) throw err;
    }
    await new Promise((r2) => setTimeout(r2, 600 * (attempt + 1)));
  }
  throw new Error("Нет связи с сервером профилей. Проверь интернет и попробуй ещё раз." +
    (last ? (" (" + String(last.message || last).slice(0, 80) + ")") : ""));
});

// постоянный номер этой копии лаунчера — по нему считается онлайн
// (тот же id, что используется для входа Ely.by; наружу уходит только он, без токенов)
ipcMain.handle("client-id", () => getClientToken());

// лаунчер закрывают — сразу убираем себя из счётчика онлайна (без ожидания ответа)
app.on("before-quit", () => {
  try { sbFetch("POST", "rpc/presence_leave", { p_id: getClientToken() }).catch(() => {}); } catch (e) {}
});

ipcMain.handle("sb-get", async (e, restPath) => {
  const r = await sbFetch("GET", restPath, null);
  if (r.status < 200 || r.status >= 300) throw new Error("HTTP " + r.status);
  try { return JSON.parse(r.body); } catch (err) { return []; }
});

// ===== Загрузка файла (видео) в Supabase Storage =====
// base64 -> бинарь -> POST в бакет; возвращает публичную ссылку на файл.
ipcMain.handle("sb-upload", async (e, bucket, objectPath, base64, contentType) => {
  const cfg = loadConfig();
  const base = cfg.supabaseUrl.replace(/\/+$/, "");
  const u = new URL(base + "/storage/v1/object/" + bucket + "/" + objectPath);
  const buf = Buffer.from(base64 || "", "base64");
  const headers = {
    "apikey": cfg.supabaseKey,
    "Authorization": "Bearer " + cfg.supabaseKey,
    "Content-Type": contentType || "application/octet-stream",
    "x-upsert": "true",
    "Content-Length": buf.length
  };
  const r = await httpsRequest({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: headers }, buf);
  if (r.status < 200 || r.status >= 300) {
    throw new Error("HTTP " + r.status + (r.body ? (" " + String(r.body).slice(0, 200)) : ""));
  }
  return base + "/storage/v1/object/public/" + bucket + "/" + objectPath;
});

// показать список реальных модов на экране «Моды» (без скачивания)
ipcMain.handle("list-mods", async () => {
  const cfg = loadConfig();
  if (!cfg.githubOwner || !cfg.githubRepo || !cfg.githubTag) {
    return { ok: false, message: "Моды не настроены (config.json)" };
  }
  try {
    const mods = await listBucketMods(cfg);
    const hidden = await getHiddenMods(cfg);
    return { ok: true, mods: mods.map((m) => ({ name: m.name, size: m.size, url: m.url, hidden: hidden.has(m.name) })) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

async function syncMods(cfg, root) {
  if (!cfg.githubOwner || !cfg.githubRepo || !cfg.githubTag) {
    return { ok: false, skipped: true, message: "Моды не настроены (config.json)" };
  }
  const modsDir = path.join(root, "mods");
  fs.mkdirSync(modsDir, { recursive: true });

  function send(msg, pct) {
    // проценты не должны вылезать за 100 (оценка размера бывает неточной)
    let p = (pct == null ? -1 : pct);
    if (p > 100) p = 100;
    if (win) sendUI("mc-modprogress", { msg: msg, pct: p });
  }

  // 1) получить список файлов в релизе GitHub (минус скрытые админом)
  send("Получаю список модов сервера…", -1);
  let mods = await listBucketMods(cfg);
  const hidden = await getHiddenMods(cfg);
  if (hidden.size) mods = mods.filter((m) => !hidden.has(m.name));

  if (mods.length === 0) {
    send("На сервере нет модов.", 100);
    return { ok: true, count: 0, downloaded: 0, removed: 0, message: "На сервере нет модов." };
  }

  // 2) скачать недостающие/изменённые
  const wanted = new Set(mods.map((m) => m.name));
  const totalBytes = mods.reduce((s, m) => s + (m.size || 0), 0) || 1;
  let doneBytes = 0, downloaded = 0;

  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    const dest = path.join(modsDir, path.basename(m.name));
    let need = true;
    try {
      const st = fs.statSync(dest);
      if (m.size && st.size === m.size) need = false; // уже есть и размер совпадает
    } catch (e) {}

    if (!need) {
      doneBytes += m.size || 0;
      send("Проверка модов… (" + (i + 1) + "/" + mods.length + ")", Math.round((doneBytes / totalBytes) * 100));
      continue;
    }

    send("Скачиваю: " + m.name + " (" + (i + 1) + "/" + mods.length + ")", Math.round((doneBytes / totalBytes) * 100));
    let acc = 0;
    await downloadToFile(m.url, { "User-Agent": "JavelinMC-Launcher" }, dest, (n) => {
      acc += n;
      send("Скачиваю: " + m.name + " (" + (i + 1) + "/" + mods.length + ")",
           Math.round(((doneBytes + acc) / totalBytes) * 100));
    });
    doneBytes += m.size || acc;
    downloaded++;
  }

  // 3) удалить лишние .jar, которых нет в наборе сервера
  let removed = 0;
  for (const f of fs.readdirSync(modsDir)) {
    if (/\.jar$/i.test(f) && !wanted.has(f)) {
      try { fs.unlinkSync(path.join(modsDir, f)); removed++; } catch (e) {}
    }
  }

  send("Моды готовы: " + mods.length + " шт. (загружено " + downloaded + ", удалено лишних " + removed + ") \u2713", 100);
  return { ok: true, count: mods.length, downloaded: downloaded, removed: removed };
}

// ручной запуск синхронизации (кнопка «Скачать моды сервера»)
// моды кладём в папку той сборки, на которой стоит сервер
// Отличается ли сборка игрока от серверной: чего не хватает, что лишнее,
// не поменялись ли папки (extras.zip). По этому интерфейс пишет «требуется обновление».
ipcMain.handle("mods-status", async (e, opts) => {
  const cfg = Object.assign(loadConfig(), opts || {});
  if (!cfg.githubOwner || !cfg.githubRepo || !cfg.githubTag) {
    return { ok: false, error: "Моды не настроены (config.json)" };
  }
  const root = path.join(app.getPath("appData"), ".javelinmc");
  const gameDir = instanceDir(root, cfg.version, cfg.loader || "forge");
  const modsDir = path.join(gameDir, "mods");
  try {
    let mods = await listBucketMods(cfg);
    const hidden = await getHiddenMods(cfg);
    if (hidden.size) mods = mods.filter((m) => !hidden.has(m.name));
    const wanted = new Map(mods.map((m) => [m.name, m.size || 0]));

    let local = [];
    try { local = fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f)); } catch (err) {}

    const missing = [], changed = [];
    wanted.forEach(function (size, name) {
      let st = null;
      try { st = fs.statSync(path.join(modsDir, name)); } catch (err) {}
      if (!st) missing.push(name);
      else if (size && st.size !== size) changed.push(name);
    });
    const extra = local.filter((f) => !wanted.has(f));

    // папки сборки: сменился архив или его убрали
    let extrasChanged = false;
    try {
      const all = (await fetchRelease(cfg)).all || [];
      const asset = all.find(function (a) {
        const n = String(a.name || "").toLowerCase();
        return n === EXTRAS_ASSET || (n.startsWith("extras") && n.endsWith(".zip"));
      });
      const st = readExtrasState(gameDir);
      const had = Array.isArray(st.paths) && st.paths.length > 0;
      extrasChanged = asset
        ? !(st.name === asset.name && st.size === asset.size && had)
        : had;
    } catch (err) {}

    const needsUpdate = (missing.length + changed.length + extra.length) > 0 || extrasChanged;
    return {
      ok: true, needsUpdate: needsUpdate,
      missing: missing.length, changed: changed.length, extra: extra.length,
      extrasChanged: extrasChanged, total: wanted.size
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("sync-mods", async (e, opts) => {
  const cfg = Object.assign(loadConfig(), opts || {});
  const root = path.join(app.getPath("appData"), ".javelinmc");
  const gameDir = instanceDir(root, cfg.version, cfg.loader || "forge");
  migrateLegacy(root, gameDir);
  fs.mkdirSync(gameDir, { recursive: true });
  const res = await syncMods(cfg, gameDir);
  // вместе с модами приезжают папки сборки (tacz, config и т.п.)
  try {
    const ex = await syncExtras(cfg, gameDir, function (msg, pct) {
      if (win) sendUI("mc-modprogress", { msg: msg, pct: pct == null ? -1 : pct });
    });
    if (ex && ex.paths) res.extras = ex.paths;
  } catch (e) {
    if (win) sendUI("mc-modprogress", { msg: "Папки сборки: " + e.message, pct: -1, error: true });
  }
  return res;
});

// ===== ПАПКИ СБОРОК =====
// Раньше все версии жили в одной папке с ОБЩЕЙ папкой mods — из-за этого моды от
// 1.20.1 попадали бы в 1.12.2 и роняли её. Теперь у каждой сборки своя игровая папка:
//   .javelinmc/instances/1.20.1-forge/{mods,saves,config,...}
// А тяжёлое (versions, libraries, assets) остаётся общим — иначе каждая версия
// занимала бы лишние сотни мегабайт.
function instanceId(version, loader) {
  const v = String(version || "unknown").trim();
  const l = String(loader || "vanilla").trim().toLowerCase().replace(/[^a-z0-9+]+/g, "-");
  return v + "-" + (l || "vanilla");
}

function instanceDir(root, version, loader) {
  return path.join(root, "instances", instanceId(version, loader));
}

// Разовый переезд: у тех, кто играл до этого обновления, сохранения и моды лежат
// в корне. Переносим их в папку серверной сборки, чтобы миры не потерялись.
const MOVABLE = ["saves", "mods", "config", "resourcepacks", "shaderpacks", "options.txt", "servers.dat"];
// 1.0.41. Раньше Java стартовала с рабочей папкой в корне (.javelinmc), и моды
// с контент-паками (Point Blank) распаковывали паки туда, мимо папки сборки.
// Игра их не видела -> у игрока не регистрировались сотни предметов -> сервер
// отбивал вход с "Failed to synchronize registry data". Теперь cwd = папка сборки,
// а прежние остатки убираем, чтобы не путались под ногами.
const PACK_DIRS = ["pointblank"];
function cleanupLegacyPacks(root, gameDir) {
  for (const name of PACK_DIRS) {
    // связка/симлинк на месте нормальной папки — убрать, иначе паки уедут в корень
    try {
      const inGame = path.join(gameDir, name);
      if (fs.lstatSync(inGame).isSymbolicLink()) {
        // на Windows это junction: unlink его не берёт, нужен rmdir
        try { fs.unlinkSync(inGame); } catch (e2) { fs.rmdirSync(inGame); }
      }
    } catch (e) { /* нет такой папки — и хорошо */ }
    // старый кэш в корне: мод создаёт его заново при каждом запуске, терять нечего
    try {
      const inRoot = path.join(root, name);
      if (fs.existsSync(inRoot)) fs.rmSync(inRoot, { recursive: true, force: true });
    } catch (e) { /* занято — переживём, вреда нет */ }
  }
}

function migrateLegacy(root, gameDir) {
  try {
    if (fs.existsSync(gameDir)) return false;            // уже переезжали
    // старые файлы забирает только САМАЯ ПЕРВАЯ созданная сборка. Иначе, если игрок
    // добавит 1.12.2 раньше, чем зайдёт на сервер, его миры от 1.20.1 уедут не туда.
    const inst = path.join(root, "instances");
    if (fs.existsSync(inst) && fs.readdirSync(inst).length) return false;
    const hasOld = MOVABLE.some((n) => fs.existsSync(path.join(root, n)));
    if (!hasOld) return false;                            // переносить нечего
    fs.mkdirSync(gameDir, { recursive: true });
    for (const name of MOVABLE) {
      const from = path.join(root, name);
      const to = path.join(gameDir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try { fs.renameSync(from, to); } catch (e) { /* занято игрой — оставляем как есть */ }
    }
    return true;
  } catch (e) { return false; }
}

// ===== НАСТРОЙКИ МОДОВ: СЕРВЕРНЫЕ ОТДЕЛЬНО ОТ СВОИХ =====
// Моды у режима сервера и режима игрока давно лежат в разных папках и не мешают
// друг другу. А вот папка config у режима игрока досталась в наследство от
// серверной сборки: игрок заходил «в свободную игру», а моды читали серверные
// настройки. Разводим и настройки тоже.
//
// Ничего не удаляем: убранное лежит рядом, в config-сервера, и его можно вернуть
// руками. И убираем ТОЛЬКО то, что в точности есть у серверной сборки — свои
// настройки игрока (от модов, которые он поставил сам) остаются на месте.
//
// Делается один раз на сборку: метка .javelin-config-split. Дальше режим игрока
// живёт своей папкой настроек, и лаунчер туда больше не лезет.
const CONFIG_SPLIT_MARK = ".javelin-config-split";

function freezeServerConfig(root, mc, loader, log) {
  try {
    const папкаИгрока = instanceDir(root, mc, loader) + "-player";
    if (!fs.existsSync(папкаИгрока)) return 0;
    const метка = path.join(папкаИгрока, CONFIG_SPLIT_MARK);
    if (fs.existsSync(метка)) return 0;                 // уже разводили

    const серверная = path.join(instanceDir(root, mc, loader), "config");
    const настройкиИгрока = path.join(папкаИгрока, "config");
    const склад = path.join(папкаИгрока, "config-сервера");
    let убрано = 0;
    if (fs.existsSync(настройкиИгрока)) {
      // Ровно та же складка, что и с модами: у режима сервера свои настройки,
      // у режима игрока — свои, и начинаются они с чистого листа. Всё, что
      // натекло в config от прежних версий лаунчера, уезжает целиком.
      // Моды игрока потом заведут себе настройки заново, уже свои.
      const убрать = fs.readdirSync(настройкиИгрока);
      for (const имя of убрать) {
        const откуда = path.join(настройкиИгрока, имя);
        if (!fs.existsSync(откуда)) continue;           // у игрока такого нет — не трогаем
        try { fs.mkdirSync(склад, { recursive: true }); } catch (e) {}
        const куда = path.join(склад, имя);
        try { fs.rmSync(куда, { recursive: true, force: true }); } catch (e) {}
        try { fs.renameSync(откуда, куда); убрано++; } catch (e) { /* занято — оставляем */ }
      }
    }
    try { fs.writeFileSync(метка, new Date().toISOString()); } catch (e) {}
    if (убрано && log) {
      log("режим игрока: серверных настроек убрано " + убрано +
          " (перенесены в config-сервера, ничего не удалено)");
    }
    return убрано;
  } catch (e) { return 0; }
}

// ===== ДИСКРЕТНАЯ ВИДЕОКАРТА ДЛЯ MINECRAFT =====
// На ноутбуках Windows игра по умолчанию запускается на встроенной графике (в
// процессоре) — из-за этого низкий FPS. Windows умеет привязать конкретный .exe
// к мощной видеокарте через реестр (HKCU, без прав администратора):
//   HKCU\Software\Microsoft\DirectX\UserGpuPreferences  ->  "GpuPreference=2;"
// (2 = «Высокая производительность» = дискретная видеокарта). Ровно так делает
// TLauncher. Спрашиваем разрешение один раз при первом запуске.
function gpuPrefFile() { return path.join(app.getPath("userData"), "gpu-pref.json"); }
function readGpuPref() { try { return JSON.parse(fs.readFileSync(gpuPrefFile(), "utf-8")); } catch (e) { return null; } }
function writeGpuPref(o) { try { fs.writeFileSync(gpuPrefFile(), JSON.stringify(o)); } catch (e) {} }

function setGpuHighPerf(exePath) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || !exePath) return resolve(false);
    execFile("reg", ["add", "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences",
      "/v", exePath, "/t", "REG_SZ", "/d", "GpuPreference=2;", "/f"], (err) => resolve(!err));
  });
}

// применить выбор игрока по видеокарте к запускаемому javaw.exe
// снять привязку к дискретной видеокарте (если игрок выключил настройку)
function clearGpuHighPerf(exePath) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || !exePath) return resolve(false);
    execFile("reg", ["delete", "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences",
      "/v", exePath, "/f"], (err) => resolve(!err));
  });
}

async function applyGpuPreference(javaExe) {
  if (process.platform !== "win32" || !javaExe) return;
  let pref = readGpuPref();
  // Включено по умолчанию, без вопросов. Раньше лаунчер при первом запуске спрашивал
  // разрешение, многие жали «нет» не разобравшись — и потом жаловались на низкий FPS.
  // Теперь это просто настройка, её можно выключить в разделе «Настройки».
  if (!pref) { pref = { high: true }; writeGpuPref(pref); }
  if (!pref.high) {
    // игрок выключил — убираем прежнюю привязку, чтобы настройка реально действовала
    await clearGpuHighPerf(javaExe);
    const alt0 = javaExe.replace(/javaw\.exe$/i, "java.exe");
    if (alt0 !== javaExe) await clearGpuHighPerf(alt0);
  }
  if (pref.high) {
    const ok = await setGpuHighPerf(javaExe);
    // на всякий случай привязываем и java.exe рядом
    const alt = javaExe.replace(/javaw\.exe$/i, "java.exe");
    if (alt !== javaExe && fs.existsSync(alt)) await setGpuHighPerf(alt);
    if (win) sendUI("mc-log", "[javelin] видеокарта: " + (ok ? "дискретная (высокая производительность)" : "не удалось задать"));
  }
}

// ===== ПОЧЕМУ ИГРА ЗАКРЫЛАСЬ =====
// Игрок видел только «Игра закрылась с кодом 1» — и ни он, ни администратор по
// этому коду ничего понять не могли. А в выводе Java причина почти всегда есть,
// её просто никто не читал. Разбираем вывод сами и говорим по-человечески:
// что произошло и что с этим делать.
const CRASH_SIGNS = [
  [/Could not reserve enough space|Error occurred during initialization of VM|Failed to reserve|insufficient memory/i,
   "Игре выделено больше памяти, чем есть на этом компьютере — Java не смогла её занять.",
   "Открой «Настройки» и убавь ползунок памяти. Хорошее правило: не больше половины памяти компьютера."],

  [/java\.lang\.OutOfMemoryError/i,
   "Игре не хватило выделенной памяти.",
   "Открой «Настройки» и прибавь памяти на 1–2 ГБ. Если прибавлять уже некуда — уменьши прорисовку в игре."],

  [/EXCEPTION_ACCESS_VIOLATION|A fatal error has been detected|hs_err_pid|ig[0-9]*icd|atio6axx|nvoglv/i,
   "Игру уронил драйвер видеокарты — это сбой вне самой игры.",
   "Обнови драйвер видеокарты с сайта NVIDIA, AMD или Intel и запусти снова. Если не поможет — включи «Облегчённый режим» в настройках."],

  [/Timed out trying to setup the Game Window|GLFW error|Failed to create window|Pixel format not accelerated|OpenGL 3\.2|No OpenGL context/i,
   "Не удалось создать окно игры — видеокарта или её драйвер не потянули запуск.",
   "Обнови драйвер видеокарты. Если компьютер с двумя видеокартами — проверь в «Настройках», что включён запуск на дискретной."],

  [/Missing or unsupported mandatory dependencies|Incompatible mods found|requires .* but only .* is available/i,
   "Сборка модов не сходится: какому-то моду не хватает другого или версия не та.",
   "Открой «Моды», нажми «Проверить сборку» и доустанови недостающее. Если ставил моды вручную — убери последний добавленный."],

  [/Mixin apply failed|Mixin transformation of|InvalidInjectionException|CrashReportExtender/i,
   "Два мода поссорились между собой при запуске.",
   "Убери мод, который ставил последним, и попробуй снова. Название виноватого мода обычно есть в логе выше."],

  [/Unable to fit|Failed to stitch|TextureStitchException/i,
   "Видеокарта не смогла собрать текстуры — их слишком много для неё.",
   "Включи «Облегчённый режим» в настройках: он ставит игре щадящие настройки графики."],
];

// text — весь вывод игры, code — код выхода, sec — сколько секунд она прожила
function crashReason(text, code, sec) {
  const t = String(text || "");
  for (const [re, что, что_делать] of CRASH_SIGNS) {
    if (re.test(t)) return что + "\n\nЧто делать: " + что_делать;
  }
  // Известных признаков нет — говорим хотя бы то, что понятно по коду выхода.
  // 4294967295 это те же -1: игру не закрыли, её оборвало.
  if (code === 4294967295 || code === -1 || code === 3221225477) {
    return "Игра оборвалась на ходу — так бывает при сбое драйвера видеокарты или когда системе не хватило памяти." +
      "\n\nЧто делать: обнови драйвер видеокарты, а в «Настройках» убавь ползунок памяти на 1–2 ГБ.";
  }
  if (code === 1 && sec < 20 && !/Setting user|LWJGL|Backend library/i.test(t)) {
    return "Java не запустилась вовсе — до самой игры дело не дошло." +
      "\n\nЧто делать: чаще всего это слишком большой ползунок памяти в «Настройках» — убавь его. " +
      "Если не поможет, проверь, не блокирует ли антивирус javaw.exe.";
  }
  return "";
}

// ===== ЛЕЧЕНИЕ БИТЫХ ФАЙЛОВ ИГРЫ =====
// Самая частая жалоба игроков: окно «Processor failed, invalid outputs», где у ДВУХ
// разных файлов одна и та же сумма b04f3ee8... Это подпись ПУСТОГО zip-архива.
// Происходит так: Forge делит client.jar игры на две части (slim и extra), но если сам
// client.jar докачался обрезанным, обе части выходят пустыми — отсюда и ошибка.
//
// Чинить это игрок сам не мог: движок запуска (MCLC) скачивает client.jar ТОЛЬКО если
// файла нет вообще (if (!fs.existsSync(mcPath))), а размер и сумму не проверяет никогда.
// Поэтому битый файл жил на диске вечно, и удаление папки libraries не помогало —
// обрезок лежит в versions. Теперь проверяем сами и удаляем негодное, чтобы скачалось заново.
const EMPTY_ZIP_SHA1 = "b04f3ee8f5e43fa3b162981b50bb72fe1acabb33";   // пустой архив, 22 байта

function sha1File(f) {
  try { return crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); }
  catch (e) { return ""; }
}

// Проверяет клиент игры и части, которые из него делает Forge. Всё негодное удаляет
// и возвращает список удалённого (для лога). Никогда не бросает исключений: лечение
// не должно мешать запуску.
function repairGameFiles(root, mcVer) {
  const killed = [];
  try {
    // --- клиент игры: versions/<версия>/<версия>.jar ---
    const vdir = path.join(root, "versions", mcVer);
    const jar = path.join(vdir, mcVer + ".jar");
    if (fs.existsSync(jar)) {
      let broken = false;
      try { broken = fs.statSync(jar).size < 1024 * 1024; } catch (e) { broken = true; }  // клиент меньше мегабайта — обрезок
      if (!broken) {
        // официальная сумма лежит рядом, в <версия>.json — сеть не нужна
        let want = "";
        try {
          const j = JSON.parse(fs.readFileSync(path.join(vdir, mcVer + ".json"), "utf-8"));
          want = ((j.downloads || {}).client || {}).sha1 || "";
        } catch (e) {}
        if (want) broken = sha1File(jar) !== want;
      }
      if (broken) { try { fs.unlinkSync(jar); killed.push(mcVer + ".jar"); } catch (e) {} }
    }

    // --- части, которые Forge делает из клиента ---
    const cdir = path.join(root, "libraries", "net", "minecraft", "client");
    if (fs.existsSync(cdir)) {
      for (const sub of fs.readdirSync(cdir)) {
        if (sub !== mcVer && sub.indexOf(mcVer + "-") !== 0) continue;   // только нужная версия
        const full = path.join(cdir, sub);
        let files = [];
        try { files = fs.readdirSync(full).filter((n) => /\.jar$/i.test(n)); } catch (e) { continue; }
        const anyEmpty = files.some((n) => {
          const f = path.join(full, n);
          try { return fs.statSync(f).size <= 32 || sha1File(f) === EMPTY_ZIP_SHA1; } catch (e) { return false; }
        });
        // если пустая хотя бы одна часть — сносим все: они собираются комплектом
        if (anyEmpty) for (const n of files) { try { fs.unlinkSync(path.join(full, n)); killed.push(n); } catch (e) {} }
      }
    }
  } catch (e) { /* молча: лечение не должно ломать запуск */ }
  return killed;
}

// ===== НАСТРОЙКА JAVA ПОД МАШИНУ ИГРОКА =====
// Раньше в игру уходило всего два аргумента, а начальный объём памяти был жёстко
// прописан как 2 ГБ. Из-за этого игрок со слабым ПК, выставивший 1-2 ГБ, получал
// «-Xms2G -Xmx1G» — начальный объём БОЛЬШЕ максимального, и Java отказывалась
// стартовать вообще. В других лаунчерах сборка при этом запускалась.
//
// Плюс не было ни одного флага сборщика мусора: на модовой сборке это заикания
// и вылеты по памяти. Ниже — набор G1, который ставят все нормальные лаунчеры,
// с поправками под слабые машины.

// Ползунок теперь ходит с шагом 0,5 ГБ, а Java не понимает «-Xmx7.5G» — только целые
// гигабайты либо мегабайты. Поэтому всё считаем в мегабайтах.
// Сколько памяти на этой машине вообще можно отдать игре.
// Ползунок в настройках позволял выставить ВСЮ память машины, и игроки так и
// делали: 8 из 8 ГБ. Java столько зарезервировать не может — самой Windows и
// лаунчеру тоже нужно место, — и игра падала сразу после «Launching with
// arguments» с кодом 1, ничего не написав. Поэтому держим потолок сами:
// не больше 75% памяти машины и всегда минус 2 ГБ системе.
function machineMb() {
  try { return Math.floor(require("os").totalmem() / 1048576); } catch (e) { return 0; }
}
function safeMaxMb() {
  const total = machineMb();
  if (!total) return 65536;                       // память не определилась — не мешаем
  return Math.max(1024, Math.min(Math.floor(total * 0.75), total - 2048));
}
// Сколько памяти можно предложить игроку в настройках (в целых гигабайтах)
function safeMaxGb() { return Math.max(1, Math.floor(safeMaxMb() / 1024)); }

function ramMb(ramGb) {
  const g = Math.max(1, parseFloat(ramGb) || 4);
  const want = Math.max(1024, Math.round(g * 1024));
  return Math.min(want, safeMaxMb());
}
// начальный объём кучи: половина выбранного, но не больше 2 ГБ и НИКОГДА не больше максимума
function javaXmsMb(ramGb) {
  const mx = ramMb(ramGb);
  return Math.max(512, Math.min(2048, Math.floor(mx / 2), mx));
}

function javaFlags(ramGb, lite) {
  const ram = Math.max(1, parseFloat(ramGb) || 4);
  const f = [
    "-XX:+UseG1GC",                        // сборщик мусора с короткими паузами
    "-XX:+ParallelRefProcEnabled",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",              // моды любят звать сборку вручную — это только вредит
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxGCPauseMillis=" + (lite ? 130 : 200),
    "-XX:G1HeapRegionSize=" + (ram >= 8 ? "16M" : (ram >= 4 ? "8M" : "4M")),
    "-XX:G1NewSizePercent=" + (lite ? 20 : 30),
    "-XX:G1MaxNewSizePercent=" + (lite ? 35 : 40),
    "-XX:G1ReservePercent=" + (lite ? 15 : 20),
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    "-XX:InitiatingHeapOccupancyPercent=" + (lite ? 20 : 15),
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:MaxTenuringThreshold=1"
  ];
  // AlwaysPreTouch занимает ВСЮ выделенную память сразу при старте. Мощной
  // машине это убирает подтормаживания, а вот если игре отдали большую часть
  // памяти — система убивает процесс прямо на разогреве, и игрок видит вылет
  // без единой строчки в логе. Поэтому включаем, только если куча занимает
  // не больше половины памяти машины.
  const total = machineMb();
  if (!lite && ram >= 6 && total && ramMb(ram) * 2 <= total) f.push("-XX:+AlwaysPreTouch");
  return f;
}

// ===== НАСТРОЙКИ ИГРЫ ДЛЯ СЛАБОГО ПК =====
// Раньше «режим для слабого ПК» менял только вид лаунчера, а сама игра запускалась
// с обычными настройками — толку игроку от этого было мало. Теперь при первом запуске
// в этом режиме мы аккуратно прописываем игре щадящие настройки графики.
//
// Трогаем ТОЛЬКО перечисленные ключи, остальное в файле остаётся как было, и делаем
// это один раз на сборку (метка .javelin-lite). Дальше игрок волен менять всё сам —
// перезаписывать его выбор при каждом запуске было бы наглостью.
//
// Отдельно важен mipmapLevels:0 — именно из-за больших текстур на встроенных видеокартах
// игра падала с «Unable to fit ... 2048x2048» ещё до главного меню.
const LITE_OPTIONS = {
  graphicsMode: "0",          // быстрая графика
  renderDistance: "6",        // прорисовка 6 чанков
  simulationDistance: "6",
  mipmapLevels: "0",          // спасает слабые видеокарты от вылета на сшивке текстур
  particles: "2",             // минимум частиц
  entityShadows: "false",
  ao: "false",                // без плавного освещения
  biomeBlendRadius: "0",
  enableVsync: "false",
  maxFps: "60",
  renderClouds: "false",
  fancyGraphics: "false"      // ключ старых версий, новым не мешает
};

function applyLiteGameOptions(gameDir, log) {
  try {
    const mark = path.join(gameDir, ".javelin-lite");
    if (fs.existsSync(mark)) return false;              // уже настраивали — не лезем повторно
    fs.mkdirSync(gameDir, { recursive: true });
    const f = path.join(gameDir, "options.txt");

    const map = new Map();
    if (fs.existsSync(f)) {
      String(fs.readFileSync(f, "utf-8")).split(/\r?\n/).forEach(function (line) {
        const i = line.indexOf(":");
        if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
      });
    }
    Object.keys(LITE_OPTIONS).forEach(function (k) { map.set(k, LITE_OPTIONS[k]); });

    const out = [];
    map.forEach(function (v, k) { out.push(k + ":" + v); });
    fs.writeFileSync(f, out.join("\n") + "\n", "utf-8");
    fs.writeFileSync(mark, new Date().toISOString(), "utf-8");
    if (log) log("режим слабого ПК: игре прописаны щадящие настройки графики (прорисовка 6, без теней и сглаживания, mipmap 0)");
    return true;
  } catch (e) { return false; }
}

// ===== ПЕРЕВОД ОПИСАНИЙ =====
// Описания модов везде английские, а лаунчер у большинства на русском. Переводим
// на лету и запоминаем перевод на диске: один и тот же мод переводится один раз,
// дальше берётся из памяти и работает даже без интернета.
const TRA_LANGS = { ru: 1, uk: 1, pl: 1, kk: 1 };     // на английский переводить нечего
const TRA_SEP = "\u2063";                             // невидимый разделитель для пачки
const TRA_MAX = 4200;                                 // столько символов переводчик берёт за раз
let traBlockedUntil = 0;                              // переводчик отругался — подождём

function traFile(lang) {
  return path.join(app.getPath("userData"), "translate-" + String(lang).replace(/[^a-z]/gi, "") + ".json");
}
const traMem = {};        // { lang: { ключ: перевод } }
const traDirty = {};
function traStore(lang) {
  if (!traMem[lang]) {
    try { traMem[lang] = JSON.parse(fs.readFileSync(traFile(lang), "utf-8")) || {}; }
    catch (e) { traMem[lang] = {}; }
  }
  return traMem[lang];
}
function traKey(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
}
function traFlush(lang) {
  if (!traDirty[lang]) return;
  traDirty[lang] = false;
  try { fs.writeFileSync(traFile(lang), JSON.stringify(traMem[lang])); } catch (e) {}
}

// один запрос к переводчику
async function traOnce(text, lang) {
  if (Date.now() < traBlockedUntil) return "";
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
    encodeURIComponent(lang) + "&dt=t&q=" + encodeURIComponent(text);
  let r;
  try {
    r = await fetchRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 2);
  } catch (e) { traBlockedUntil = Date.now() + 30 * 1000; return ""; }
  if (!r.ok) {
    // 429 — слишком часто. Короткая передышка: десять минут английских описаний
    // игрок точно заметит, а полминуты — почти нет.
    if (r.status === 429 || r.status === 403) traBlockedUntil = Date.now() + 40 * 1000;
    return "";
  }
  let j;
  try { j = await r.json(); } catch (e) { return ""; }
  if (!j || !Array.isArray(j[0])) return "";
  return j[0].map((x) => (x && x[0]) || "").join("");
}

// Письменности, которые нельзя мешать в общую пачку. Переводчик определяет язык
// ОДИН раз на всю пачку: если там четырнадцать английских описаний и одно
// китайское, он решит, что всё английское, и китайское вернёт как было —
// именно так игроку и попадались иероглифы при русском лаунчере.
const ЧУЖАЯ_ПИСЬМЕННОСТЬ =
  /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f]/;

// Похоже ли, что строку так и не перевели: в ней остались иероглифы (или другая
// чужая письменность), хотя перевод просили на язык лаунчера.
function непереведено(текст) { return ЧУЖАЯ_ПИСЬМЕННОСТЬ.test(String(текст || "")); }

// Перевод пачки строк одним запросом: склеиваем невидимым разделителем, он в
// переводе выживает. Если частей вернулось не столько же — переводим по одной.
async function traMany(texts, lang) {
  const out = new Array(texts.length).fill("");

  // Сначала выдёргиваем строки на чужой письменности и переводим их поодиночке,
  // каждую со своим определением языка. Остальные пойдут пачкой, как и раньше.
  const обычные = [], гдеОбычные = [];
  for (let i = 0; i < texts.length; i++) {
    if (непереведено(texts[i])) out[i] = (await traOnce(texts[i], lang)) || "";
    else { обычные.push(texts[i]); гдеОбычные.push(i); }
  }
  if (!обычные.length) return out;
  if (обычные.length !== texts.length) {
    const часть = await traMany(обычные, lang);
    for (let k = 0; k < гдеОбычные.length; k++) out[гдеОбычные[k]] = часть[k];
    return out;
  }

  const joined = texts.join("\n" + TRA_SEP + "\n");
  if (joined.length <= TRA_MAX) {
    const got = await traOnce(joined, lang);
    if (got) {
      const parts = got.split(TRA_SEP);
      if (parts.length === texts.length) {
        const res = parts.map((x) => x.trim());
        // Иногда на стыке кусков теряется хвост фразы. Такие строки (перевод
        // заметно короче оригинала) переспрашиваем поодиночке.
        for (let i = 0; i < res.length; i++) {
          // Русский текст обычно ДЛИННЕЕ английского, поэтому перевод короче
          // двух третей оригинала — почти наверняка обрезанный.
          const обрезано = texts[i].length > 40 && res[i].length < texts[i].length * 0.65;
          // ...а заодно проверяем, не вернулось ли что-то вовсе непереведённым
          if (обрезано || непереведено(res[i])) {
            const one = await traOnce(texts[i], lang);
            if (one) res[i] = one.trim();
          }
        }
        return res;
      }
    }
  }
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].length <= TRA_MAX) out[i] = (await traOnce(texts[i], lang)) || "";
    else out[i] = await traLong(texts[i], lang);
  }
  return out;
}

// Длинный текст (полное описание мода) режем по абзацам и переводим кусками.
async function traLong(text, lang) {
  const chunks = [];
  let cur = "";
  String(text).split(/\n{2,}/).forEach((par) => {
    if ((cur + "\n\n" + par).length > TRA_MAX && cur) { chunks.push(cur); cur = par; }
    else cur = cur ? (cur + "\n\n" + par) : par;
  });
  if (cur) chunks.push(cur);
  const done = [];
  for (const c of chunks.slice(0, 14)) {           // очень длинные описания режем: смысл уже понятен
    const t = await traOnce(c, lang);
    if (!t) return "";                             // переводчик молчит — отдаём оригинал целиком
    done.push(t);
  }
  return done.join("\n\n");
}

// Главная точка: массив строк -> массив переводов. Уже переведённое берём из памяти.
async function translateList(texts, lang) {
  const L = String(lang || "").toLowerCase();
  const list = (texts || []).map((x) => String(x == null ? "" : x));
  if (!TRA_LANGS[L]) return list;                  // язык не требует перевода
  const store = traStore(L);
  const out = list.slice();
  const need = [], where = [];
  list.forEach((t, i) => {
    const clean = t.trim();
    if (!clean) { out[i] = t; return; }
    const k = traKey(clean);
    if (store[k] !== undefined) { out[i] = store[k]; return; }
    // Если текста на латинице нет вовсе — переводить нечего (уже по-русски).
    if (!/[a-z]/i.test(clean)) { out[i] = t; return; }
    need.push(clean); where.push(i);
  });
  if (!need.length) return out;

  // пачками по 12 строк, чтобы не слать простыню одним куском
  for (let start = 0; start < need.length; start += 12) {
    const part = need.slice(start, start + 12);
    const got = await traMany(part, L);
    got.forEach((t, k) => {
      const idx = where[start + k];
      if (t) {
        out[idx] = t;
        store[traKey(part[k])] = t;
        traDirty[L] = true;
      }
    });
  }
  traFlush(L);
  return out;
}

ipcMain.handle("translate-texts", async (e, texts, lang) => {
  try { return { ok: true, texts: await translateList(texts, lang) }; }
  catch (err) { return { ok: false, texts: texts || [], error: String((err && err.message) || err) }; }
});

// Русский запрос -> английский, чтобы искать по каталогу. Ответ помним, иначе
// каждая буква в строке поиска дёргала бы переводчик.
const traQuery = {};
async function translateQuery(q) {
  const k = String(q || "").trim().toLowerCase();
  if (!k || !/[а-яё]/i.test(k)) return "";
  if (traQuery[k] !== undefined) return traQuery[k];
  let t = "";
  try { t = await traOnce(k, "en"); } catch (e) { t = ""; }
  t = String(t || "").trim();
  if (t.toLowerCase() === k) t = "";
  traQuery[k] = t;
  return t;
}

// ===== ПЕРЕВОД: конец =====

// ===== СВОИ СБОРКИ (ПАКИ) =====
// Игрок может собрать свою сборку под любую версию: дать ей имя, выбрать версию и
// загрузчик, задать свою память. У каждого пака отдельная папка, поэтому моды одного
// пака не мешают другому, и серверная сборка остаётся нетронутой.
//
// Список паков лежит рядом с настройками лаунчера, сами паки — в instances/pack-<id>.
function packsFile() { return path.join(app.getPath("userData"), "packs.json"); }

function readPacks() {
  try {
    const j = JSON.parse(fs.readFileSync(packsFile(), "utf-8"));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
function writePacks(list) {
  try { fs.writeFileSync(packsFile(), JSON.stringify(list, null, 2)); return true; }
  catch (e) { return false; }
}
function packDir(id) {
  const root = path.join(app.getPath("appData"), ".javelinmc");
  return path.join(root, "instances", "pack-" + String(id).replace(/[^a-z0-9_-]/gi, ""));
}
function findPack(id) {
  const s = String(id || "");
  return readPacks().find((x) => String(x.id) === s) || null;
}

// Имя сборки может быть любым, а вот имя папки должно быть простым: кириллицу
// разные системы пишут по-разному, поэтому переводим её латиницей («Техно» ->
// «tehno»). Так игрок и в проводнике узнает свою сборку.
function packId(name, taken) {
  let base = translit(String(name || "")).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)
    .replace(/-+$/g, "");
  if (!base) base = "pack";
  let id = base, n = 2;
  while (taken.indexOf(id) >= 0) { id = base + "-" + n; n++; }
  return id;
}

ipcMain.handle("packs-list", () => {
  const list = readPacks().map((x) => {
    let mods = 0;
    try { mods = listJars(path.join(packDir(x.id), "mods")).length; } catch (e) {}
    return Object.assign({}, x, { mods: mods, dir: packDir(x.id) });
  });
  return { ok: true, packs: list };
});

// У каждой сборки своя папка — это правильно, но игрок этого не ждёт: он создаёт
// сборку и попадает будто в свежий Minecraft, где сброшены все настройки и нет
// списка серверов. Поэтому новой сборке отдаём копию настроек и списка серверов
// из той сборки, где игрок уже играл. Миры не трогаем: они у каждой свои.
const SEED_FILES = ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"];
function seedFromPlayer(dest, mc, loader) {
  const root = path.join(app.getPath("appData"), ".javelinmc");
  const from = [];
  try {
    // сначала пробуем ту же версию, потом любую, где игрок уже что-то настроил
    from.push(instanceDir(root, mc, loader) + "-player");
    from.push(instanceDir(root, mc, loader));
    const inst = path.join(root, "instances");
    for (const nm of fs.readdirSync(inst)) from.push(path.join(inst, nm));
  } catch (e) {}
  for (const dir of from) {
    let got = 0;
    for (const f of SEED_FILES) {
      const a = path.join(dir, f), b = path.join(dest, f);
      if (!fs.existsSync(a) || fs.existsSync(b)) continue;
      try { fs.copyFileSync(a, b); got++; } catch (e) {}
    }
    if (got) return true;                      // нашли обжитую папку — дальше не ищем
  }
  return false;
}

ipcMain.handle("packs-create", (e, data) => {
  try {
    const d = data || {};
    const name = String(d.name || "").trim().slice(0, 40);
    if (!name) return { ok: false, error: "у сборки должно быть название" };
    const list = readPacks();
    if (list.some((x) => String(x.name).toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: "сборка с таким названием уже есть" };
    }
    const pack = {
      id: packId(name, list.map((x) => x.id)),
      name: name,
      mc: String(d.mc || "1.20.1"),
      loader: String(d.loader || "forge").toLowerCase(),
      // пусто = рекомендованная сборка Forge под эту версию
      forge: String(d.forge || "").trim(),
      // ram = null означает «брать из настроек лаунчера»
      ram: (d.ram === null || d.ram === undefined || d.ram === "") ? null : Number(d.ram),
      created: new Date().toISOString()
    };
    list.push(pack);
    if (!writePacks(list)) return { ok: false, error: "не удалось сохранить список сборок" };
    try {
      fs.mkdirSync(path.join(packDir(pack.id), "mods"), { recursive: true });
      fs.mkdirSync(path.join(packDir(pack.id), "config"), { recursive: true });
      seedFromPlayer(packDir(pack.id), pack.mc, pack.loader);
    } catch (err) {}
    return { ok: true, pack: Object.assign({}, pack, { mods: 0, dir: packDir(pack.id) }) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle("packs-update", (e, id, data) => {
  try {
    const list = readPacks();
    const i = list.findIndex((x) => String(x.id) === String(id));
    if (i < 0) return { ok: false, error: "сборка не найдена" };
    const d = data || {};
    if (d.name !== undefined) {
      const nm = String(d.name).trim().slice(0, 40);
      if (!nm) return { ok: false, error: "название не может быть пустым" };
      list[i].name = nm;
    }
    if (d.ram !== undefined) list[i].ram = (d.ram === null || d.ram === "") ? null : Number(d.ram);
    writePacks(list);
    return { ok: true, pack: list[i] };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// Удаляем только запись о сборке. Папку с модами и мирами не трогаем: удалить чужие
// миры одним нажатием — слишком грубо. Папка остаётся, её видно кнопкой «Папка».
ipcMain.handle("packs-delete", (e, id) => {
  try {
    const list = readPacks().filter((x) => String(x.id) !== String(id));
    writePacks(list);
    return { ok: true, dir: packDir(id) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle("packs-open", (e, id) => {
  try {
    const dir = packDir(id);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle("packs-forge-builds", async (e, mc) => {
  try {
    const list = await forgeBuildsFor(String(mc || "1.20.1"));
    const p = await forgePromos();
    return { ok: true, builds: list, recommended: p[mc + "-recommended"] || "", latest: p[mc + "-latest"] || "" };
  } catch (err) { return { ok: false, builds: [], error: String((err && err.message) || err) }; }
});

// Всё содержимое сборки, разложенное по видам: моды, ресурспаки, шейдеры,
// датапаки и миры. Миры — это папки, остальное — файлы.
const PACK_PARTS = [
  { key: "mods",          dir: "mods",          re: /\.jar$/i,        folder: false },
  { key: "resourcepacks", dir: "resourcepacks", re: /\.(zip|jar)$/i,  folder: false },
  { key: "shaderpacks",   dir: "shaderpacks",   re: /\.(zip|jar)$/i,  folder: false },
  { key: "datapacks",     dir: "datapacks",     re: /\.(zip|jar)$/i,  folder: false },
  { key: "saves",         dir: "saves",         re: /.*/,             folder: true  }
];

function dirSize(p) {
  let sum = 0;
  try {
    for (const nm of fs.readdirSync(p)) {
      const f = path.join(p, nm);
      const st = fs.statSync(f);
      sum += st.isDirectory() ? dirSize(f) : st.size;
    }
  } catch (e) {}
  return sum;
}

ipcMain.handle("packs-content", (e, id) => {
  try {
    const root = packDir(id);
    const out = {};
    PACK_PARTS.forEach((part) => {
      const p = path.join(root, part.dir);
      let items = [];
      try {
        items = fs.readdirSync(p).map((nm) => {
          const f = path.join(p, nm);
          let st = null; try { st = fs.statSync(f); } catch (err) {}
          const isDir = !!(st && st.isDirectory());
          return { name: nm, dir: isDir, size: isDir ? dirSize(f) : (st ? st.size : 0) };
        }).filter((x) => part.folder ? x.dir : (!x.dir && part.re.test(x.name)));
      } catch (err) { items = []; }
      out[part.key] = items;
    });
    return { ok: true, parts: out, dir: root };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// Удаление любой вещи из сборки: мода, ресурспака, шейдера, датапака или мира.
// Мир — это папка, поэтому убираем вместе с содержимым.
ipcMain.handle("packs-item-remove", (e, id, where, name) => {
  try {
    const part = PACK_PARTS.find((x) => x.key === String(where));
    if (!part) return { ok: false, error: "неизвестная папка" };
    const safe = String(name || "");
    if (!safe || safe !== path.basename(safe) || safe.indexOf("..") >= 0) {
      return { ok: false, error: "так нельзя" };
    }
    const f = path.join(packDir(id), part.dir, safe);
    if (!fs.existsSync(f)) return { ok: false, error: "уже удалено" };
    const st = fs.statSync(f);
    if (st.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
    else fs.unlinkSync(f);
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// Полное удаление сборки вместе с файлами — по отдельной просьбе игрока.
ipcMain.handle("packs-delete-files", (e, id) => {
  try {
    const dir = packDir(id);
    writePacks(readPacks().filter((x) => String(x.id) !== String(id)));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// моды выбранной сборки
ipcMain.handle("packs-mods", (e, id) => {
  try { return { ok: true, mods: listJars(path.join(packDir(id), "mods")) }; }
  catch (err) { return { ok: false, mods: [] }; }
});

ipcMain.handle("packs-mod-remove", (e, id, name) => {
  try {
    // принимаем только обычное имя файла: без путей, без «..»
    const safe = String(name || "");
    if (!safe || safe !== path.basename(safe) || safe.indexOf("..") >= 0 || !/\.jar$/i.test(safe)) {
      return { ok: false, error: "так нельзя" };
    }
    const f = path.join(packDir(id), "mods", safe);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true, mods: listJars(path.join(packDir(id), "mods")) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// ===== СВОИ СБОРКИ: конец =====

// ===== КАТАЛОГ МОДОВ =====
// Моды берём с Modrinth: открытый каталог, без ключей и регистрации.
// Поиск свой, поверх каталога, потому что родной понимает только точные английские
// названия. Наш умеет три вещи, которых у него нет:
//   1) опечатки — «subrwaraffafre» находит Superb Warfare;
//   2) русские буквы в английском названии — «джеи» это jei, «ксаэрос» это Xaero's;
//   3) смысловые запросы — «танк» показывает моды про технику и оружие.
// Для этого держим у себя список популярных модов и ищем по нему на месте.

const MR_API = "https://api.modrinth.com/v2";
const MR_UA = "JavelinMC-launcher (github.com/akhmadmfw-debug)";
const INDEX_TTL = 7 * 24 * 60 * 60 * 1000;      // список модов освежаем раз в неделю
const INDEX_SIZE = 1500;                        // столько самых популярных держим у себя

function modIndexFile(mc, loader) {
  return path.join(app.getPath("userData"), "modindex-" + mc + "-" + loader + ".json");
}

// ---------- список модов у себя ----------
async function buildModIndex(mc, loader, onProgress) {
  const out = [];
  const facets = encodeURIComponent(
    '[["versions:' + mc + '"],["categories:' + loader + '"],["project_type:mod"]]');
  for (let off = 0; off < INDEX_SIZE; off += 100) {
    let r;
    try {
      r = await fetchRetry(MR_API + "/search?facets=" + facets + "&limit=100&offset=" + off +
        "&index=downloads", { headers: { "User-Agent": MR_UA } }, 2);
    } catch (e) { break; }
    if (!r || !r.ok) break;
    let j = null;
    try { j = await r.json(); } catch (e) { break; }
    const hits = (j && j.hits) || [];
    hits.forEach((h) => out.push({
      s: h.slug, t: h.title, d: String(h.description || "").slice(0, 160),
      a: h.author || "", i: h.icon_url || "", dl: h.downloads || 0,
      c: (h.categories || []).join(" ")
    }));
    if (onProgress) onProgress(out.length);
    if (hits.length < 100) break;
  }
  return out;
}

// только читаем готовый список, ничего не качая
function modIndexCached(mc, loader) {
  try {
    const j = JSON.parse(fs.readFileSync(modIndexFile(mc, loader), "utf-8"));
    return (Array.isArray(j) && j.length > 200) ? j : null;
  } catch (e) { return null; }
}

async function modIndex(mc, loader, onProgress) {
  const f = modIndexFile(mc, loader);
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < INDEX_TTL) {
      const j = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (Array.isArray(j) && j.length > 200) return j;
    }
  } catch (e) {}
  const fresh = await buildModIndex(mc, loader, onProgress);
  if (fresh.length > 200) {
    try { fs.writeFileSync(f, JSON.stringify(fresh)); } catch (e) {}
    return fresh;
  }
  // не собрался — отдадим хоть устаревший, лучше чем ничего
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return fresh; }
}

// ---------- поисковый движок ----------
// русское слово -> английские, по которым реально названы моды
const RU_WORDS = {
  "танк":"tank military warfare vehicle", "танки":"tank military warfare vehicle",
  "оружие":"gun weapon firearm shooting", "пушка":"gun cannon weapon",
  "стрелялка":"gun weapon shooting", "автомат":"gun rifle weapon", "пистолет":"gun pistol weapon",
  "машина":"car vehicle transport", "машины":"car vehicle transport", "транспорт":"vehicle transport",
  "самолет":"plane aircraft flight", "самолёт":"plane aircraft flight", "вертолет":"helicopter aircraft",
  "техника":"vehicle machinery tech", "мебель":"furniture decoration", "декор":"decoration furniture",
  "магия":"magic spell wizard", "еда":"food cooking farming", "ферма":"farming agriculture",
  "броня":"armor equipment", "рюкзак":"backpack storage", "сундук":"storage chest",
  "карта":"map minimap", "карты":"map minimap", "миникарта":"minimap map",
  "оптимизация":"optimization performance fps",
  // Слова, которыми игроки описывают одно и то же желание — чтобы игра не тормозила
  "лаги":"performance optimization", "лагов":"performance optimization",
  "лагает":"performance optimization", "фпс":"fps performance",
  "тормозит":"performance optimization", "быстродействие":"performance optimization", "производительность":"performance fps optimization",
  "шейдеры":"shaders lighting", "мобы":"mobs creatures animals", "животные":"animals mobs",
  "строительство":"building decoration blocks", "инструменты":"tools equipment",
  "приключения":"adventure exploration", "подземелья":"dungeons adventure",
  "рпг":"rpg adventure leveling", "скины":"skin cosmetic", "звук":"sound audio",
  "чат":"chat social", "голосовой":"voice chat", "войс":"voice chat",
  // Названия популярных модов, как их пишут по-русски. Без этого «лакиблок»
  // не находился вообще: ни один поисковик такого слова не знает.
  "лаки":"lucky block", "лакиблок":"lucky block", "лакиблоки":"lucky block",
  "блок":"block", "блоки":"block",
  "джей":"jei just enough items", "индустриал":"industrial craft",
  "твилайт":"twilight forest", "сумеречный":"twilight forest",
  "биомы":"biomes o plenty terrain", "данжи":"dungeons structures",
  "оптифайн":"optifine sodium performance", "сходиум":"sodium performance",
  "литематика":"litematica schematics", "джорни":"journeymap map",
  "вейстоун":"waystones teleport", "иардс":"yards",
  "крафт":"crafting recipes", "рецепты":"recipes crafting",
  "аук":"auction shop economy", "экономика":"economy shop",
  "питомцы":"pets tameable animals", "драконы":"dragons mobs",
  "пушки":"guns weapons", "самолеты":"planes aircraft",
  "лифт":"elevator lift", "телепорт":"teleport waystones",
  "холодильник":"fridge furniture", "кухня":"cooking food kitchen",
  // Сокращения и русские написания известных модов. Точное совпадение проверяется
  // первым, поэтому короткие ключи вроде «ae2» здесь работают безопасно.
  "крейт":"create", "крэйт":"create", "ae2":"applied energistics",
  "ае2":"applied energistics", "ic2":"industrial craft", "ик2":"industrial craft",
  "rs":"refined storage", "рс":"refined storage",
  "мек":"mekanism", "меканизм":"mekanism", "тинкерс":"tinkers construct",
  "сходиум":"sodium", "содиум":"sodium", "джорни":"journeymap",
  "вейстоун":"waystones", "вейстоуны":"waystones", "биомы":"biomes o plenty",
  "твилайт":"twilight forest", "сумерки":"twilight forest",
  "иммерсив":"immersive engineering", "ботания":"botania", "торий":"thaumcraft",
  "сундуки":"iron chests storage", "терралит":"terralith",
  "фарм":"farming agriculture", "аппликейд":"applied energistics"
};

// Часто пишут название слитно: «luckyblock», «twilightforest». Поисковики такого
// не понимают. Пробуем аккуратно разделить по знакомым английским словам.
const SPLIT_WORDS = ["block","blocks","craft","crafting","forest","world","tech","magic",
  "item","items","tool","tools","gun","guns","car","cars","farm","food","sword","armor",
  "pack","plus","lite","core","api","lib","fix","tweaks","mod","map","chest","storage",
  "dragon","pet","pets","boss","dungeon","biome","biomes","village","ore","ores","machine"];

function splitConcat(q) {
  const w = String(q || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length < 7 || /\s/.test(String(q))) return "";
  for (const part of SPLIT_WORDS) {
    if (w.length <= part.length) continue;
    if (w.endsWith(part)) return w.slice(0, w.length - part.length) + " " + part;
    if (w.startsWith(part)) return part + " " + w.slice(part.length);
  }
  return "";
}

// «джеи» = jei, «ксаэрос» = xaeros: русскими буквами часто пишут английские названия
const TR_MAP = { "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i",
  "й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f",
  "х":"h","ц":"c","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya" };
function translit(str) {
  let x = String(str || "").toLowerCase().replace(/дж/g, "j").replace(/кс/g, "x");
  let out = "";
  for (const ch of x) out += (Object.prototype.hasOwnProperty.call(TR_MAP, ch) ? TR_MAP[ch] : ch);
  return out;
}
function hasCyr(str) { return /[а-яё]/i.test(String(str || "")); }
function onlyLetters(str) { return String(str || "").toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ""); }

function levDist(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}
function trigrams(str) {
  const out = new Set();
  for (let i = 0; i < str.length - 2; i++) out.add(str.slice(i, i + 3));
  return out;
}

// Разбираем строку на слова. Раньше слово запроса искали через indexOf, и «one»
// находилось внутри «WaystONEs»: по запросу «all in one 9» лаунчер уверенно
// предлагал Waystones. Теперь слово должно быть словом.
function wordsOf(str) {
  return String(str || "").toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((w) => w.length > 1);
}
// слово запроса нашлось среди слов названия: целиком, началом или с одной опечаткой
function wordHit(w, list) {
  const q = onlyLetters(w);
  if (!q) return false;
  for (const t of list) {
    if (t === q) return true;
    if (q.length >= 4 && (t.indexOf(q) === 0 || q.indexOf(t) === 0)) return true;
    if (q.length >= 5 && levDist(q, t) <= 1) return true;
  }
  return false;
}

function scoreOne(qRaw, item) {
  const q = onlyLetters(qRaw);
  if (!q) return 0;
  const title = onlyLetters(item.t), slug = onlyLetters(item.s);
  let best = 0;

  // Прямое вхождение. Для коротких запросов сверяем именно СЛОВА: «all» иначе
  // находилось внутри «ActuALLy Useful Stonecutter», и по запросу «all in one»
  // наверх лезли случайные моды.
  if (q.length >= 4) {
    if (title.indexOf(q) >= 0 || slug.indexOf(q) >= 0) best = 100;
  } else if (wordHit(qRaw, wordsOf(item.t).concat(wordsOf(item.s)))) {
    best = 100;
  }

  const words = String(qRaw).toLowerCase().split(/\s+/).filter(Boolean);
  // Считаем только значимые слова. Раньше «jenny mod» совпадал по слову «mod»
  // с «Entity Model Features» и получал высокий балл — из-за этого в выдачу
  // лезли случайные моды.
  const realWords = meaningful(words);
  const tWords = wordsOf(item.t).concat(wordsOf(item.s));
  if (realWords.length > 1) {
    const hits = realWords.filter((w) => wordHit(w, tWords)).length;
    // Все слова совпали — это точно он. Часть слов — совпадение слабое, и балл
    // должен остаться НИЖЕ порога исправления опечаток, иначе лаунчер начнёт
    // «поправлять» нормальные запросы на случайные моды.
    if (hits === realWords.length) best = Math.max(best, 96);
    else if (hits) best = Math.max(best, 28 + (hits / realWords.length) * 20);
  } else if (realWords.length === 1 && words.length > 1) {
    // осталось одно значимое слово — оно и должно найтись в названии
    if (wordHit(realWords[0], tWords)) best = Math.max(best, 92);
  }

  [title, slug].forEach((cand) => {                                     // опечатки
    const sim = 1 - levDist(q, cand) / Math.max(q.length, cand.length);
    if (sim > 0.45) best = Math.max(best, sim * 92);
  });

  const tq = trigrams(q), tt = trigrams(title);                         // перемешанные буквы
  if (tq.size && tt.size) {
    let shared = 0; tq.forEach((g) => { if (tt.has(g)) shared++; });
    const jj = shared / Math.min(tq.size, tt.size);
    if (jj > 0.3) best = Math.max(best, jj * 80);
  }

  // Совпадение по ОПИСАНИЮ: игрок часто ищет не название, а то, что мод делает
  // («магнит», «телепорт», «рюкзак»). Слова описания тоже разбираем на слова.
  const hayWords = wordsOf(item.t).concat(wordsOf(item.d), wordsOf(item.c));
  const real = meaningful(words);
  let theme = 0;
  real.forEach((w) => { if (wordHit(w, hayWords)) theme++; });
  if (real.length && theme === real.length) {
    best = Math.max(best, 34 + theme * 12);            // совпало всё — уверенно
  } else if (theme) {
    best = Math.max(best, 18 + theme * 8);             // часть слов — только для порядка в списке
  }

  return best + Math.min(6, Math.log10(Math.max(1, item.dl)));          // известность как довесок
}

function scoreItem(qRaw, item) {
  let best = scoreOne(qRaw, item);
  if (hasCyr(qRaw)) best = Math.max(best, scoreOne(translit(qRaw), item));   // «джеи» -> jei
  return best;
}

// Русское слово ищем в словаре с допуском на опечатку: «мимикарта» это «миникарта».
function ruLookup(w) {
  if (RU_WORDS[w]) return RU_WORDS[w];
  // Короткие слова через нечёткое сравнение искать нельзя: «лаки» отличается от
  // «танки» всего на две буквы, и поиск выдавал военные моды вместо Lucky Block.
  if (w.length < 6) return "";
  const allow = (w.length >= 8) ? 2 : 1;
  let best = "", bestD = 99;
  for (const k in RU_WORDS) {
    if (Math.abs(k.length - w.length) > allow) continue;
    const dd = levDist(w, k);
    if (dd < bestD) { bestD = dd; best = k; }
  }
  return (bestD <= allow) ? RU_WORDS[best] : "";
}

// Слова, которые есть почти у каждого мода. Раньше запрос «jenny mod» цеплялся
// за слово «mod» в описаниях и вытаскивал случайные моды — теперь такие слова
// в расчёт не идут.
const STOP = { "mod":1,"mods":1,"мод":1,"моды":1,"мода":1,"minecraft":1,"майнкрафт":1,
  "the":1,"for":1,"and":1,"на":1,"для":1,"и":1,
  // перевод русского запроса приносит служебные слова: «мод про поезда» ->
  // «mod about trains». Искать по ним бессмысленно.
  "about":1,"with":1,"your":1,"you":1,"from":1,"into":1,"that":1,"this":1,
  "про":1,"чтобы":1,"как":1,"это":1,"или":1,
  // Желания игрока переводятся глаголами: «хочу летать» -> «want to fly».
  // Искать по «want» бессмысленно — нужное слово здесь «fly».
  "want":1,"wants":1,"need":1,"needs":1,"like":1,"make":1,"makes":1,"get":1,
  "give":1,"adds":1,"using":1,"some":1,"best":1,"good":1,"хочу":1,"нужен":1,
  "нужно":1,"надо":1,"лучший":1,"лучшие":1 };
function meaningful(words) { return words.filter((w) => w.length > 2 && !STOP[w]); }

function expandQuery(qRaw) {
  const q = String(qRaw).toLowerCase().trim();
  const parts = [q];
  q.split(/\s+/).forEach((w) => { const t = ruLookup(w); if (t) parts.push(t); });
  return parts.join(" ").trim();
}

function searchIndex(index, qRaw, limit) {
  const q = expandQuery(qRaw);
  return index.map((it) => ({ it: it, sc: scoreItem(q, it) }))
    .filter((x) => x.sc > 25)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit || 30)
    .map((x) => Object.assign({ score: Math.round(x.sc) }, x.it));
}

// ---------- установка ----------
async function mrVersions(slug, mc, loader) {
  // Ресурспакам, шейдерам и датапакам загрузчик не задаём: у них он свой
  // («minecraft», «iris», «datapack»), и фильтр по Forge отсекал бы всё подряд.
  const url = MR_API + "/project/" + encodeURIComponent(slug) + "/version" +
    "?game_versions=" + encodeURIComponent('["' + mc + '"]') +
    (loader ? ("&loaders=" + encodeURIComponent('["' + loader + '"]')) : "");
  const r = await fetchRetry(url, { headers: { "User-Agent": MR_UA } }, 2);
  if (!r || !r.ok) throw new Error("каталог не ответил (HTTP " + (r ? r.status : "?") + ")");
  return await r.json();
}

// ставит мод и всё, без чего он не работает
async function installMod(slug, mc, loader, dir, seen, depth, log) {
  seen = seen || new Set();
  depth = depth || 0;
  if (seen.has(slug) || depth > 3) return [];
  seen.add(slug);

  const vers = await mrVersions(slug, mc, loader);
  if (!vers || !vers.length) throw new Error("нет версии под " + loader + " " + mc);
  const v = vers[0];                                    // каталог отдаёт новые первыми
  const file = (v.files || []).find((x) => x.primary) || (v.files || [])[0];
  if (!file) throw new Error("у версии нет файла");

  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  const done = [];

  if (!fs.existsSync(dest)) {
    await dl(file.url, { "User-Agent": MR_UA }, dest, file.filename);
    // сверяем контрольную сумму: битый мод хуже отсутствующего
    const want = (file.hashes && file.hashes.sha1) || "";
    if (want && sha1File(dest) !== want) {
      try { fs.unlinkSync(dest); } catch (e) {}
      throw new Error("файл скачался повреждённым: " + file.filename);
    }
    done.push(file.filename);
    if (log) log("установлен " + file.filename);
  }

  // обязательные зависимости — без них мод просто не запустится
  for (const d of (v.dependencies || [])) {
    if (d.dependency_type !== "required" || !d.project_id) continue;
    try {
      const more = await installMod(d.project_id, mc, loader, dir, seen, depth + 1, log);
      more.forEach((x) => done.push(x));
    } catch (e) { if (log) log("зависимость не встала: " + (e.message || e)); }
  }
  return done;
}

// ---------- мост для интерфейса ----------
// ---------- какие версии и загрузчики вообще бывают ----------
// Каталог не привязан к нашей серверной сборке: игрок может искать моды под любую
// версию Minecraft и любой загрузчик, как в других лаунчерах.
let _mrTags = null;
async function mrTags() {
  if (_mrTags) return _mrTags;
  const out = { versions: [], loaders: [] };
  try {
    const r = await fetchRetry(MR_API + "/tag/game_version", { headers: { "User-Agent": MR_UA } }, 2);
    if (r && r.ok) {
      const j = await r.json();
      out.versions = (j || []).filter((v) => v.version_type === "release").map((v) => v.version);
    }
  } catch (e) {}
  try {
    const r = await fetchRetry(MR_API + "/tag/loader", { headers: { "User-Agent": MR_UA } }, 2);
    if (r && r.ok) {
      const j = await r.json();
      // только те загрузчики, под которые вообще бывают моды
      const want = { forge: 1, fabric: 1, neoforge: 1, quilt: 1 };
      out.loaders = (j || []).map((l) => l.name).filter((n) => want[n]);
    }
  } catch (e) {}
  if (!out.versions.length) out.versions = ["1.21.1", "1.20.1", "1.19.2", "1.18.2", "1.16.5", "1.12.2"];
  if (!out.loaders.length) out.loaders = ["forge", "fabric", "neoforge", "quilt"];
  _mrTags = out;
  return out;
}

// Список для исправления опечаток готовим заранее, в фоне: игрок открыл каталог —
// мы тихо собираем его для выбранной версии. К моменту, когда он напечатает запрос
// с опечаткой, список уже на месте. Ждать его никто не заставляет.
ipcMain.handle("catalog-warmup", (e, mc, loader) => {
  try {
    const m = String(mc || "1.20.1"), l = String(loader || "forge");
    if (!modIndexCached(m, l)) modIndex(m, l).catch(() => {});
    return { ok: true };
  } catch (err) { return { ok: false }; }
});

ipcMain.handle("catalog-tags", async () => {
  try { return Object.assign({ ok: true }, await mrTags()); }
  catch (e) { return { ok: false, versions: [], loaders: [] }; }
});

// ---------- ВТОРОЙ ИСТОЧНИК: CurseForge ----------
// На Modrinth есть не всё: примерно четверти модов серверной сборки JavelinMC там нет
// (MTS, VVP, WMM, new_soviet и другие живут только на CurseForge). CurseForge отдаёт
// каталог только по ключу разработчика — он бесплатный, регистрируется за пару минут
// на console.curseforge.com, и кладётся в config.json полем "curseforgeKey".
//
// Без ключа всё работает как раньше, только по Modrinth: ни ошибок, ни пустых экранов.
//
// ВАЖНО про правила CurseForge: автор мода может запретить скачивание сторонними
// программами (флаг allowModDistribution). Такие моды мы НЕ качаем — вместо кнопки
// «Установить» показываем ссылку на страницу мода. Это их правило, и мы его соблюдаем.
const CF_API = "https://api.curseforge.com/v1";
const CF_GAME = 432;          // Minecraft
const CF_CLASS_MOD = 6;       // раздел «моды»
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

function cfKey() {
  try { return String((loadConfig() || {}).curseforgeKey || "").trim(); } catch (e) { return ""; }
}

async function cfRequest(pathAndQuery) {
  const key = cfKey();
  if (!key) return null;
  try {
    const r = await fetchRetry(CF_API + pathAndQuery, {
      headers: { "x-api-key": key, "Accept": "application/json", "User-Agent": MR_UA }
    }, 2);
    if (!r || !r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// приводим ответ CurseForge к тому же виду, что и карточки Modrinth
function cfToCard(m, mc, loader, type) {
  let ver = "";
  try {
    const idx = (m.latestFilesIndexes || []).find((x) =>
      x.gameVersion === mc && (!CF_LOADER[loader] || x.modLoader === CF_LOADER[loader]));
    if (idx && idx.filename) ver = String(idx.filename).replace(/\.jar$/i, "");
  } catch (e) {}
  return {
    s: "cf:" + m.id,                                   // отличаем источник прямо в ключе
    t: m.name || "",
    d: String(m.summary || "").slice(0, 200),
    a: ((m.authors || [])[0] || {}).name || "",
    i: (m.logo && m.logo.thumbnailUrl) || (m.logo && m.logo.url) || "",
    dl: m.downloadCount || 0,
    c: (m.categories || []).map((x) => x.name).join(" "),
    ver: ver,
    mcv: mc,
    src: "curseforge",
    page: (m.links && m.links.websiteUrl) || "",
    blocked: (m.allowModDistribution === false)        // автор запретил сторонние загрузки
  };
}

// Свежесозданный ключ CurseForge какое-то время отвечает 403 на поиск — он ещё не
// разошёлся по их серверам. Поэтому отказ запоминаем НЕ навсегда, а на десять минут:
// иначе один неудачный запрос в момент запуска навсегда отключил бы второй источник.
let cfBlockedUntil = 0;

async function cfSearch(query, mc, loader, limit, offset, type) {
  if (Date.now() < cfBlockedUntil) return { hits: [], total: 0 };
  const kind = contentOf(type);
  const ml = kind.loader ? CF_LOADER[String(loader).toLowerCase()] : 0;
  let q = "/mods/search?gameId=" + CF_GAME + "&classId=" + kind.cf +
    "&gameVersion=" + encodeURIComponent(mc) +
    "&pageSize=" + (limit || 30) + "&index=" + (offset || 0) +
    "&sortField=" + (query ? 1 : 6) + "&sortOrder=desc";     // 1 — по совпадению, 6 — по популярности
  if (ml) q += "&modLoaderType=" + ml;
  if (query) q += "&searchFilter=" + encodeURIComponent(query);
  const j = await cfRequest(q);
  if (!j || !Array.isArray(j.data)) { cfBlockedUntil = Date.now() + 10 * 60 * 1000; return { hits: [], total: 0 }; }
  return {
    hits: j.data.map((m) => cfToCard(m, mc, loader, type)),
    total: (j.pagination && j.pagination.totalCount) || j.data.length
  };
}

// подробности мода с CurseForge
async function cfProject(id) {
  const j = await cfRequest("/mods/" + encodeURIComponent(id));
  const m = j && j.data;
  if (!m) return null;
  let body = "";
  try {
    const d = await cfRequest("/mods/" + encodeURIComponent(id) + "/description");
    body = (d && d.data) || "";
  } catch (e) {}
  return {
    ok: true,
    slug: "cf:" + m.id, title: m.name, desc: m.summary || "",
    body: String(body).slice(0, 20000),
    icon: (m.logo && m.logo.url) || "",
    gallery: (m.screenshots || []).map((g) => ({ url: g.url, title: g.title || "" })).slice(0, 12),
    downloads: m.downloadCount || 0, follows: 0,
    license: "", versions: [], loaders: [],
    source: "", wiki: "", issues: "",
    page: (m.links && m.links.websiteUrl) || "",
    blocked: (m.allowModDistribution === false)
  };
}

// Карты приходят одним .zip, а игре нужна распакованная папка в saves.
// Распаковываем встроенным tar: он есть и в Windows 10+, и в macOS.
// Запасной путь через PowerShell — только для Windows.
function unzipTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!IS_WIN) {
    try {
      require("child_process").execFileSync("tar", ["-xf", file, "-C", dir], { stdio: "pipe" });
      return true;
    } catch (e) { return false; }
  }
  const tar = path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe");
  if (fs.existsSync(tar)) {
    try {
      require("child_process").execFileSync(tar, ["-xf", file, "-C", dir], { stdio: "pipe" });
      return true;
    } catch (e) { /* попробуем вторым способом */ }
  }
  try {
    require("child_process").execFileSync("powershell", ["-NoProfile", "-Command",
      "Expand-Archive -LiteralPath '" + file.replace(/'/g, "''") +
      "' -DestinationPath '" + dir.replace(/'/g, "''") + "' -Force"], { stdio: "pipe" });
    return true;
  } catch (e) { return false; }
}

// установка мода с CurseForge (только если автор это разрешил)
async function cfInstall(id, mc, loader, dir, log, type) {
  const kind = contentOf(type);
  const ml = kind.loader ? CF_LOADER[String(loader).toLowerCase()] : 0;
  let q = "/mods/" + encodeURIComponent(id) + "/files?gameVersion=" + encodeURIComponent(mc) + "&pageSize=20";
  if (ml) q += "&modLoaderType=" + ml;
  const j = await cfRequest(q);
  const file = j && Array.isArray(j.data) && j.data[0];
  if (!file) throw new Error("нет версии под " + loader + " " + mc);
  if (!file.downloadUrl) {
    throw new Error("автор мода запретил скачивание сторонними лаунчерами — открой страницу мода и скачай вручную");
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.fileName);
  const done = [];
  if (!fs.existsSync(dest)) {
    await dl(file.downloadUrl, { "User-Agent": MR_UA }, dest, file.fileName);
    done.push(file.fileName);
    if (log) log("установлен " + file.fileName);
  }
  return done;
}

// Модрих ищет и по названию, и по описанию, но требует, чтобы совпали ВСЕ слова
// запроса разом. Поэтому «мод про танки и самолёты» даёт ноль. В таком случае
// спрашиваем каждое значимое слово отдельно и оставляем моды, у которых совпало
// больше слов — неважно, в названии или в описании.
async function looseSearch(raw, mc, loader, type) {
  const words = meaningful(String(raw).toLowerCase().split(/\s+/).filter(Boolean)).slice(0, 4);
  if (words.length < 2) return { hits: [], used: [] };
  const seen = new Set(), pool = [];
  for (const w of words) {
    let r;
    try { r = await mrSearchOnline(w, mc, loader, 40, 0, type); } catch (e) { continue; }
    r.hits.forEach((h) => {
      const id = h.project_id || h.slug;
      if (seen.has(id)) return;
      seen.add(id); pool.push(h);
    });
  }
  if (!pool.length) return { hits: [], used: words };
  const scored = pool.map((h) => {
    const bag = wordsOf(h.title).concat(wordsOf(h.slug), wordsOf(h.description), h.categories || []);
    let hit = 0;
    words.forEach((w) => { if (wordHit(w, bag)) hit++; });
    return { h: h, hit: hit, dl: h.downloads || 0 };
  }).filter((x) => x.hit > 0);
  if (!scored.length) return { hits: [], used: words };
  // Оставляем только тех, у кого совпало столько же слов, сколько у лучшего.
  // Иначе в выдачу лезут моды с одним случайным словом из описания.
  const most = scored.reduce((a, x) => Math.max(a, x.hit), 0);
  const keep = scored.filter((x) => x.hit === most)
    .sort((a, b) => b.dl - a.dl)
    .map((x) => x.h);
  return { hits: keep, used: words, matched: most };
}

// Модрих требует, чтобы совпали ВСЕ слова запроса. Поэтому расшифровка из
// словаря («магия» -> «magic spell wizard») находила ровно ноль модов. Сужаем
// её по шагам: вся фраза -> без служебных слов -> только главное слово.
// prefer: какое одно слово оставить, если не нашлось ничего. У расшифровки из
// словаря главное слово первое («magic spell wizard» — это про magic), а у
// перевода фразы — последнее, как в английском («mod about trains» — про trains).
async function trySearch(q, mc, loader, prefer, type) {
  const variants = [];
  const push = (x) => { const v = String(x || "").trim(); if (v && variants.indexOf(v) < 0) variants.push(v); };
  const words = meaningful(String(q).toLowerCase().split(/\s+/).filter(Boolean));
  push(q);
  if (words.length) {
    push(words.join(" "));
    // Отбрасываем по одному слову с конца: «tank military warfare» -> «tank
    // military» -> «tank». Так дольше сохраняется смысл, чем прыгать сразу к
    // одному слову.
    for (let n = words.length - 1; n >= 2; n--) push(words.slice(0, n).join(" "));
    if (prefer === "last") { push(words[words.length - 1]); push(words[0]); }
    else { push(words[0]); push(words[words.length - 1]); }
  }
  for (const v of variants) {
    let r;
    try { r = await mrSearchOnline(v, mc, loader, PAGE_DEFAULT, 0, type); } catch (e) { continue; }
    if (r.hits.length) return { hits: r.hits, total: r.total, used: v };
  }
  return { hits: [], total: 0, used: String(q || "") };
}

// Синонимы для английских запросов. Игрок пишет «gun», а мод называется
// «firearms»; пишет «map» — а нужен «minimap». Подключаются, только когда по
// самому запросу нашлось мало: точное слово всегда важнее синонима.
const EN_SYN = {
  gun: "weapon firearm shooting", guns: "weapon firearm shooting",
  weapon: "gun sword combat", weapons: "gun sword combat",
  sword: "weapon blade combat", armor: "equipment gear armour", armour: "armor equipment gear",
  car: "vehicle transport driving", cars: "vehicle transport driving",
  vehicle: "car transport", plane: "aircraft flight airplane", planes: "aircraft flight airplane",
  train: "railway rail transport", trains: "railway rail transport",
  tank: "military vehicle warfare",
  magic: "spell wizard arcane", spell: "magic wizard", wizard: "magic spell",
  storage: "chest inventory backpack", chest: "storage inventory",
  backpack: "bag storage inventory", bag: "backpack storage",
  map: "minimap waypoint atlas", minimap: "map waypoint",
  teleport: "waypoint warp portal", portal: "dimension teleport",
  food: "cooking farming crops", cooking: "food kitchen", farm: "farming agriculture crops",
  pet: "tameable companion animal", pets: "tameable companion animal",
  mob: "creature entity monster", mobs: "creature entity monster",
  boss: "bosses combat dungeon", dungeon: "structure adventure loot",
  furniture: "decoration decor", decoration: "furniture decor",
  tech: "technology machinery industrial", machine: "machinery tech automation",
  fps: "performance optimization", lag: "performance optimization",
  performance: "optimization fps", optimization: "performance fps",
  shader: "shaders lighting", light: "lighting lights", lighting: "light lights",
  village: "villager villages trading", villager: "village trading",
  horse: "mount riding animal", fly: "flight wings elytra", flight: "fly wings elytra",
  quest: "quests adventure", skill: "skills leveling rpg", rpg: "adventure leveling skills",
  sound: "sounds audio music", music: "sound audio",
  ore: "ores mining", mining: "ore miner digging",
  building: "construction blocks decoration", block: "blocks building",
  inventory: "storage sorting", sorting: "inventory storage"
};
// «gun» -> «gun weapon firearm shooting». Пусто, если синонимов не нашлось.
function enSynonyms(q) {
  const words = meaningful(String(q || "").toLowerCase().split(/\s+/).filter(Boolean));
  if (!words.length || words.length > 2) return "";
  const out = [];
  words.forEach((w) => {
    if (out.indexOf(w) < 0) out.push(w);
    const syn = EN_SYN[w];
    if (syn) syn.split(/\s+/).forEach((x) => { if (out.indexOf(x) < 0) out.push(x); });
  });
  return (out.length > words.length) ? out.slice(0, 4).join(" ") : "";
}

// Расшифровка из словаря — это СИНОНИМЫ («магия» = magic, spell, wizard), а не
// фраза. Искать их разом нельзя: Модрих требует совпадения всех слов сразу, и
// находятся только редкие дополнения, где случайно есть все три. Поэтому
// спрашиваем каждое слово отдельно и складываем: наверх идут моды, попавшие в
// больше слов, а среди равных — те, что скачали чаще.
async function orSearch(q, mc, loader, type) {
  const words = meaningful(String(q).toLowerCase().split(/\s+/).filter(Boolean)).slice(0, 4);
  if (words.length < 2) return { hits: [], total: 0, used: String(q || "") };
  const seen = new Set(), pool = [];
  for (const w of words) {
    let r;
    try { r = await mrSearchOnline(w, mc, loader, 40, 0, type); } catch (e) { continue; }
    r.hits.forEach((h) => {
      const id = h.project_id || h.slug;
      if (seen.has(id)) return;
      seen.add(id); pool.push(h);
    });
  }
  if (!pool.length) return { hits: [], total: 0, used: String(q || "") };
  const ranked = pool.map((h) => {
    const bag = wordsOf(h.title).concat(wordsOf(h.slug), wordsOf(h.description), h.categories || []);
    let hit = 0;
    words.forEach((w) => { if (wordHit(w, bag)) hit++; });
    return { h: h, hit: hit, dl: h.downloads || 0 };
  }).sort((a, b) => (b.hit - a.hit) || (b.dl - a.dl));
  return { hits: ranked.map((x) => x.h), total: ranked.length, used: words.join(" ") };
}

// ---------- поиск по всему каталогу ----------
// Основной поиск делает сам Modrinth: он видит ВСЕ моды, а не только те, что у нас
// в списке. Наш слой нужен для другого — исправить опечатку и перевести русский
// запрос, потому что родной поиск понимает только точные английские слова.
// ===== ВИДЫ СОДЕРЖИМОГО =====
// Каталог умеет не только моды. У каждого вида своя папка в сборке, свой раздел
// на Модрихе и свой номер раздела на CurseForge. Загрузчик (Forge/Fabric) важен
// только модам и сборкам модов: ресурспаку или карте всё равно, на чём игра.
const CONTENT = {
  mod:          { mr: "mod",          cf: 6,    dir: "mods",          loader: true  },
  modpack:      { mr: "modpack",      cf: 4471, dir: "",              loader: true  },
  resourcepack: { mr: "resourcepack", cf: 12,   dir: "resourcepacks", loader: false },
  shader:       { mr: "shader",       cf: 6552, dir: "shaderpacks",   loader: false },
  datapack:     { mr: "datapack",     cf: 6945, dir: "datapacks",     loader: false },
  // карт на Модрихе нет как раздела — они только на CurseForge, и их надо распаковывать
  world:        { mr: "",             cf: 17,   dir: "saves",         loader: false, unzip: true }
};
function contentOf(type) { return CONTENT[String(type || "mod")] || CONTENT.mod; }

async function mrSearchOnline(query, mc, loader, limit, offset, type) {
  const kind = contentOf(type);
  if (!kind.mr) return { hits: [], total: 0 };          // такого раздела у Модриха нет
  const f = [["versions:" + mc], ["project_type:" + kind.mr]];
  if (kind.loader) f.push(["categories:" + loader]);
  const facets = encodeURIComponent(JSON.stringify(f));
  const url = MR_API + "/search?query=" + encodeURIComponent(query) + "&facets=" + facets +
    "&limit=" + (limit || 30) + "&offset=" + (offset || 0) + "&index=relevance";
  let r;
  try { r = await fetchRetry(url, { headers: { "User-Agent": MR_UA } }, 2); } catch (e) { return { hits: [], total: 0 }; }
  if (!r || !r.ok) return { hits: [], total: 0 };
  let j = null;
  try { j = await r.json(); } catch (e) { return { hits: [], total: 0 }; }
  return { hits: (j && j.hits) || [], total: (j && j.total_hits) || 0 };
}

// самые популярные — для пустого запроса
async function mrPopular(mc, loader, limit, offset, type) {
  const kind = contentOf(type);
  if (!kind.mr) return { hits: [], total: 0 };
  const f = [["versions:" + mc], ["project_type:" + kind.mr]];
  if (kind.loader) f.push(["categories:" + loader]);
  const facets = encodeURIComponent(JSON.stringify(f));
  const url = MR_API + "/search?facets=" + facets + "&limit=" + (limit || 30) +
    "&offset=" + (offset || 0) + "&index=downloads";
  let r;
  try { r = await fetchRetry(url, { headers: { "User-Agent": MR_UA } }, 2); } catch (e) { return { hits: [], total: 0 }; }
  if (!r || !r.ok) return { hits: [], total: 0 };
  let j = null;
  try { j = await r.json(); } catch (e) { return { hits: [], total: 0 }; }
  return { hits: (j && j.hits) || [], total: (j && j.total_hits) || 0 };
}

// номер версии мода одним запросом на всю страницу, а не по одному на каждый
async function fillVersionNumbers(hits) {
  const ids = hits.map((h) => h.latest_version).filter(Boolean);
  if (!ids.length) return;
  try {
    const url = MR_API + "/versions?ids=" + encodeURIComponent(JSON.stringify(ids));
    const r = await fetchRetry(url, { headers: { "User-Agent": MR_UA } }, 2);
    if (!r || !r.ok) return;
    const list = await r.json();
    const by = {};
    (list || []).forEach((v) => { if (v && v.id) by[v.id] = v.version_number; });
    hits.forEach((h) => { if (by[h.latest_version]) h.ver = by[h.latest_version]; });
  } catch (e) { /* без номера версии тоже проживём */ }
}

function hitToCard(h) {
  return {
    s: h.slug, t: h.title, d: String(h.description || "").slice(0, 200),
    a: h.author || "", i: h.icon_url || "", dl: h.downloads || 0,
    c: (h.categories || []).join(" "),
    ver: h.ver || "", mcv: (h.versions || []).slice(-4).join(", "),
    src: "modrinth"
  };
}

// Каталог отдаётся страницами: интерфейс подгружает следующую, когда игрок
// долистал до низа. Так до него доезжает вся библиотека Modrinth — а это десятки
// тысяч модов на каждую связку версии и загрузчика.
const PAGE_DEFAULT = 30;

ipcMain.handle("catalog-search", async (e, q, mc, loader, offset, exact, limit, type) => {
  try {
    const m = String(mc || "1.20.1"), l = String(loader || "forge");
    // Моды, сборки, ресурспаки, шейдеры, карты, датапаки — поиск один и тот же,
    // меняются только раздел каталога и папка установки.
    const kind = contentOf(type);
    const T = String(type || "mod");
    const raw = String(q || "").trim();
    const off = Math.max(0, parseInt(offset, 10) || 0);
    // Сколько карточек отдать за раз. Интерфейс просит немного: первая страница
    // маленькая, дальше вообще по несколько штук — чтобы слабый ноутбук не
    // задыхался, разбирая тысячи модов сразу.
    const PAGE = Math.max(3, Math.min(60, parseInt(limit, 10) || PAGE_DEFAULT));

    // Второй источник подмешиваем к каждой странице: половина мест Modrinth,
    // половина CurseForge. Без ключа CurseForge просто молчит, и всё как раньше.
    const withCf = !!cfKey();
    // Карт у Модриха нет вовсе. Раньше половина страницы всё равно резервировалась
    // под него, и вместо пятнадцати карт приходило семь, а листалка думала, что
    // страница неполная, и останавливалась. Теперь, если раздела у Модриха нет,
    // всю страницу отдаём CurseForge.
    const mrHas = !!kind.mr;
    const mrLimit = mrHas ? (withCf ? Math.ceil(PAGE / 2) : PAGE) : 0;
    const cfLimit = PAGE - mrLimit;
    let cfTotal = 0;

    async function cfPart(query, offset) {
      if (!withCf || cfLimit <= 0) return [];
      try {
        const r = await cfSearch(query, m, l, cfLimit, mrLimit ? Math.floor(offset / 2) : offset, T);
        cfTotal = Math.max(cfTotal, r.total || 0);
        return r.hits;
      } catch (e) { return []; }
    }
    // сколько всего есть: если раздел только у CurseForge — берём его счёт
    const totalOf = (mrTotal) => mrHas ? (mrTotal || 0) : cfTotal;

    // пустой запрос — вся библиотека по популярности, страницами
    if (!raw) {
      const res = await mrPopular(m, l, mrLimit, withCf ? Math.floor(off / 2) : off, T);
      await fillVersionNumbers(res.hits);
      const cf = await cfPart("", off);
      return {
        ok: true,
        mods: res.hits.map(hitToCard).concat(cf),
        total: totalOf(res.total),
        effective: "", offset: off
      };
    }

    // подгрузка следующей страницы: ищем ровно то, что уже сработало, без исправлений
    if (exact) {
      const res = await mrSearchOnline(raw, m, l, mrLimit, withCf ? Math.floor(off / 2) : off, T);
      await fillVersionNumbers(res.hits);
      const cf = await cfPart(raw, off);
      let page = res.hits.map(hitToCard).concat(cf);
      if (raw && page.length > 1) {
        page = page
          .map((m, i) => ({ m: m, i: i, sc: scoreItem(raw, m) }))
          .sort((x, y) => (y.sc - x.sc) || (x.i - y.i))
          .map((x) => x.m);
      }
      return { ok: true, mods: page, total: totalOf(res.total), effective: raw, offset: off };
    }

    // Первая страница. Сначала спрашиваем Modrinth ровно то, что ввёл человек.
    // Исправления и перевод подключаем ТОЛЬКО если прямой поиск ничего не дал.
    let effective = raw, corrected = "";

    // Если весь запрос — известное сокращение или русское имя мода («ae2», «крейт»,
    // «лаки»), сразу ищем по расшифровке. Иначе выходит нелепо: по «ae2» находились
    // десятки дополнений к нему, а сам мод в выдачу не попадал.
    let alias = ruLookup(String(raw).toLowerCase().trim());
    if (!alias && hasCyr(raw)) {
      // «убрать лаги»: целой строки в словаре нет, а слово «лаги» есть
      const ws = meaningful(String(raw).toLowerCase().split(/\s+/).filter(Boolean));
      for (const w of ws) { const t = ruLookup(w); if (t) { alias = t; break; } }
    }
    const rankBy = alias || raw;

    let res = await mrSearchOnline(raw, m, l, PAGE, 0, T);
    let rankBy2 = "";
    if (alias) {
      let byAlias = await orSearch(alias, m, l, T);           // синонимы — через «или»
      if (!byAlias.hits.length) byAlias = await trySearch(alias, m, l, "", T);
      if (byAlias.hits.length) {
        res = { hits: byAlias.hits.slice(0, PAGE), total: byAlias.total };
        effective = byAlias.used; rankBy2 = byAlias.used;
      }
    }

    // Пока по запросу хоть что-то находится, ничего не подменяем. Раньше при
    // выдаче меньше восьми лаунчер лез в свой список названий и заменял
    // «all in one 9» на «Waystones» — теперь так не будет.
    // Русские буквы в названии мода — это чаще всего просто запись латиницей,
    // а не перевод: «джеи» = jei, «крафттвикер» = crafttweaker. Поэтому сначала
    // читаем запрос латиницей и только потом переводим по смыслу. Иначе «джеи»
    // переводится как «jay», что-то находится, и настоящий JEI до выдачи не едет.
    let ruText = "";
    if (!alias && res.hits.length < 3 && hasCyr(raw)) {
      const said = [];
      [translit(raw), splitConcat(translit(raw))].forEach((v) => {
        const x = String(v || "").trim();
        if (x && x !== raw && said.indexOf(x) < 0) said.push(x);
      });
      for (const v of said) {
        let alt;
        try { alt = await mrSearchOnline(v, m, l, PAGE, 0, T); } catch (e) { continue; }
        if (alt.hits.length > res.hits.length) { res = alt; effective = v; rankBy2 = v; break; }
      }
    }

    // Русский запрос без словаря («магия», «рюкзак», «мод про поезда») просто
    // переводим и ищем по-английски — тогда работает и поиск по описанию.
    if (!alias && res.hits.length < 3 && hasCyr(raw)) {
      ruText = await translateQuery(raw);
      if (ruText) {
        const byRu = await trySearch(ruText, m, l, "", T);
        if (byRu.hits.length > res.hits.length) { res = byRu; effective = byRu.used; ruText = byRu.used; }
      }
    }

    // Синонимы. «gun» найдёт и firearms, «map» — и minimap. Включаем, только
    // когда по самому запросу нашлось мало: точное слово всегда важнее синонима.
    let synText = "";
    if (res.hits.length < 5) {
      const syn = enSynonyms(rankBy2 || ruText || alias || raw);
      if (syn) {
        const bySyn = await orSearch(syn, m, l, T);
        if (bySyn.hits.length > res.hits.length) {
          res = { hits: bySyn.hits.slice(0, PAGE), total: bySyn.total };
          synText = syn;
          if (effective === raw) effective = syn;
        }
      }
    }

    // Сначала честная попытка: те же слова, но по отдельности (и по описанию тоже).
    let loose = null;
    if (res.hits.length < 3) {
      loose = await looseSearch(ruText || raw, m, l, T);
      if (loose.hits.length) {
        res = { hits: loose.hits.slice(0, PAGE), total: loose.hits.length };
        if (ruText) effective = ruText;
      }
    }

    // «luckyblock» находит три случайных мода, а нужный — нет. Поэтому разделённый
    // вариант пробуем не только при пустой выдаче, но и когда её мало.
    if (res.hits.length < 3) {
      const tries = [];
      const push = (x) => {
        const v = String(x || "").trim();
        if (v && v.toLowerCase() !== raw.toLowerCase() && tries.indexOf(v) < 0) tries.push(v);
      };
      try {
        // Список для исправления опечаток собран из МОДОВ, для карт и шейдеров
        // он бесполезен и только увёл бы в сторону.
        const idx = (kind === CONTENT.mod) ? modIndexCached(m, l) : null;
        if (idx) {
          // Ищем подсказку и по тому, как написали, и по латинице: «джорнимап»
          // сам по себе не находится, а «jornimap» узнаётся как JourneyMap.
          let near = searchIndex(idx, raw, 2);
          if (hasCyr(raw)) {
            const alt = searchIndex(idx, translit(raw), 2);
            if (alt.length && (!near.length || alt[0].score > near[0].score)) near = alt;
          }
          if (near.length) {
            const lead = near[0].score - (near[1] ? near[1].score : 0);
            // 78 — уверенное сходство названий. Если же по запросу не нашлось
            // РОВНО НИЧЕГО, принимаем и слабую подсказку — но только когда она
            // заметно обходит вторую. Раньше пять модов имели одинаковый балл,
            // и «all in one 9» превращалось в случайный из них.
            const trust = (near[0].score >= 78) ||
                          (!res.hits.length && near[0].score >= 55 && lead >= 5);
            if (trust) { corrected = near[0].t; push(corrected); }
          }
        } else if (kind === CONTENT.mod) { modIndex(m, l).catch(() => {}); }
      } catch (err) {}
      if (hasCyr(raw)) push(translit(raw));            // «джеи» -> jei
      push(splitConcat(raw));                          // «luckyblock» -> «lucky block»
      if (hasCyr(raw)) push(splitConcat(translit(raw)));
      const wide = expandQuery(raw);                   // «танк» -> tank military warfare
      if (wide && wide !== raw.toLowerCase()) push(wide.replace(raw.toLowerCase(), "").trim());

      for (const t of tries.slice(0, 5)) {
        const alt = await mrSearchOnline(t, m, l, PAGE, 0, T);
        if (alt.hits.length > res.hits.length) { res = alt; effective = t; }
        if (res.hits.length >= 10) break;
      }
      if (!res.hits.length) corrected = "";
      else if (effective === raw) corrected = "";
    }

    await fillVersionNumbers(res.hits);
    let mods = res.hits.map(hitToCard);

    // Второй источник спрашиваем ИСХОДНЫМ запросом, а не исправленным: исправление
    // подбирается по списку Modrinth и для CurseForge может увести не туда. Так,
    // «leaning or not» исправлялось во что-то другое, и нужный мод до выдачи не доезжал.
    // Если по исходному запросу пусто — только тогда пробуем исправленный.
    if (withCf) {
      let cf = await cfPart(alias || raw, 0);
      // Если по исходному запросу нашлось мало, добираем по уточнённому варианту:
      // «luckyblock» сам по себе даёт мусор, а «lucky block» — нужный мод.
      if (cf.length < 8 && ruText) {
        const byRu = await cfPart(ruText, 0);
        const seenRu = {};
        cf.forEach((x) => { seenRu[x.s] = 1; });
        byRu.forEach((x) => { if (!seenRu[x.s]) { seenRu[x.s] = 1; cf.push(x); } });
      }
      if (cf.length < 8 && effective && effective !== raw) {
        const more = await cfPart(effective, 0);
        const seenCf = {};
        cf.forEach((x) => { seenCf[x.s] = 1; });
        more.forEach((x) => { if (!seenCf[x.s]) { seenCf[x.s] = 1; cf.push(x); } });
      }
      mods = mods.concat(cf);
      if (!res.hits.length && cf.length) corrected = corrected || "";
    }

    // Склеивать «сначала весь Modrinth, потом весь CurseForge» — плохо: по запросу
    // «leaning or not» наверху оказывался YetAnotherConfigLib, а нужный мод уезжал
    // вниз просто потому, что он из второго источника. Поэтому пересобираем страницу
    // по близости к запросу, тем же мерилом, что и поиск по опечаткам.
    // Главное слово запроса считаем отдельно. Расшифровка «миникарта» -> «minimap
    // map» тянула наверх длинные дополнения, где есть оба слова, а сам Xaero's
    // Minimap оказывался внизу. По слову «minimap» он выходит первым — как надо.
    const mainWord = (function () {
      const w = meaningful(String(rankBy2 || ruText || rankBy || raw).toLowerCase().split(/\s+/).filter(Boolean));
      // Короткое общее слово главным не считаем: по «all» одинаково подходит
      // пол-каталога, и порядок начинает решать случай.
      return (w.length > 1 && w[0].length >= 4) ? w[0] : "";
    })();
    if (raw && mods.length > 1) {
      mods = mods
        .map((m, i) => ({ m: m, i: i, sc: Math.max(scoreItem(raw, m), scoreItem(rankBy, m),
                                                   rankBy2 ? scoreItem(rankBy2, m) : 0,
                                                   mainWord ? scoreItem(mainWord, m) : 0,
                                                   synText ? scoreItem(synText, m) : 0,
                                                   ruText ? scoreItem(ruText, m) : 0) }))
        // Балл округляем: у одинаково подходящих модов он различался сотыми, и
        // наверх попадал случайный. При равном совпадении первым идёт тот, кого
        // скачали больше — обычно это и есть тот самый, всем известный мод.
        .map((x) => ({ m: x.m, i: x.i, sc: Math.round(x.sc) }))
        .sort((x, y) => (y.sc - x.sc) || ((y.m.dl || 0) - (x.m.dl || 0)) || (x.i - y.i))
        .map((x) => x.m);
    }

    return {
      ok: true,
      mods: mods.slice(0, PAGE),
      total: totalOf(res.total),
      effective: effective,
      corrected: corrected,
      // по каким словам пришлось искать по отдельности — интерфейс так и скажет
      loose: (loose && loose.hits.length) ? loose.used : null,
      offset: 0
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// подробности мода: полное описание, картинки, ссылки
ipcMain.handle("catalog-project", async (e, slug) => {
  try {
    const id = String(slug);
    if (id.indexOf("cf:") === 0) {
      const cf = await cfProject(id.slice(3));
      return cf || { ok: false, error: "мод не найден" };
    }
    const r = await fetchRetry(MR_API + "/project/" + encodeURIComponent(id),
      { headers: { "User-Agent": MR_UA } }, 2);
    if (!r || !r.ok) return { ok: false, error: "мод не найден" };
    const j = await r.json();
    return {
      ok: true,
      slug: j.slug, title: j.title, desc: j.description,
      body: String(j.body || "").slice(0, 20000),
      icon: j.icon_url || "",
      gallery: (j.gallery || []).map((g) => ({ url: g.url, title: g.title || "" })).slice(0, 12),
      downloads: j.downloads || 0, follows: j.followers || 0,
      license: (j.license && (j.license.name || j.license.id)) || "",
      versions: (j.game_versions || []).slice(-12),
      loaders: j.loaders || [],
      source: j.source_url || "", wiki: j.wiki_url || "", issues: j.issues_url || "",
      page: "https://modrinth.com/mod/" + j.slug
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// Кому сообщать о ходе скачивания. Ставится на время установки из каталога,
// чтобы игрок видел проценты и понимал, что ничего не зависло.
let dlWatch = null;
async function dl(url, headers, dest, label) {
  let done = 0, last = 0;
  await downloadToFile(url, headers, dest, function (n, total) {
    done += n;
    if (!dlWatch) return;
    const now = Date.now();
    if (now - last < 120 && total && done < total) return;   // не чаще, чем раз в 120 мс
    last = now;
    dlWatch(label, done, total);
  });
  if (dlWatch && label) dlWatch(label, 1, 1);
}

// Один файл проекта Модриха: ресурспак, шейдер, датапак. У модов своя установка
// с зависимостями, здесь проще — берём главный файл версии и кладём куда надо.
async function mrFile(slug, mc, loader, kind) {
  const vers = await mrVersions(slug, mc, kind.loader ? loader : "");
  if (!vers || !vers.length) throw new Error("нет версии под " + mc);
  const v = vers[0];
  const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0];
  if (!f) throw new Error("у версии нет файла");
  return { url: f.url, name: f.filename, sha1: (f.hashes && f.hashes.sha1) || "" };
}
// то же самое с CurseForge
async function cfFile(id, mc, loader, kind) {
  const ml = kind.loader ? CF_LOADER[String(loader).toLowerCase()] : 0;
  let q = "/mods/" + encodeURIComponent(id) + "/files?gameVersion=" + encodeURIComponent(mc) + "&pageSize=20";
  if (ml) q += "&modLoaderType=" + ml;
  const j = await cfRequest(q);
  const f = j && Array.isArray(j.data) && j.data[0];
  if (!f) throw new Error("нет версии под " + mc);
  if (!f.downloadUrl) throw new Error("автор запретил скачивание сторонними лаунчерами — открой страницу и скачай вручную");
  return { url: f.downloadUrl, name: f.fileName, sha1: "" };
}

// Ставим ресурспак, шейдер, датапак или карту. Карта приходит архивом и
// распаковывается папкой мира в saves, остальное кладётся файлом как есть.
async function installSimple(slug, mc, loader, dir, kind, log) {
  const id = String(slug);
  const f = (id.indexOf("cf:") === 0)
    ? await cfFile(id.slice(3), mc, loader, kind)
    : await mrFile(id, mc, loader, kind);
  fs.mkdirSync(dir, { recursive: true });

  if (kind.unzip) {
    const safe = String(f.name).replace(/[^\w.\-]+/g, "_");
    const tmp = path.join(app.getPath("temp"), "jv-" + Date.now() + "-" + safe);
    await dl(f.url, { "User-Agent": MR_UA }, tmp, f.name);
    const before = new Set(fs.readdirSync(dir));
    const okZip = unzipTo(tmp, dir);
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (!okZip) throw new Error("не удалось распаковать архив карты");
    const added = fs.readdirSync(dir).filter((x) => !before.has(x));
    if (log) log("распакована карта: " + (added.join(", ") || f.name));
    return added.length ? added : [f.name];
  }

  const dest = path.join(dir, f.name);
  if (fs.existsSync(dest)) return [];
  await dl(f.url, { "User-Agent": MR_UA }, dest, f.name);
  if (f.sha1 && sha1File(dest) !== f.sha1) {
    try { fs.unlinkSync(dest); } catch (e) {}
    throw new Error("файл скачался повреждённым: " + f.name);
  }
  if (log) log("установлен " + f.name);
  return [f.name];
}

// копирование папки целиком — нужно для готовых настроек из сборки
function copyTree(from, to) {
  for (const nm of fs.readdirSync(from)) {
    const a = path.join(from, nm), b = path.join(to, nm);
    let st; try { st = fs.statSync(a); } catch (e) { continue; }
    if (st.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b); }
    else { try { fs.copyFileSync(a, b); } catch (e) {} }
  }
}

// Готовая сборка модов (.mrpack с Модриха). Внутри список файлов со ссылками и
// папка overrides с настройками. Ставим в НОВУЮ сборку игрока, чтобы ничего не
// перемешалось с уже собранным.
async function installModpack(slug, mc, loader, wantName, log) {
  const id = String(slug);
  if (id.indexOf("cf:") === 0) {
    throw new Error("сборки с CurseForge лаунчер пока не собирает — открой страницу мода и скачай вручную");
  }
  const f = await mrFile(id, mc, loader, contentOf("modpack"));
  const tmpDir = path.join(app.getPath("temp"), "jv-mrpack-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const zip = path.join(tmpDir, "pack.mrpack");
  if (log) log("скачиваю сборку " + f.name + "…");
  await dl(f.url, { "User-Agent": MR_UA }, zip, f.name);
  if (!unzipTo(zip, tmpDir)) throw new Error("не удалось распаковать сборку");

  let idx;
  try { idx = JSON.parse(fs.readFileSync(path.join(tmpDir, "modrinth.index.json"), "utf-8")); }
  catch (e) { throw new Error("в сборке нет описания modrinth.index.json"); }

  const dep = idx.dependencies || {};
  const packMc = dep.minecraft || mc;
  let packLoader = "forge";
  if (dep["fabric-loader"]) packLoader = "fabric";
  else if (dep["quilt-loader"]) packLoader = "quilt";
  else if (dep["neoforge"]) packLoader = "neoforge";

  const list = readPacks();
  let nm = String(wantName || idx.name || "Сборка").trim().slice(0, 40) || "Сборка";
  let n = 2;
  while (list.some((x) => String(x.name).toLowerCase() === nm.toLowerCase())) { nm = nm.replace(/ \d+$/, "") + " " + n; n++; }
  const pack = {
    id: packId(nm, list.map((x) => x.id)), name: nm,
    mc: packMc, loader: packLoader, forge: "", ram: null,
    created: new Date().toISOString()
  };
  list.push(pack); writePacks(list);
  const root = packDir(pack.id);
  fs.mkdirSync(root, { recursive: true });
  try { seedFromPlayer(root, packMc, packLoader); } catch (e) {}

  const files = (idx.files || []).filter((x) => x && x.path && (x.downloads || []).length);
  let done = 0;
  for (const it of files) {
    const rel = String(it.path).replace(/\\/g, "/");
    if (rel.indexOf("..") >= 0 || rel.indexOf(":") >= 0) continue;   // чужие пути не трогаем
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      try { await dl(it.downloads[0], { "User-Agent": MR_UA }, dest, rel.split("/").pop()); }
      catch (e) { if (log) log("не встал файл " + rel); continue; }
    }
    done++;
    if (dlWatch) dlWatch("", done, files.length, "файлы сборки: " + done + " из " + files.length);
    if (log && done % 10 === 0) log("скачано файлов: " + done + " из " + files.length);
  }

  for (const o of ["overrides", "client-overrides"]) {
    const p = path.join(tmpDir, o);
    if (fs.existsSync(p)) copyTree(p, root);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  if (log) log("сборка «" + nm + "» готова: файлов " + done);
  return { pack: pack, files: done };
}

ipcMain.handle("catalog-install", async (e, slug, mc, loader, packIdArg, type) => {
  try {
    const m = String(mc || "1.20.1"), l = String(loader || "forge");
    const kind = contentOf(type);
    const log = (msg) => sendUI("catalog-log", msg);
    const id = String(slug);
    // показываем проценты: без них непонятно, качается ли ещё или уже зависло
    dlWatch = function (label, done, total, note) {
      sendUI("catalog-progress", {
        slug: id, name: label || "",
        pct: total ? Math.min(100, Math.round(done / total * 100)) : -1,
        note: note || ""
      });
    };

    // Готовая сборка модов — особый случай: она сама становится новой сборкой.
    if (kind === CONTENT.modpack) {
      const res = await installModpack(id, m, l, "", log);
      dlWatch = null;
      return { ok: true, added: ["сборка"], modpack: res.pack, files: res.files,
               pack: res.pack.name, mods: [] };
    }

    // Куда класть: в выбранную сборку или, как раньше, в режим игрока.
    const pk = packIdArg ? findPack(packIdArg) : null;
    const base = pk ? packDir(pk.id) : playerDir(m, l);
    const dir = path.join(base, kind.dir || "mods");

    const added = (kind === CONTENT.mod)
      ? ((id.indexOf("cf:") === 0)
          ? await cfInstall(id.slice(3), m, l, dir, log, type)
          : await installMod(id, m, l, dir, null, 0, log))
      : await installSimple(id, m, l, dir, kind, log);

    dlWatch = null;
    return { ok: true, added: added, mods: listJars(path.join(base, "mods")),
             pack: pk ? pk.name : "", where: kind.dir || "mods" };
  } catch (err) {
    dlWatch = null;
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("catalog-refresh", async (e, mc, loader) => {
  try {
    const m = String(mc || "1.20.1"), l = String(loader || "forge");
    try { fs.unlinkSync(modIndexFile(m, l)); } catch (err) {}
    const idx = await modIndex(m, l, (n) => sendUI("catalog-log", "загружено модов: " + n));
    return { ok: true, total: (idx || []).length };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// ===== ЗАПУСК игры =====
// ОДНА подготовка за раз. Раньше можно было нажать «Играть» второй раз, пока
// качалась первая версия: тогда шли ДВА скачивания сразу, и первой открывалась
// та, что уже была на диске (например 1.20.1 вместо выбранной 1.19.2).
let launching = null;   // { gen, id, title } — что готовится прямо сейчас

ipcMain.handle("launch", async (event, override) => {
  if (!authToken) throw new Error("Сначала войдите через Ely.by");

  // ВЫБОР ИГРОКА — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ.
  // Раньше версия бралась из config.json, если интерфейс её не прислал, и тогда
  // вместо выбранной сборки запускалась серверная 1.20.1. Больше так нельзя:
  // нет версии от интерфейса — нет запуска.
  const sel = override || {};
  if (!sel.version) throw new Error("Версия не выбрана. Нажми на бирку версии справа и выбери сборку.");
  // у своей сборки собственная метка: две разные сборки под одну версию — не одно и то же
  const wantId = sel.packId
    ? ("pack-" + sel.packId)
    : instanceId(sel.version, sel.loader || "vanilla");
  if (launching) {
    // уже что-то готовится — второй запуск не начинаем
    return {
      ok: false, busy: true, sameBuild: launching.id === wantId,
      title: launching.title,
      message: launching.id === wantId
        ? ("Эта сборка уже готовится: " + launching.title)
        : ("Сейчас качается " + launching.title + ". Дождись или нажми «Отмена».")
    };
  }

  const myGen = ++launchGen;
  const _pk = sel.packId ? findPack(sel.packId) : null;
  launching = {
    gen: myGen, id: wantId,
    title: _pk ? ("сборка «" + _pk.name + "» (" + _pk.loader + " " + _pk.mc + ")")
               : ((sel.loader || "Vanilla") + " " + sel.version)
  };
  const doneLaunching = () => { if (launching && launching.gen === myGen) launching = null; };
  if (activeProc) { try { activeProc.kill(); } catch (e) {} activeProc = null; }

  const cfg = Object.assign(loadConfig(), sel);
  // выбор игрока перебивает config.json — всегда, без исключений
  cfg.version = sel.version;
  cfg.loader = sel.loader || "Vanilla";
  // серверная сборка (моды + автоподключение) только если интерфейс сказал явно
  const isServer = (sel.server === true) || (sel.server === undefined && sel.vanilla === false);
  // РЕЖИМ ИГРОКА: серверная версия, но своя папка, свои моды, БЕЗ подключения к серверу
  const playerMode = !!sel.playerMode && isServer;
  // Своя сборка — всегда одиночная игра: серверные моды туда не лезут и не сверяются
  const vanilla = !isServer || playerMode || !!sel.packId;
  const root = path.join(app.getPath("appData"), ".javelinmc");

  // у каждой сборки своя игровая папка. Режим игрока — отдельная папка "-player",
  // поэтому серверные моды и моды игрока не мешают друг другу (заморожены).
  // Своя сборка игрока: у неё собственная папка, версия, загрузчик и память.
  const myPack = sel.packId ? findPack(sel.packId) : null;
  if (myPack) {
    cfg.version = myPack.mc;
    cfg.loader = myPack.loader;
    if (myPack.forge) cfg.forgeBuild = myPack.forge;   // пустое — рекомендованная
    if (myPack.ram) cfg.ram = myPack.ram;      // null — берём из настроек лаунчера
  }

  let gameDir = myPack ? packDir(myPack.id) : instanceDir(root, cfg.version, cfg.loader);
  if (!myPack && playerMode) gameDir += "-player";
  if (isServer && !playerMode && migrateLegacy(root, gameDir) && win) {
    sendUI("mc-log", "[javelin] сохранения и моды перенесены в папку сборки: " + gameDir);
  }
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(path.join(gameDir, "mods"), { recursive: true });
  // Режим игрока начинается со своих настроек, а не с серверных
  if (!myPack && playerMode) {
    try { freezeServerConfig(root, cfg.version, cfg.loader, function (s) { writeLogLater2 = s; }); } catch (e) {}
  }
  // Своя сборка, в которую ещё ни разу не заходили: отдаём ей настройки и список
  // серверов из обжитой папки, иначе игра открывается будто впервые установленная.
  if (myPack) { try { seedFromPlayer(gameDir, cfg.version, cfg.loader); } catch (e) {} }
  cleanupLegacyPacks(root, gameDir);   // остатки прежней схемы с паками

  // синхронизируем моды с сервером ТОЛЬКО в режиме сервера (не в режиме игрока)
  if (isServer && !playerMode) {
    try {
      if (cfg.githubOwner && cfg.githubRepo && cfg.githubTag) {
        await syncMods(cfg, gameDir);
        // папки сборки (tacz, config и т.п.) — едут вместе с модами
        await syncExtras(cfg, gameDir, function (msg, pct) {
          if (win) sendUI("mc-modprogress", { msg: msg, pct: pct == null ? -1 : pct });
        });
      }
    } catch (e) {
      if (win) sendUI("mc-modprogress", { msg: "Ошибка модов: " + e.message, pct: -1, error: true });
      doneLaunching();
      throw new Error("Не удалось скачать моды: " + e.message);
    }
  }

  // папка с вложенными файлами (authlib, Java): в собранном .exe это resources, в dev — папка проекта
  const RES = app.isPackaged ? process.resourcesPath : __dirname;

  // authlib-injector — обязателен для входа через Ely.by
  let agentPath = cfg.authlibInjector || "authlib-injector.jar";
  if (!path.isAbsolute(agentPath)) agentPath = path.join(RES, agentPath);
  if (!fs.existsSync(agentPath)) {
    doneLaunching();
    throw new Error("Не найден authlib-injector.jar. Положи его в папку лаунчера (см. инструкцию).");
  }

  const opts = {
    authorization: authToken,
    root: root,                                   // общее: versions, libraries, assets
    // cwd обязателен: моды с контент-паками (Point Blank и др.) распаковывают
    // свои паки в папку рядом с рабочей директорией. Без cwd Java стартовала в root,
    // паки падали мимо gameDir и не регистрировались -> рассинхрон реестра с сервером.
    overrides: { gameDirectory: gameDir, cwd: gameDir },  // своё у каждой сборки: mods, saves, config
    version: { number: cfg.version, type: cfg.type || "release" },
    // ВАЖНО: начальный объём считается от выбранного игроком и никогда его не превышает,
    // иначе Java отказывается стартовать (это и ломало запуск на слабых ПК).
    memory: { max: ramMb(cfg.ram || 7) + "M", min: javaXmsMb(cfg.ram || 7) + "M" },
    // Раннее окно загрузки Forge (fmlearlydisplay) само создаёт контекст OpenGL и
    // на слабых/старых драйверах падает с "Timed out trying to setup the Game Window"
    // ещё до старта игры. Окно чисто косметическое — прогресс и так виден в лаунчере,
    // поэтому выключаем его: игра грузится обычным путём.
    customArgs: ["-javaagent:" + agentPath + "=ely.by", "-Dfml.earlyprogresswindow=false"]
      .concat(javaFlags(cfg.ram || 7, !!sel.lite))
  };

  if (!vanilla && cfg.serverIp) {
    opts.quickPlay = {
      type: "multiplayer",
      identifier: cfg.serverIp + (cfg.serverPort ? (":" + cfg.serverPort) : "")
    };
  }
  const loaderName = String(cfg.loader);
  const L = loaderName.toLowerCase();
  let writeLogLater = "";                      // строка про лоадер уйдёт в лог запуска ниже
  let writeLogLater2 = "";                     // и строка про разведённые настройки
  const sendPrep = (msg, pct, err) => {
    let p = (typeof pct === "number" ? pct : 0);
    if (p > 100) p = 100;
    if (win) sendUI("mc-modprogress", { msg: msg, pct: p, error: !!err });
  };

  // ===== JAVA (готовим ДО лоадера — установщик NeoForge её требует) =====
  let javaPath = cfg.javaPath;
  let needJava = 17;
  if (!javaPath) {
    try { needJava = await getRequiredJava(cfg.version); } catch (e) { needJava = 17; }
    try {
      javaPath = await ensureJava(needJava, (msg, pct) => {
        if (win) sendUI("mc-modprogress", { msg: msg, pct: (typeof pct === "number" ? pct : 0) });
      });
    } catch (e) {
      const bundled = bundledJava();
      if (needJava === 17 && fs.existsSync(bundled)) {
        javaPath = bundled;
      } else {
        if (win) sendUI("mc-modprogress", { msg: "Не удалось подготовить Java " + needJava + " для версии " + cfg.version + ": " + (e.message || e), pct: -1, error: true });
        doneLaunching();
        return true;
      }
    }
  }
  if (javaPath) opts.javaPath = javaPath;

  // привязать игру к дискретной видеокарте (спросит разрешение при первом запуске)
  try { await applyGpuPreference(javaPath); } catch (e) {}

  // ===== ЛОАДЕР: Vanilla / Forge / Fabric / NeoForge (+ OptiFine поверх Forge) =====
  // Встроенный инсталлятор Forge берётся, только если он именно от запускаемой версии.
  try {
    if (L.indexOf("fabric") !== -1) {
      opts.version.custom = await ensureFabric(root, cfg.version, sendPrep);
      writeLogLater = "Fabric: " + opts.version.custom;
    } else if (L.indexOf("neoforge") !== -1) {
      opts.version.custom = await ensureNeoforge(root, cfg.version, javaPath || "", sendPrep);
      writeLogLater = "NeoForge: " + opts.version.custom;
    } else if (L.indexOf("forge") === -1 && L.indexOf("optifine") !== -1) {
      // OptiFine БЕЗ Forge (standalone)
      opts.version.custom = await ensureOptifineStandalone(cfg, cfg.version, root, sendPrep);
      writeLogLater = "OptiFine (standalone): " + opts.version.custom;
    } else if (L.indexOf("forge") !== -1) {
      let forgePath = "";
      const bundled = cfg.forgeInstaller
        ? (path.isAbsolute(cfg.forgeInstaller) ? cfg.forgeInstaller : path.join(RES, cfg.forgeInstaller))
        : "";
      if (!cfg.forgeBuild && bundled && fs.existsSync(bundled) &&
          path.basename(bundled).indexOf("forge-" + cfg.version + "-") === 0) {
        forgePath = bundled;                       // встроенный подходит этой версии
      }
      if (!forgePath) forgePath = await ensureForgeInstaller(root, cfg.version, sendPrep, cfg.forgeBuild || "");
      // до запуска проверяем целость клиента игры и частей Forge (см. repairGameFiles)
      const fixedFiles = repairGameFiles(root, cfg.version);
      if (fixedFiles.length) sendPrep("Нашлись повреждённые файлы игры — скачиваю заново…", 0, false);
      opts.forge = forgePath;
      writeLogLater = "Forge: " + forgePath;
      if (fixedFiles.length) writeLogLater += "\nБыли битыми, удалены для перекачки: " + fixedFiles.join(", ");
      // сборка с OptiFine: он ставится поверх Forge, обычным модом в папку сборки
      if (L.indexOf("optifine") !== -1) {
        const of = await ensureOptifine(cfg, cfg.version, gameDir, sendPrep);
        writeLogLater += "\nOptiFine: " + of;
      }
    }
  } catch (e) {
    sendPrep("Не удалось подготовить " + loaderName + " для " + cfg.version + ": " + (e.message || e), -1, true);
    doneLaunching();
    return true;
  }

  // полный лог запуска в файл на рабочем столе — чтобы прислать на диагностику
  let logPath = "";
  try { logPath = path.join(app.getPath("desktop"), "javelin-log.txt"); } catch (e) {}
  const writeLog = (line) => { try { if (logPath) fs.appendFileSync(logPath, line + "\n"); } catch (e) {} };
  try { if (logPath) fs.writeFileSync(logPath, "=== JavelinMC лог запуска ===\n"); } catch (e) {}
  writeLog("Прислано из интерфейса: " + JSON.stringify(sel));
  writeLog("Запускаем: " + cfg.loader + " " + cfg.version + "  | серверная сборка=" + isServer +
    "  | режим игрока=" + playerMode + (myPack ? ("  | своя сборка: " + myPack.name) : ""));
  writeLog("папка сборки: " + gameDir);
  if (writeLogLater) writeLog(writeLogLater);
  if (writeLogLater2) { writeLog("[javelin] " + writeLogLater2); if (win) sendUI("mc-log", "[javelin] " + writeLogLater2); }
  writeLog("Java: " + (opts.javaPath || "(системная)") + "  | нужна major=" + needJava);
  writeLog("память: выбрано " + (cfg.ram || 7) + " ГБ, уходит в Java -Xmx" + opts.memory.max +
    " -Xms" + opts.memory.min + "  | на машине " + Math.round(machineMb() / 1024) +
    " ГБ, потолок " + Math.round(safeMaxMb() / 1024) + " ГБ");
  writeLog("authlib: " + agentPath);
  writeLog("папка игры: " + root);
  // если игрок выбрал режим слабого ПК — один раз настраиваем саму игру
  if (sel.lite) { try { applyLiteGameOptions(gameDir, function(m){ writeLog("[javelin] " + m); sendPrep(m, 0, false); }); } catch (e) {} }
  writeLog("--- лог движка Minecraft ---");

  // свежий экземпляр движка на КАЖДЫЙ запуск — иначе он помнит версию от прошлого запуска
  const mc = new Client();
  // Копим вывод игры, чтобы при вылете было по чему определить причину.
  // Держим последние 400 строк: этого хватает, а память не течёт.
  const выводИгры = [];
  const запомнить = (s) => { выводИгры.push(s); if (выводИгры.length > 400) выводИгры.shift(); };
  const стартВремя = Date.now();
  mc.on("debug", (l) => { if (myGen !== launchGen) return; const s = String(l); запомнить(s); if (win) sendUI("mc-log", s); writeLog("[debug] " + s); });
  mc.on("data",  (l) => { if (myGen !== launchGen) return; const s = String(l); запомнить(s); if (win) sendUI("mc-log", s); writeLog("[data] " + s); });
  mc.on("progress", (p) => { if (myGen !== launchGen) return; if (win) sendUI("mc-progress", p); });
  mc.on("close", (c) => {
    if (myGen !== launchGen) return;
    activeProc = null;
    writeLog("[close] код выхода: " + c);
    if (c && c !== 0) {
      const сек = Math.round((Date.now() - стартВремя) / 1000);
      const причина = crashReason(выводИгры.join("\n"), c, сек);
      writeLog("[javelin] прожила " + сек + " с; причина: " + (причина || "определить не удалось"));
      if (win) sendUI("mc-reason", причина);
    }
    if (win) sendUI("mc-closed", c);
  });

  if (win) sendUI("mc-modprogress", { msg: "Готовлю Minecraft " + cfg.version + (vanilla ? " (одиночная)" : " (сервер)") + "…", pct: 0 });
  mc.launch(opts).then((proc) => {
    doneLaunching();
    if (!proc) return;
    if (myGen === launchGen) {
      activeProc = proc; // это актуальный запуск — запоминаем процесс
      // Игра ТОЛЬКО СЕЙЧАС по-настоящему пошла. До этого момента лаунчер качал
      // файлы, и гасить фон было незачем: игрок минутами смотрел в пустоту.
      if (win) sendUI("mc-started", cfg.version);
    } else {
      // пока эта версия готовилась, человек запустил другую — закрываем «опоздавший» процесс
      writeLog("[javelin] запуск " + cfg.version + " отменён более новым — закрываю процесс");
      try { proc.kill(); } catch (e) {}
    }
  }).catch((err) => {
    doneLaunching();
    const m = err && err.message ? err.message : String(err);
    writeLog("[ОШИБКА launch] " + m);
    if (myGen === launchGen && win) sendUI("mc-modprogress", { msg: "Ошибка запуска " + cfg.version + ": " + m, pct: -1, error: true });
  });
  return true;
});

// ===== автообновление =====
// скачиваем НЕ автоматически, а только когда игрок нажмёт зелёную кнопку
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// качаем файл целиком, а не «разницу» — режим разницы с GitHub часто зависает без процентов
autoUpdater.disableDifferentialDownload = true;

// нашёлся новый патч -> сообщаем интерфейсу его версию (кнопка загорится зелёным)
autoUpdater.on("update-available", (info) => {
  if (win) sendUI("update-available", info && info.version);
});
// патча нет -> "у вас последняя версия"
autoUpdater.on("update-not-available", () => {
  if (win) sendUI("update-none");
});
// идёт скачивание -> проценты
autoUpdater.on("download-progress", (p) => {
  if (win) sendUI("update-progress", p ? Math.round(p.percent) : 0);
});
// скачалось -> интерфейс покажет "перезапуск..." и попросит установить
autoUpdater.on("update-downloaded", (info) => {
  if (win) sendUI("update-ready", info && info.version);
});
// ошибка -> покажем мягкое сообщение, лаунчер не падает
autoUpdater.on("error", (err) => {
  if (win) sendUI("update-error", String((err && err.message) || err || "ошибка"));
});

// кнопка "Проверить": ручная проверка обновлений
ipcMain.handle("check-update", () => { try { autoUpdater.checkForUpdates(); } catch (e) {} });
// зелёная кнопка "Обновить лаунчер": скачать найденный патч
ipcMain.handle("download-update", () => {
  try {
    const p = autoUpdater.downloadUpdate();
    // если загрузка сорвётся уже после старта — сообщим интерфейсу, чтобы он показал "скачать вручную"
    if (p && typeof p.catch === "function") {
      p.catch((err) => { if (win) sendUI("update-error", String((err && err.message) || err || "download error")); });
    }
  } catch (e) {
    if (win) sendUI("update-error", String((e && e.message) || e || "download error"));
  }
});
// установить скачанное и перезапуститься
ipcMain.handle("install-update", () => { try { autoUpdater.quitAndInstall(); } catch (e) {} });
// открыть страницу релизов на GitHub в браузере (ручная загрузка, если авто-загрузка застряла)
ipcMain.handle("open-release-page", () => {
  try { shell.openExternal("https://github.com/akhmadmfw-debug/javelinmc-launcher/releases/latest"); } catch (e) {}
});
// открыть страницу с модами на GitHub (чтобы добавить новый мод — залить .jar)
ipcMain.handle("open-mods-page", () => {
  try {
    const cfg = loadConfig();
    const url = "https://github.com/" + cfg.githubOwner + "/" + cfg.githubRepo + "/releases/tag/" + encodeURIComponent(cfg.githubTag || "");
    shell.openExternal(url);
  } catch (e) {}
});

// список всех версий Minecraft (релизы) с серверов Mojang — для выбора версии игроком
ipcMain.handle("get-versions", async () => {
  try {
    const u = new URL("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
    const r = await httpsRequest({ hostname: u.hostname, path: u.pathname, method: "GET", headers: { "User-Agent": "JavelinMC" } });
    if (r.status < 200 || r.status >= 300) return { ok: false, message: "HTTP " + r.status };
    const data = JSON.parse(r.body);
    const releases = (data.versions || []).filter((v) => v.type === "release").map((v) => v.id);
    return { ok: true, versions: releases };
  } catch (e) { return { ok: false, message: e.message }; }
});

// установлена ли версия (есть ли её файлы на диске игрока)
ipcMain.handle("is-version-installed", (e, versionId) => {
  try {
    const root = path.join(app.getPath("appData"), ".javelinmc");
    const id = String(versionId || "");
    const jsonPath = path.join(root, "versions", id, id + ".json");
    return { ok: true, installed: fs.existsSync(jsonPath) };
  } catch (err) { return { ok: false, installed: false }; }
});
