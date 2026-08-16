// ===== Оформление страниц аккаунта под стиль лаунчера =====
// Запускается ДО скриптов самой страницы, поэтому стиль стоит уже на первом кадре —
// белого «мигания» чужого сайта больше нет.
//
// ВАЖНО: здесь ничего не переписывается в тексте страницы. Она собрана на React,
// и правка textContent обваливает её в чёрный экран. Мы только прячем лишнее
// через style и никогда не трогаем формы.

const CSS = `
  :root{color-scheme:dark;}
  html,body{background:#0b0918!important;color:#e9e5f7!important;}
  /* Имена классов на сайте генерирует сборщик, целиться по ним бесполезно.
     Поэтому гасим фон у ВСЕГО, кроме полей и кнопок: белые панели становятся
     прозрачными, и сквозь них виден наш тёмный фон. */
  body *:not(button):not(input):not(select):not(textarea):not(img):not(svg):not(path):not(canvas):not(video):not(iframe){
    background-color:transparent!important;
    background-image:none!important;
    border-color:rgba(168,85,247,.22)!important;
    box-shadow:none!important;
    color:#e9e5f7!important;
  }
  h1,h2,h3,h4,h5,b,strong{color:#fff!important;}
  a{color:#c8a2ff!important;}
  a:hover{color:#e2ccff!important;}
  input,select,textarea{background:#161029!important;color:#f0ecff!important;
    border:1px solid rgba(168,85,247,.35)!important;border-radius:10px!important;}
  input:focus,textarea:focus,select:focus{border-color:#a855f7!important;outline:none!important;
    box-shadow:0 0 0 3px rgba(168,85,247,.18)!important;}
  button,[type=submit],[type=button],[role=button]{
    background:linear-gradient(135deg,#a855f7,#7c3aed)!important;color:#fff!important;
    border:1px solid rgba(200,147,255,.55)!important;border-radius:12px!important;
    box-shadow:0 6px 18px rgba(124,58,237,.3)!important;}
  ::-webkit-scrollbar{width:10px;height:10px;}
  ::-webkit-scrollbar-track{background:#0b0918;}
  ::-webkit-scrollbar-thumb{background:#6d28d9;border-radius:6px;}
`;

// Стиль ставим сразу и повторно после сборки страницы — на случай, если
// на момент запуска ещё нет ни head, ни body.
function addStyle() {
  try {
    if (document.getElementById("jv-ely-theme")) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    const s = document.createElement("style");
    s.id = "jv-ely-theme";
    s.textContent = CSS;
    root.appendChild(s);
  } catch (e) {}
}
addStyle();

const KILL = [
  /allows you to get access/i,
  /authorization service/i,
  /take care of your account safety/i,
  /account preferences/i,
  /позволяет получить доступ/i,
  /сервисе авторизации/i,
  /Благодаря аккаунту/i,
  /Берегите свой аккаунт/i,
  /^Настройки аккаунта/i,
  // реклама и правила на странице загрузки скина
  /^Рекомендации:?$/i,
  /Загружайте красивые скины/i,
  /они станут украшением/i,
  /отличаются буквально/i,
  /такие скины будут удаляться/i,
  /Мы поддерживаем новый формат скинов/i,
  /Канал автора/i,
  /^Telegram$/i,
  /^Поиск пользователей$/i
];
const BRAND = ["Ely.by", "Ely", "Ely Accounts"];
const BRAND_RE = /Ely\s*\.?\s*by/i;
const seen = new WeakSet();

// Капчу и всё, что относится ко входу, не трогаем НИКОГДА: это чужие хрупкие
// виджеты. Любая наша правка может сделать их невидимыми — и человек не сможет
// ни зарегистрироваться, ни пройти двухшаговый вход, ни восстановить пароль.
const SAFE_SEL = '[class*="captcha" i],[id*="captcha" i],[data-sitekey],iframe,' +
  '[class*="auth" i],[id*="auth" i],[class*="totp" i],[id*="totp" i],' +
  '[class*="two-factor" i],[class*="twofactor" i],[class*="2fa" i],' +
  '[class*="verif" i],[id*="verif" i],[class*="code" i][class*="input" i],' +
  '[class*="password" i],[id*="password" i],[class*="recover" i],[class*="forgot" i]';
function isCaptcha(el) {
  try { return !!(el.closest && el.closest(SAFE_SEL)); } catch (e) { return false; }
}

