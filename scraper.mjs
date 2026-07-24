import "dotenv/config";
import { loginAndGetSession } from "./src/fajans-auth.mjs";
import { scrapeCategories } from "./src/scrape-core.mjs";
import { CATEGORIES } from "./src/categories.mjs";

// --- аргументы командной строки: node scraper.mjs [--out=file.json] [--no-price] ---
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const OUT_FILE = args.out ?? "data/lots.json";
const WITH_PRICE = !args["no-price"]; // получение цены требует авторизованной сессии

async function main() {
  let cookieJar = {};

  if (WITH_PRICE) {
    const { FAJANS_USER, FAJANS_PASS } = process.env;
    if (!FAJANS_USER || !FAJANS_PASS) {
      console.error("В .env не заданы FAJANS_USER / FAJANS_PASS — заполните их, либо запустите с флагом --no-price, чтобы пропустить логин.");
      process.exit(1);
    }
    console.log("Логинимся как", FAJANS_USER, "...");
    const login = await loginAndGetSession(FAJANS_USER, FAJANS_PASS);
    if (!login.success) {
      console.error("Логин не удался (статус", login.status, "location", login.location, ") — прерываю работу.");
      process.exit(1);
    }
    cookieJar = login.cookieJar;
    console.log("Успешно залогинились.\n");
  }

  let lastCategory = null;
  const { deals, scanned, found } = await scrapeCategories(CATEGORIES, cookieJar, {
    onProgress(p) {
      if (p.stage === "listing") {
        if (p.name !== lastCategory) {
          console.log(`Раздел "${p.name}" (${p.slug}):`);
          lastCategory = p.name;
        }
        console.log(`  страница ${p.page}/${p.totalPages}`);
      } else if (p.stage === "detail") {
        console.log(`[детали ${p.index}/${p.total}]`);
      } else {
        console.log(`[ИИ-оценка ${p.done}/${p.total}]`);
      }
    },
  });

  const fs = await import("fs");
  const path = await import("path");
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(deals, null, 2), "utf-8");
  console.log(`\nОтсканировано ${scanned} из ${found} найденных лотов, подходящих по цене — ${deals.length}. Сохранено в ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("Критическая ошибка:", err);
  process.exit(1);
});
