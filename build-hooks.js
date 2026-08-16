// Значок для самого JavelinMC.exe.
//
// Обычно его ставит electron-builder, но у нас выключено signAndEditExecutable:
// без этого сборщик лезет качать инструменты подписи, а они распаковываются
// только с правами администратора — сборка падала. Поэтому значок прописываем
// сами, тем же инструментом (rcedit), уже после упаковки.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const dir = context.packager.projectDir;
  const ico = path.join(dir, "icon.ico");
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + ".exe");
  // Свой rcedit лежит рядом с проектом. Если его нет — ищем в кэше сборщика.
  let tool = path.join(dir, "build-tools", "rcedit-x64.exe");
  if (!fs.existsSync(tool)) tool = findCached();

  if (!fs.existsSync(ico)) { console.log("  • значок не найден: " + ico); return; }
  if (!fs.existsSync(exe)) { console.log("  • .exe не найден: " + exe); return; }
  if (!tool) { console.log("  • нет rcedit — значок останется стандартным"); return; }

  const v = context.packager.appInfo.version;
  try {
    execFileSync(tool, [
      exe,
      "--set-icon", ico,
      "--set-version-string", "FileDescription", "JavelinMC",
      "--set-version-string", "ProductName", "JavelinMC",
      "--set-version-string", "CompanyName", "JavelinMC",
      "--set-file-version", v,
      "--set-product-version", v
    ], { stdio: "pipe" });
    console.log("  • значок и данные о версии записаны в " + path.basename(exe));
  } catch (e) {
    // не повод ронять сборку: программа соберётся, просто со стандартным значком
    console.log("  • не удалось записать значок: " + ((e && e.message) || e));
  }
};

// rcedit из кэша electron-builder, если своего рядом не оказалось
function findCached() {
  try {
    const base = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name, "rcedit-x64.exe");
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return "";
};
