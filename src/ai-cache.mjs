import crypto from "crypto";
import { writeJsonAtomic, readJson } from "./json-file.mjs";

// Кэш ИИ-оценок по номеру лота.
//
// Зачем: название, описание и фото лота на fajans.lv не меняются, пока лот
// висит на аукционе, — значит и рыночная оценка по ним не меняется. Меняется
// только текущая ставка, а её мы и так забираем свежей на каждом скане. Без
// кэша каждый скан заново прогонял через ИИ все ~2700 лотов: это и самая долгая
// часть скана, и весь расход по API-ключу. С кэшем повторный скан тратит ИИ
// только на новые лоты, а фильтр "выгодно/невыгодно" всё равно считается по
// свежей цене.
//
// Оценки с marketPrice === null ("ИИ не смог оценить") тоже кэшируем — переспрашивать
// про тот же лот бессмысленно, ответ будет тот же.
//
// ВАЖНО, почему кэш нельзя привязывать к одному только номеру лота: fajans.lv
// выкладывает лот ЗАГОТОВКОЙ и заполняет данные позже. В прошлом скрапе 38 из 960
// лотов имели название буквально "Информация пополняется", а имя файла главного
// фото (оно фиксируется при загрузке и потом не меняется) начинается с
// "Informacia-popolnaetsa" у 89% лотов — то есть через эту стадию проходит
// практически каждый лот. Оценка, сделанная по такой заготовке, ничего не стоит, и
// заморозить её навсегда — худшее, что можно сделать: как раз свежие лоты и
// интересны клиенту больше всего. Поэтому в записи кэша лежит отпечаток тех данных,
// по которым оценка делалась: изменилось название, описание или фото — оценка
// считается устаревшей, и лот отправляется к ИИ заново.
const CACHE_PATH = "./data/ai-cache.json";

// Аукцион живёт неделями, а не годами: полгода — с большим запасом на случай,
// если лот выставят повторно. Записи старше просто выкидываем при сохранении,
// чтобы файл не пух бесконечно.
const TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Сбрасываем на диск не на каждой записи (это тысячи writeFileSync за скан), а
// пачками — при этом даже если скан оборвётся на середине, уже сделанные оценки
// в основном сохранятся и не будут заказаны у ИИ повторно.
const FLUSH_EVERY = 100;

let entries = null;
let unsaved = 0;

function load() {
  if (entries) return entries;
  const raw = readJson(CACHE_PATH);
  entries = raw && typeof raw.entries === "object" && raw.entries !== null ? raw.entries : {};
  return entries;
}

// Отпечаток ровно тех данных, которые уходят в запрос к ИИ. Цены здесь СПЕЦИАЛЬНО
// нет: она меняется на каждой ставке, а рыночная оценка от неё не зависит — иначе
// кэш не давал бы попаданий вообще.
export function fingerprintLot({ title, description, mainPhoto }) {
  return crypto
    .createHash("sha1")
    .update(`${title ?? ""}\n${description ?? ""}\n${mainPhoto ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

// Возвращает { marketPrice, comment } или null, если лот ещё не оценивали либо его
// данные на сайте с тех пор изменились.
export function getCachedAppraisal(lotId, fingerprint) {
  const hit = load()[lotId];
  if (!hit) return null;
  if (Date.now() - (hit.at ?? 0) > TTL_MS) return null;
  if (hit.fp !== fingerprint) return null; // лот отредактировали — оценка устарела
  return { marketPrice: hit.marketPrice ?? null, comment: hit.comment ?? "" };
}

export function setCachedAppraisal(lotId, fingerprint, marketPrice, comment) {
  load()[lotId] = { fp: fingerprint, marketPrice, comment, at: Date.now() };
  if (++unsaved >= FLUSH_EVERY) saveAiCache();
}

export function saveAiCache() {
  if (!entries || unsaved === 0) return;
  unsaved = 0;
  const now = Date.now();
  for (const [id, entry] of Object.entries(entries)) {
    if (now - (entry.at ?? 0) > TTL_MS) delete entries[id];
  }
  try {
    writeJsonAtomic(CACHE_PATH, { savedAt: new Date(now).toISOString(), entries });
  } catch (err) {
    // Не смогли записать кэш — это не повод валить скан, просто в следующий раз
    // те же лоты уйдут в ИИ заново.
    console.error("Не удалось сохранить кэш ИИ-оценок:", err.message);
  }
}

export function aiCacheSize() {
  return Object.keys(load()).length;
}
