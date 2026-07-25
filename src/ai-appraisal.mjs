import OpenAI from "openai";

const MODEL = "google/gemini-3-flash-preview";
const BASE_URL = "https://polza.ai/api/v1";

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.API_KEY) {
      throw new Error("В .env не задан API_KEY (ключ для polza.ai)");
    }
    client = new OpenAI({ apiKey: process.env.API_KEY, baseURL: BASE_URL });
  }
  return client;
}

const SYSTEM_PROMPT =
  "Ты — эксперт-оценщик антиквариата и коллекционных вещей. По фото, названию и описанию " +
  "лота с аукциона оцени его реальную рыночную цену — среднюю цену продажи такой же или " +
  "аналогичной вещи на открытом рынке (комиссионки, барахолки, другие аукционы, маркетплейсы), " +
  "в евро. Отвечай ТОЛЬКО валидным JSON без markdown-разметки, в формате " +
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
    temperature: 0.3,
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

// Условие сделки: аукционная цена минимум в 3 раза меньше рыночной, и при этом
// разница между рыночной и аукционной ценой — не меньше 100 евро (иначе выгода в
// абсолютных числах слишком мала, даже если соотношение формально подходит).
// Порог подняли с 30€ до 100€ по просьбе клиента — со старым фильтром находилось
// слишком много мелких лотов, а нужны именно "жемчужины".
export function passesDealFilter(auctionPrice, marketPrice) {
  if (auctionPrice == null || marketPrice == null) return false;
  return auctionPrice * 3 <= marketPrice && marketPrice - auctionPrice >= 100;
}
