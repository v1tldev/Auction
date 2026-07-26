import OpenAI from "openai";

const MODEL = "google/gemini-3-flash-preview";
const BASE_URL = "https://polza.ai/api/v1";

// По умолчанию у клиента таймаут запроса — 10 минут, плюс 2 встроенных
// повтора при сбое (итого до ~30 минут на один зависший запрос). При скане
// всех категорий (тысячи лотов) в самом конце мы ждём завершения ВСЕХ ИИ-
// оценок разом (Promise.all) — зависший на сети запрос мог держать там весь
// скан подолгу, и со стороны это выглядело как "завис/сломался". Сокращаем
// таймаут до разумных 30с и отключаем встроенные повторы SDK — свой повтор
// уже есть в appraiseLot() ниже, дублировать его на уровне SDK незачем.
const REQUEST_TIMEOUT_MS = 30000;

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.API_KEY) {
      throw new Error("В .env не задан API_KEY (ключ для polza.ai)");
    }
    client = new OpenAI({
      apiKey: process.env.API_KEY,
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return client;
}

const SYSTEM_PROMPT =
  "Ты — эксперт-оценщик антиквариата и коллекционных вещей. По фото, названию и описанию " +
  "лота с аукциона оцени его реальную рыночную цену — среднюю цену продажи такой же или " +
  "аналогичной вещи на открытом рынке (комиссионки, барахолки, другие аукционы, маркетплейсы), " +
  "в евро. В разделе с серебром считай что ручки не серебряные. Когда оцениваешь монеты заходи на сайт: 'https://en.ucoin.net/' Отвечай ТОЛЬКО валидным JSON без markdown-разметки, в формате " +
  '{"market_price": <число в евро, или null если оценить невозможно>, "comment": ' +
  '"<короткий комментарий на русском, 1-2 предложения, почему такая цена>"}.';

// Отдельный тип ошибки для исчерпанного лимита/баланса на polza.ai — в отличие
// от разовых сетевых сбоев, повторять запрос немедленно бессмысленно (лимит не
// снимется за миллисекунды), и об этом нужно явно сказать в чате, а не молча
// пропустить все лоты одним тихим 0.
export class AIQuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "AIQuotaExceededError";
  }
}

function isQuotaError(err) {
  return err?.status === 402 || err?.code === "INSUFFICIENT_BALANCE" || err?.error?.code === "INSUFFICIENT_BALANCE";
}

async function requestAppraisal({ title, description, mainPhoto }) {
  const completion = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Название лота: ${title}\nОписание: ${description || "(нет описания)"}` },
          { type: "image_url", image_url: { url: mainPhoto } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.0,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw);
}

/**
 * Просит модель оценить лот по фото/названию/описанию.
 * Возвращает { marketPrice: number|null, comment: string }.
 */
export async function appraiseLot(lot) {
  let parsed;
  try {
    parsed = await requestAppraisal(lot);
  } catch (err) {
    if (isQuotaError(err)) throw new AIQuotaExceededError(err.message);
    // Одна повторная попытка — сетевые сбои у polza.ai часто разовые, не хочется
    // терять потенциально хороший лот из-за одного неудачного запроса. Лимит
    // баланса, в отличие от сетевого сбоя, повторной попыткой не лечится.
    try {
      parsed = await requestAppraisal(lot);
    } catch (err2) {
      if (isQuotaError(err2)) throw new AIQuotaExceededError(err2.message);
      throw err2;
    }
  }
  const marketPrice = typeof parsed.market_price === "number" ? parsed.market_price : null;
  const comment = typeof parsed.comment === "string" ? parsed.comment : "";
  return { marketPrice, comment };
}

// Индивидуальные пороги минимальной разницы (в евро) по разделу — по просьбе
// клиента: "Живопись" даёт слишком много ложных "выгодных" находок при 100€
// (картины сложно оценивать, разброс большой), нужен порог пожёстче. А у
// "Нумизматика"/"Серебро" абсолютные цены обычно ниже, и 100€ отсекало почти
// всё — там порог, наоборот, мягче. Остальные разделы — дефолтные 100€.
const CATEGORY_MIN_DIFF = {
  "Живопись": 1000,
  "Нумизматика": 30,
  "Серебро": 30,
};
const DEFAULT_MIN_DIFF = 100;

// categoryNames — названия разделов, которым принадлежит лот (лот может попасть
// сразу в несколько) — берём порог первого совпавшего спецраздела, иначе дефолт.
export function getMinDiffForCategories(categoryNames) {
  for (const name of categoryNames) {
    if (name in CATEGORY_MIN_DIFF) return CATEGORY_MIN_DIFF[name];
  }
  return DEFAULT_MIN_DIFF;
}

// Условие сделки: аукционная цена минимум в 3 раза меньше рыночной, и при этом
// разница между рыночной и аукционной ценой — не меньше minDiff (по умолчанию
// 100€, но для некоторых разделов другой порог — см. getMinDiffForCategories).
export function passesDealFilter(auctionPrice, marketPrice, minDiff = DEFAULT_MIN_DIFF) {
  if (auctionPrice == null || marketPrice == null) return false;
  return auctionPrice * 3 <= marketPrice && marketPrice - auctionPrice >= minDiff;
}
