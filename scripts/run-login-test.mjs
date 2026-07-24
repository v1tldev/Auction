// Запускать самостоятельно из корня проекта: node scripts/run-login-test.mjs
// Учётные данные читаются из переменных окружения, чтобы не оседать в истории
// консоли или в чём-либо, что попадёт обратно в чат. Задавайте их прямо перед
// запуском, одной строкой:
//
//   FAJANS_USER=you@example.com FAJANS_PASS='yourpassword' node scripts/run-login-test.mjs
//
// (В Windows PowerShell:)
//   $env:FAJANS_USER="you@example.com"; $env:FAJANS_PASS="yourpassword"; node scripts/run-login-test.mjs

import { loginAndGetSession, getLotPrice } from "../src/fajans-auth.mjs";

const username = process.env.FAJANS_USER;
const password = process.env.FAJANS_PASS;

if (!username || !password) {
  console.error("Задайте переменные окружения FAJANS_USER и FAJANS_PASS перед запуском.");
  process.exit(1);
}

// подобраны из живого списка /ru/auction, чтобы покрыть разные состояния ставок:
const LOT_IDS = [
  188288, // 0 ставок
  188474, // 1 ставка
  188477, // 2 ставки
  186291, // 59 ставок
];

const { success, cookieJar, status, location } = await loginAndGetSession(username, password);

console.log("\n=== РЕЗУЛЬТАТ ЛОГИНА ===");
console.log("success:", success, "| status:", status, "| redirect location:", location);
console.log("имена полученных cookie:", Object.keys(cookieJar));

if (!success) {
  console.error("\nЛогин не дал ожидаемого редиректа — останавливаюсь перед запросом лотов.");
  process.exit(1);
}

for (const lotId of LOT_IDS) {
  console.log(`\n=== ЛОТ ${lotId} ===`);
  const result = await getLotPrice(lotId, cookieJar);
  console.log("Результат парсинга:", result);
}
