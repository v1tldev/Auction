import fs from "fs";
import path from "path";

// Один клиент, один аукцион — храним результаты последнего скана одним файлом
// на диске (без привязки к чату), чтобы отдать их заново по кнопке в любой
// момент, даже после перезапуска бота.
const RESULTS_PATH = "./data/last-scan.json";

export function saveLastResults(groups) {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ savedAt: new Date().toISOString(), groups }, null, 2), "utf-8");
}

// Возвращает groups: [[categoryName, lots[]], ...] или null, если сканирований ещё не было.
export function loadLastResults() {
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
    return data.groups ?? null;
  } catch {
    return null;
  }
}
