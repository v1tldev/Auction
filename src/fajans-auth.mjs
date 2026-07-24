import * as cheerio from "cheerio";

export const BASE = "https://www.fajans.lv";

// Без таймаута зависший запрос (сервер принял соединение, но не шлёт данные)
// блокирует await fetch(...) навсегда — сканирование застревает без вывода
// прогресса, а "Отменить" не помогает, т.к. отмена проверяется только МЕЖДУ
// запросами, а не во время них. С таймаутом зависший запрос падает с ошибкой
// вместо бесконечного ожидания.
const FETCH_TIMEOUT_MS = 15000;
export const withTimeout = (opts = {}) => ({ ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

// --- простой ручной cookie jar (Node fetch не хранит cookies между запросами сам) ---
function parseSetCookie(setCookieArray) {
  const jar = {};
  for (const line of setCookieArray || []) {
    const [pair] = line.split(";"); // отбрасываем атрибуты path/HttpOnly/SameSite
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    jar[name] = value;
  }
  return jar;
}

export function jarToHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function getSetCookies(res) {
  return typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
}

/**
 * Логинится и возвращает cookie jar сессии (PHPSESSID и т.д.) для последующих запросов.
 *
 * Механизм (CSRF в стиле Yii2):
 *  1. GET /ru/login  -> даёт куки PHPSESSID + _csrf, и настоящий csrf-токен лежит
 *     в <input type="hidden" name="_csrf" value="..."> (то же значение, что и в
 *     <meta name="csrf-token">). В POST нужно отправлять именно значение из hidden-поля,
 *     а НЕ сырое содержимое cookie _csrf.
 *  2. POST /ru/login  (application/x-www-form-urlencoded)
 *       тело: _csrf=<hidden-токен>&LoginForm[username]=<email>&LoginForm[password]=<пароль>&LoginForm[rememberMe]=0
 *       заголовки: Cookie: PHPSESSID=...; _csrf=...  (из шага 1)
 *     При успехе Yii2 обычно регенерирует session id, поэтому Set-Cookie из ответа
 *     на POST (если есть) должен перезаписать старый PHPSESSID.
 */
export async function loginAndGetSession(username, password) {
  // 1. GET страницы логина
  const loginPageRes = await fetch(`${BASE}/ru/login`, withTimeout({
    headers: { ...BROWSER_HEADERS, Referer: `${BASE}/ru/auction` },
  }));
  const loginPageHtml = await loginPageRes.text();
  let cookieJar = parseSetCookie(getSetCookies(loginPageRes));

  const $ = cheerio.load(loginPageHtml);
  const csrfToken = $('form#login-form input[name="_csrf"]').attr("value")
    || $('meta[name="csrf-token"]').attr("content");

  if (!csrfToken) {
    throw new Error("Не нашли CSRF-токен на /ru/login — возможно, изменилась структура страницы");
  }
  if (!cookieJar.PHPSESSID) {
    throw new Error("/ru/login не вернул cookie PHPSESSID");
  }

  // 2. POST с учётными данными
  const body = new URLSearchParams({
    _csrf: csrfToken,
    "LoginForm[username]": username,
    "LoginForm[password]": password,
    "LoginForm[rememberMe]": "0",
  });

  const loginPostRes = await fetch(`${BASE}/ru/login`, withTimeout({
    method: "POST",
    redirect: "manual", // разбираем редирект сами, не даём fetch следовать за ним
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/ru/login`,
      Origin: BASE,
      Cookie: jarToHeader(cookieJar),
    },
    body: body.toString(),
  }));

  // подмешиваем куки, которые POST-логин мог обновить (Yii2 обычно меняет PHPSESSID)
  cookieJar = { ...cookieJar, ...parseSetCookie(getSetCookies(loginPostRes)) };

  const status = loginPostRes.status;
  const location = loginPostRes.headers.get("location");
  const success = status >= 300 && status < 400 && location && !location.includes("/login");

  if (!success) {
    // при неудаче Yii2 рендерит ту же страницу логина с ошибками валидации (200 OK)
    const failHtml = await loginPostRes.text().catch(() => "");
    const errorText = cheerio.load(failHtml)(".help-block-error").text().trim();
    console.warn("Логин не дал ожидаемого редиректа. Статус:", status, "Location:", location, "Блок ошибки:", errorText || "(не найден)");
  }

  return { success, cookieJar, status, location };
}

export function parseEuro(text) {
  if (!text) return null;
  const m = text.replace(/ /g, " ").match(/([\d]+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".")) : null;
}

// История ставок (#lot-bids) на странице лота разбита на страницы (10 строк на
// страницу) и на живом аукционе меняется между запросами — постраничный обход
// гонится за движущейся целью и даёт завышенный/нестабильный результат (было:
// 69, потом 67, а реальное число — 59, каждый раз новое). Бейдж ".bids-count"
// на странице списка — атомарное число без пагинации, поэтому надёжнее брать его.
//
// Поиск на сайте ищет совпадение по тексту в заголовках лотов, а каждый заголовок
// содержит "#<lotId>" (например "#186291 Ликерная бутылка..."), поэтому поиск по
// номеру лота надёжно находит нужную карточку без обхода всего каталога. Тем не
// менее сверяемся именно с атрибутом data-id, а не полагаемся на текстовый поиск
// напрямую — на случай совпадения подстроки с номером другого лота.
export async function fetchBidsCount(lotId, cookieJar) {
  const searchUrl = `${BASE}/ru/auction/category/all?search=${lotId}`;
  const res = await fetch(searchUrl, withTimeout({
    headers: { ...BROWSER_HEADERS, Referer: `${BASE}/ru/auction`, Cookie: jarToHeader(cookieJar) },
  }));
  const $ = cheerio.load(await res.text());
  const card = $(`main.lot[data-id="${lotId}"]`).first();
  if (!card.length) return null; // лот не найден через поиск (завершился/удалён?) — вызывающий код должен считать это "неизвестно"
  return parseEuro(card.find(".bids-count").first().text()) ?? 0;
}

/**
 * Забирает страницу лота с авторизованным cookie jar и возвращает структурированную
 * сводку по цене/ставкам. Проверено на 4 живых лотах (0, 1, 2 и 59 ставок).
 *
 * Реальная разметка залогиненного пользователя внутри .product-page__sidebar--bid-details:
 *   <div class="current-bid" id="current-bid">Текущая ставка<span>€&nbsp;50</span></div>
 *   <div class="current-bid-message">Следующая минимальная ставка <span>€ 50</span></div>
 *   <div class="quick-bid-buttons">
 *     <a id="quickbid-1" href="javascript:setBid(50)"><span>€&nbsp;50</span></a> ...
 *   </div>
 *   <div id="lot-bids">
 *     <div class="list-view">
 *       <div data-key="...">
 *         <div class="bid-winner ..."><span class="bid-amount"><strong>€&nbsp;5</strong></span>
 *           <strong class="bid-alias-name">Участник 1</strong>
 *           <div class="bid-time" title="unix_ts">2026-07-23 17:14:13</div></div>
 *       </div>
 *       ... <ul class="pagination">...</ul>  (только если ставок больше 10)
 *     </div>
 *   </div>
 * У гостя этот блок целиком заменён на
 * <div class="alert alert-warning">Только зарегистрированные пользователи...</div>.
 *
 * Примечание: bidStep = следующая минимальная ставка - currentBid. Когда bidsCount
 * равен 0, currentBid — это просто стартовая цена, а следующая минимальная ставка
 * равна ей же, поэтому bidStep получается 0 — так и должно быть (первая ставка
 * обязана лишь совпасть со стартовой ценой), это не баг парсинга.
 *
 * bidsCount берётся отдельным лёгким запросом (см. fetchBidsCount), а не подсчётом
 * строк в #lot-bids — этот список пагинирован и меняется на живом аукционе, так что
 * обход его страниц гонится за живой лентой вместо точного числа.
 */
// Чистый парсер по уже загруженному cheerio $ для страницы лота — вынесен отдельно,
// чтобы скрапер мог переиспользовать HTML, который он уже один раз забрал для
// фото/описания, вместо повторного запроса той же страницы через getLotPrice.
export function parsePriceFromLoadedHtml($) {
  const bidDetails = $(".product-page__sidebar--bid-details").first();
  const gated = /зарегистрированные пользователи/i.test(bidDetails.text());

  if (gated) {
    return { gated: true, currentBid: null, bidStep: null };
  }

  const currentBid = parseEuro($("#current-bid span").first().text());
  const nextMinBid = parseEuro($(".current-bid-message span").first().text());

  return {
    gated: false,
    currentBid,
    bidStep: currentBid != null && nextMinBid != null ? nextMinBid - currentBid : null,
  };
}

export async function getLotPrice(lotId, cookieJar) {
  const url = `${BASE}/ru/auction/${lotId}`;
  const res = await fetch(url, withTimeout({
    headers: {
      ...BROWSER_HEADERS,
      Referer: `${BASE}/ru/auction`,
      Cookie: jarToHeader(cookieJar),
    },
  }));
  const $ = cheerio.load(await res.text());
  const { gated, currentBid, bidStep } = parsePriceFromLoadedHtml($);

  if (gated) {
    return { lotId, status: res.status, gated: true, currentBid: null, bidStep: null, bidsCount: null };
  }

  const bidsCount = await fetchBidsCount(lotId, cookieJar);
  return { lotId, status: res.status, gated: false, currentBid, bidStep, bidsCount };
}
