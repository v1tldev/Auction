import "dotenv/config";
import { loginAndGetSession } from "../src/fajans-auth.mjs";
import { scrapeCategories, checkPricesVisible } from "../src/scrape-core.mjs";
import { CATEGORIES } from "../src/categories.mjs";
import { aiCacheSize } from "../src/ai-cache.mjs";

// Быстрая проверка всей цепочки скрапинга без Telegram: логин -> доступ к ценам ->
// обход разделов -> оценка ИИ -> кэш. По умолчанию берёт два самых маленьких
// раздела (9 лотов на двоих), чтобы прогон занимал секунды и почти не тратил
// запросы к ИИ.
//
//   node scripts/run-scan-test.mjs
//   node scripts/run-scan-test.mjs artworks watch    # конкретные разделы по slug
const wanted = process.argv.slice(2);
const CATS = wanted.length
  ? CATEGORIES.filter((c) => wanted.includes(c.slug))
  : CATEGORIES.filter((c) => ["artworks", "lacquerminiature"].includes(c.slug));

if (!CATS.length) {
  console.error("Не нашёл разделов по переданным slug. Доступные:", CATEGORIES.map((c) => c.slug).join(", "));
  process.exit(1);
}

console.log("Разделы:", CATS.map((c) => c.name).join(", "));
console.log("В кэше ИИ-оценок сейчас:", aiCacheSize());

const t0 = Date.now();
const login = await loginAndGetSession(process.env.FAJANS_USER, process.env.FAJANS_PASS);
console.log(`Логин: ${login.success ? "успешно" : "НЕ УДАЛСЯ"} (${Date.now() - t0}ms)`);
if (!login.success) process.exit(1);

console.log("Доступ к ценам:", await checkPricesVisible(CATS, login.cookieJar));

const stages = new Set();
const result = await scrapeCategories(CATS, login.cookieJar, {
  relogin: async () => {
    console.log("  (сессия истекла — перелогиниваюсь)");
    const fresh = await loginAndGetSession(process.env.FAJANS_USER, process.env.FAJANS_PASS);
    return fresh.success ? fresh.cookieJar : null;
  },
  onProgress(p) {
    stages.add(p.stage);
    console.log("  прогресс:", JSON.stringify(p));
  },
});

console.log("\n--- РЕЗУЛЬТАТ ---");
console.log("время:", ((Date.now() - t0) / 1000).toFixed(1) + "с");
console.log({
  found: result.found,
  scanned: result.scanned,
  priced: result.priced,
  failed: result.failed,
  cached: result.cached,
  deals: result.deals.length,
  gatedMidScan: result.gatedMidScan,
  aiUnavailable: result.aiUnavailable,
});
console.log("стадии прогресса:", [...stages]);
console.log("в кэше ИИ-оценок стало:", aiCacheSize());
if (result.deals[0]) {
  console.log("поля сделки:", Object.keys(result.deals[0]).join(", "));
  console.log("пример:", JSON.stringify(result.deals[0]).slice(0, 240));
}
