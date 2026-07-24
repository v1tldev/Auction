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

/**
 * Просит модель оценить лот по фото/названию/описанию.
 * Возвращает { marketPrice: number|null, comment: string }.
 */
export async function appraiseLot({ title, description, mainPhoto }) {
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
  const parsed = JSON.parse(raw);
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
