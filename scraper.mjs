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
  const results = await scrapeCategories(CATEGORIES, cookieJar, {
    onProgress(p) {
      if (p.stage === "listing") {
        if (p.name !== lastCategory) {
          console.log(`Раздел "${p.name}" (${p.slug}):`);
          lastCategory = p.name;
        }
        console.log(`  страница ${p.page}/${p.totalPages}`);
      } else {
        console.log(`[${p.index}/${p.total}] ${p.lot.category} / лот ${p.lot.id}: ${p.lot.title.slice(0, 60)}...`);
        if (p.lot.error) console.error(`  ошибка:`, p.lot.error);
      }
    },
  });

  const fs = await import("fs");
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nСохранено ${results.length} лотов в ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("Критическая ошибка:", err);
  process.exit(1);
});
