import fs from "fs";
import path from "path";
import { DEFAULT_SELECTED_SLUGS } from "./categories.mjs";

// Путь считается от текущей рабочей директории процесса (запускаем bot.mjs из
// корня проекта командой `node bot.mjs`, поэтому "./data/..." указывает верно).
const CONFIG_PATH = "./data/bot-config.json";

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  // На свежем окружении (например, только что склонированный репозиторий на VPS)
  // папки ./data ещё может не быть — locally она давно создана прошлыми запусками,
  // из-за чего это всплыло только на новом сервере.
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// По умолчанию выбран стартовый набор разделов, пока пользователь сам не поменяет.
export function getSelectedSlugs(chatId) {
  const config = loadConfig();
  return config[chatId]?.categories ?? DEFAULT_SELECTED_SLUGS;
}

export function setSelectedSlugs(chatId, slugs) {
  const config = loadConfig();
  config[chatId] = { ...config[chatId], categories: slugs };
  saveConfig(config);
}
