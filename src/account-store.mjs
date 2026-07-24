import fs from "fs";
import path from "path";

// Личный бот для одного клиента — шифровать логин/пароль от fajans.lv не
// требуется, храним как есть, по chatId (каждый чат может подставить свой
// аккаунт вместо дефолтного из .env).
const STORE_PATH = "./data/accounts.json";

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// Возвращает { username, password } если для чата задан свой аккаунт, иначе null
// (в этом случае вызывающий код должен взять дефолтный из .env).
export function getAccountOverride(chatId) {
  const store = loadStore();
  return store[chatId] ?? null;
}

export function setAccountOverride(chatId, username, password) {
  const store = loadStore();
  store[chatId] = { username, password };
  saveStore(store);
}

export function clearAccountOverride(chatId) {
  const store = loadStore();
  delete store[chatId];
  saveStore(store);
}
