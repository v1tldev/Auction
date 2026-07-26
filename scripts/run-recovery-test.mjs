import "dotenv/config";
import { loginAndGetSession } from "../src/fajans-auth.mjs";
import { scrapeCategories } from "../src/scrape-core.mjs";

// Проверка двух аварийных сценариев, которые на живом боте сами не воспроизведёшь:
//  1) отмена сканирования — насколько быстро скан реально останавливается;
//  2) потеря сессии посреди скана — скан должен сам перелогиниться и доехать.
// Второй сценарий эмулируется честно: скрапинг стартует с ПУСТЫМИ куками (то есть
// цены скрыты, ровно как у протухшей сессии), а relogin отдаёт настоящую сессию.
const CAT = [{ slug: "watch", name: "Часы" }];
const fastWait = () => new Promise((r) => setTimeout(r, 50));

console.log("=== 1. Отмена сканирования ===");
{
  const login = await loginAndGetSession(process.env.FAJANS_USER, process.env.FAJANS_PASS);
  let seen = 0;
  let cancelled = false;
  const t0 = Date.now();
  const result = await scrapeCategories(CAT, login.cookieJar, {
    politeWait: fastWait,
    isCancelled: () => cancelled,
    onProgress(p) {
      if (p.stage === "scanning" && p.index >= 5 && !cancelled) {
        cancelled = true;
        console.log(`  отменяю на ${p.index}-м лоте (в очереди ИИ: ${p.aiTotal - p.aiDone})`);
      }
      if (p.stage === "scanning") seen = p.index;
    },
  });
  console.log(`  скан остановился на ${seen} лотах за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
  console.log(`  found=${result.found} scanned=${result.scanned} deals=${result.deals.length}`);
}

console.log("\n=== 2. Протухшая сессия + перелогин ===");
{
  let reloginCalls = 0;
  let stoppedAt = 0;
  const t0 = Date.now();
  const result = await scrapeCategories(CAT, /* пустые куки = цены скрыты */ {}, {
    politeWait: fastWait,
    relogin: async () => {
      reloginCalls++;
      const fresh = await loginAndGetSession(process.env.FAJANS_USER, process.env.FAJANS_PASS);
      return fresh.success ? fresh.cookieJar : null;
    },
    onProgress(p) {
      if (p.stage === "scanning") stoppedAt = p.index;
    },
    // Ограничиваем ИИ, чтобы тест не тратил запросы: оценивать всё равно нечего,
    // пока цены скрыты, а после перелогина хватит и небольшого хвоста.
    maxAiBacklog: 5,
  });
  console.log(`  relogin вызван раз: ${reloginCalls} (ожидается 1)`);
  console.log(`  обработано лотов: ${stoppedAt} из ${result.found}`);
  console.log(`  priced=${result.priced} (цена стала видна после перелогина), gatedMidScan=${result.gatedMidScan}`);
  console.log(`  время: ${((Date.now() - t0) / 1000).toFixed(1)}с`);
}

console.log("\n=== 3. Сессия теряется ДВА раза за скан ===");
{
  // Первый перелогин отдаёт снова нерабочие куки (эмулируем повторное истечение
  // сессии), второй — настоящие. Скан должен пережить оба раза и доехать.
  let attempts = 0;
  const result = await scrapeCategories(CAT, {}, {
    politeWait: fastWait,
    maxAiBacklog: 5,
    relogin: async () => {
      attempts++;
      if (attempts === 1) return {}; // "перелогинились", но цены снова не видны
      const fresh = await loginAndGetSession(process.env.FAJANS_USER, process.env.FAJANS_PASS);
      return fresh.success ? fresh.cookieJar : null;
    },
  });
  console.log(`  перелогинов: ${attempts} (ожидается 2)`);
  console.log(`  priced=${result.priced} из ${result.found}, gatedMidScan=${result.gatedMidScan} (ожидается false)`);
}

console.log("\n=== 4. Потеря сессии БЕЗ возможности перелогина ===");
{
  let stoppedAt = 0;
  const result = await scrapeCategories(CAT, {}, {
    politeWait: fastWait,
    onProgress(p) {
      if (p.stage === "scanning") stoppedAt = p.index;
    },
  });
  console.log(`  скан оборвался на ${stoppedAt} лотах из ${result.found} (ожидается ~8, а не все ${result.found})`);
  console.log(`  gatedMidScan=${result.gatedMidScan} (ожидается true), priced=${result.priced}`);
}
