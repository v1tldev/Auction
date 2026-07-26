import { writeJsonAtomic, readJson } from "./json-file.mjs";

// Один клиент, один аукцион — храним результаты последнего скана одним файлом
// на диске (без привязки к чату), чтобы отдать их заново по кнопке в любой
// момент, даже после перезапуска бота.
const RESULTS_PATH = "./data/last-scan.json";

export function saveLastResults(groups) {
  writeJsonAtomic(RESULTS_PATH, { savedAt: new Date().toISOString(), groups });
}

// Возвращает groups: [[categoryName, lots[]], ...] или null, если сканирований ещё не было.
export function loadLastResults() {
  return readJson(RESULTS_PATH)?.groups ?? null;
}
