// ===== Связка интерфейса с настоящим запуском Minecraft =====
// Этот файл подключается к твоему HTML и заставляет кнопку "Играть"
// реально логинить через Microsoft и запускать игру.
// Работает только внутри Electron (когда есть мост window.javelin).
// В обычном браузере он ничего не ломает — просто молчит.

(function () {
  if (!window.javelin) {
    // запущено как обычная веб-страница (без Electron) — выходим
    return;
  }

  var launching = false;

  function setStatus(msg) {
    // показываем статус под кнопкой запуска, если есть подходящий элемент
    var el = document.getElementById("updateNote") || document.getElementById("skinHint");
    if (el) el.textContent = msg;
    console.log("[javelin] " + msg);
  }

  // логи игры -> в админ-консоль (если открыта) и в DevTools
  window.javelin.onLog(function (line) {
    console.log(line);
    var c = document.getElementById("console");
    if (c) {
      var d = document.createElement("div");
      d.className = "sys";
      d.textContent = line;
      c.appendChild(d);
      c.scrollTop = c.scrollHeight;
    }
  });

  window.javelin.onProgress(function (p) {
    if (!p || !p.type) return;
    var names = { assets: "Ресурсы игры", natives: "Библиотеки", "classes": "Файлы игры", "classes-maven-custom": "Forge" };
    var label = names[p.type] || p.type;
    var pct = (p.total ? Math.round((p.task || 0) / p.total * 100) : null);
    setStatus("Загрузка: " + label + (pct != null ? " — " + pct + "%" : ""));
  });
  // прогресс модов также показываем на экране «Играть»
  window.javelin.onModProgress(function (p) {
    if (!p) return;
    setStatus(p.msg + (p.pct != null && p.pct >= 0 ? " — " + p.pct + "%" : ""));
  });


  window.javelin.onClosed(function () {
    launching = false;
    setStatus("Игра закрыта");
  });

  // обновления лаунчера
  window.javelin.onUpdateAvailable(function () {
    setStatus("Доступно обновление лаунчера — скачивается...");
  });
  window.javelin.onUpdateReady(function () {
    var btn = document.getElementById("updateLauncherBtn");
    if (btn) {
      btn.textContent = "Установить обновление";
      btn.onclick = function () { window.javelin.installUpdate(); };
    }
    setStatus("Обновление готово — нажми «Установить обновление»");
  });

  // Кнопку «Играть» этот файл больше НЕ трогает.
  // Раньше здесь висел второй обработчик клика (со времён входа через Microsoft):
  // он вызывал window.javelin.login() и открывал окно Ely.by поверх основного
  // сценария, а launch() звал без версии. Весь запуск теперь живёт в
  // javelinmc-launcher.html, вход — только во вкладке «Аккаунт».
})();