function clean() {
  try {
    document.querySelectorAll("h1,h2,h3,p,li,span,div,section,aside,a").forEach(function (el) {
      if (seen.has(el)) return;
      if (isCaptcha(el)) return;
      // Формы и кнопки не трогаем НИКОГДА — иначе можно спрятать вход.
      // Ссылки и картинки разрешены: реклама почти всегда именно с ними.
      if (el.querySelector && el.querySelector("input,select,textarea,button,form")) return;
      if (el.childElementCount > 4) return;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 400) return;
      let hit = BRAND.indexOf(t) !== -1;
      // Любая КОНЕЧНАЯ надпись с упоминанием бренда — это логотип, заголовок или
      // рекламный абзац, на любом языке. Только листья: контейнер трогать нельзя,
      // иначе можно снести шапку вместе с меню аккаунта.
      if (!hit && el.childElementCount === 0 && t.length <= 260 && BRAND_RE.test(t)) hit = true;
      if (!hit) { for (let i = 0; i < KILL.length; i++) { if (KILL[i].test(t)) { hit = true; break; } } }
      if (hit) { seen.add(el); el.style.display = "none"; }
    });
  } catch (e) {}
}

document.addEventListener("DOMContentLoaded", function () { addStyle(); clean(); });
// страница дорисовывается и после загрузки, плюс переходы внутри неё — проверяем регулярно
setInterval(clean, 700);

// ===== КОГДА КАПЧА НЕ ЗАГРУЗИЛАСЬ =====
// Ely.by проверяет «я не робот» через Google reCAPTCHA (recaptcha.net и gstatic.com).
// У части игроков эти адреса режет провайдер, антивирус или блокировщик рекламы.
// Тогда капча просто не появляется: ошибки не видно, кнопка не работает, человек в тупике.
// Разблокировать Google мы не можем, но обязаны честно объяснить, что происходит.
(function () {
  var shown = false;

  function captchaAlive() {
    try {
      var f = document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"]');
      if (!f) return false;
      var r = f.getBoundingClientRect();
      return r.width > 20 && r.height > 20;      // виджет реально нарисован
    } catch (e) { return true; }                 // сомневаешься — не пугай зря
  }

  // капча нужна не на всех страницах: ищем место, куда её собирались вставить
  function captchaExpected() {
    try {
      return !!document.querySelector('[data-sitekey],.g-recaptcha,[class*="captcha" i],[id*="captcha" i]')
        || /register|signup/i.test(location.pathname);
    } catch (e) { return false; }
  }

  function banner() {
    if (shown || !document.body) return;
    shown = true;
    var b = document.createElement("div");
    b.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:2147483000;" +
      "max-width:min(640px,92vw);padding:14px 16px;border-radius:14px;font-size:13.5px;line-height:1.5;" +
      "font-family:system-ui,Segoe UI,sans-serif;color:#f3e9ff;background:rgba(28,10,48,.96);" +
      "border:1px solid rgba(178,120,255,.45);box-shadow:0 12px 40px rgba(0,0,0,.55);";
    var t = document.createElement("div");
    t.innerHTML = "<b>Проверка «Я не робот» не загрузилась</b><br>" +
      "Её показывает Google, и на твоём интернете этот адрес заблокирован — обычно из-за " +
      "провайдера, антивируса или блокировщика рекламы. Отключи блокировщик и VPN и обнови страницу, " +
      "либо зарегистрируйся в обычном браузере.";
    b.appendChild(t);

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:11px;flex-wrap:wrap;";
    function mk(text, fn, primary) {
      var x = document.createElement("button");
      x.textContent = text;
      x.style.cssText = "padding:8px 13px;border-radius:10px;cursor:pointer;font-size:13px;border:1px solid " +
        (primary ? "rgba(200,147,255,.6);background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff"
                 : "rgba(178,120,255,.35);background:transparent;color:#e2ccff");
      x.addEventListener("click", fn);
      row.appendChild(x);
      return x;
    }
    mk("Обновить страницу", function () { try { location.reload(); } catch (e) {} }, true);
    mk("Открыть в браузере", function () {
      try { require("electron").ipcRenderer.send("jv-open-external", location.href); } catch (e) {}
    }, false);
    mk("Скрыть", function () { try { b.remove(); } catch (e) {} }, false);
    b.appendChild(row);
    document.body.appendChild(b);
  }

  function check() {
    if (shown) return;
    if (!captchaExpected()) return;
    if (captchaAlive()) return;
    banner();
  }

  // даём странице время загрузиться: раньше 8 секунд не тревожим
  setTimeout(function () {
    check();
    var n = 0;
    var t = setInterval(function () { if (++n > 12 || shown) { clearInterval(t); return; } check(); }, 2500);
  }, 8000);
})();
