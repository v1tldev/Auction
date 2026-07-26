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

  // В консоли, в отличие от чата, частота вывода никого не ограничивает, но
  // печатать по строке на каждый из ~2700 лотов всё равно незачем — раз в 2
  // секунды достаточно, чтобы видеть, что процесс жив.
  let lastLogAt = 0;
  const result = await scrapeCategories(CATEGORIES, cookieJar, {
    onProgress(p) {
      const now = Date.now();
      if (now - lastLogAt < 2000) return;
      lastLogAt = now;
      if (p.stage === "listing") {
        console.log(`[списки] разделов готово ${p.done}/${p.total}, найдено лотов — ${p.lots}`);
      } else {
        console.log(`[лоты ${p.index}/${p.total}] ИИ-оценка ${p.aiDone}/${p.aiTotal}, из кэша ${p.cached}`);
      }
    },
  });
  const { deals, scanned, found } = result;

  const fs = await import("fs");
  const path = await import("path");
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(deals, null, 2), "utf-8");
  console.log(
    `\nОтсканировано ${scanned} из ${found} найденных лотов (с видимой ценой — ${result.priced}, ` +
      `не открылись — ${result.failed}, оценок из кэша — ${result.cached}), ` +
      `подходящих по цене — ${deals.length}. Сохранено в ${OUT_FILE}`
  );
  if (result.gatedMidScan) console.warn("ВНИМАНИЕ: скан прервался досрочно — аккаунт потерял доступ к ценам.");
  if (result.aiUnavailable) console.warn("ВНИМАНИЕ: скан прервался досрочно — ИИ перестал отвечать (лимит/баланс?).");
}

main().catch((err) => {
  console.error("Критическая ошибка:", err);
  process.exit(1);
});
