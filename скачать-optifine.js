// ============================================================
//  Массовое скачивание OptiFine — по одному (самому свежему) файлу
//  на каждую версию Minecraft. Складывает всё в папку optifine-jars.
//  Потом эти файлы заливаются в GitHub-релиз с тегом "optifine".
//
//  Запуск:  node скачать-optifine.js
//  (нужен только Node.js, который уже стоит для лаунчера)
// ============================================================

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "optifine-jars");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

// сравнить ревизии OptiFine: сначала буква (I<J<K), потом число (I6<I7)
function revRank(name) {
  const m = name.match(/HD_U_([A-Z])(\d+)/i);
  if (!m) return [0, 0];
  return [m[1].toUpperCase().charCodeAt(0), parseInt(m[2], 10)];
}
function betterRev(a, b) {
  const ra = revRank(a), rb = revRank(b);
  if (ra[0] !== rb[0]) return ra[0] > rb[0];
  return ra[1] >= rb[1];
}

async function getJar(file) {
  // 1) страница с рекламой -> достаём ссылку с одноразовым токеном
  const ad = await fetch("https://optifine.net/adloadx?f=" + file, { headers: { "User-Agent": UA } });
  const html = await ad.text();
  const m = html.match(/downloadx\?f=[^'"&]+&x=[a-f0-9]+/);
  if (!m) throw new Error("не нашёл ссылку на файл (страница OptiFine изменилась?)");
  // 2) сам файл
  const d = await fetch("https://optifine.net/" + m[0], {
    headers: { "User-Agent": UA, "Referer": "https://optifine.net/adloadx?f=" + file }
  });
  if (!d.ok) throw new Error("HTTP " + d.status);
  const buf = Buffer.from(await d.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) throw new Error("это не jar (пришла HTML-страница)");
  return buf;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("Беру список версий с optifine.net …");
  const page = await (await fetch("https://optifine.net/downloads", { headers: { "User-Agent": UA } })).text();

  // все стабильные файлы (без preview)
  const files = [...new Set(
    [...page.matchAll(/adloadx\?f=(OptiFine_[^'"&]+\.jar)/g)].map((x) => x[1])
  )].filter((f) => !/preview/i.test(f));

  // по одному лучшему файлу на версию Minecraft
  const best = {};
  for (const f of files) {
    const mv = f.match(/OptiFine_(\d+\.\d+(?:\.\d+)?)/);
    if (!mv) continue;
    const mc = mv[1];
    if (!best[mc] || betterRev(f, best[mc])) best[mc] = f;
  }
  const list = Object.values(best);
  console.log("Версий Minecraft:", list.length, "\n");

  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const dest = path.join(OUT, file);
    const tag = "(" + (i + 1) + "/" + list.length + ") " + file;
    if (fs.existsSync(dest)) { console.log("уже есть  " + tag); skip++; continue; }
    try {
      const buf = await getJar(file);
      fs.writeFileSync(dest, buf);
      console.log("скачано   " + tag + "  " + Math.round(buf.length / 1024) + " КБ");
      ok++;
    } catch (e) {
      console.log("ОШИБКА    " + tag + "  — " + e.message);
      fail++;
    }
    await new Promise((r) => setTimeout(r, 400)); // не спамим сайт
  }

  console.log("\nГотово. Скачано:", ok, "| пропущено:", skip, "| ошибок:", fail);
  console.log("Файлы лежат в:", OUT);
  console.log("\nТеперь залей их в релиз. Если стоит GitHub CLI (gh), одной командой:");
  console.log('  gh release create optifine "' + OUT + '"\\*.jar -t OptiFine -R akhmadmfw-debug/javelinmc-mods');
  console.log("  (если релиз уже есть:  gh release upload optifine \"" + OUT + "\"\\*.jar -R akhmadmfw-debug/javelinmc-mods)");
})().catch((e) => { console.error("Сбой:", e.message); process.exit(1); });
