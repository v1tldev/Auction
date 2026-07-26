import * as cheerio from "cheerio";
import { BASE, BROWSER_HEADERS, jarToHeader, parsePriceFromLoadedHtml, withTimeout } from "./fajans-auth.mjs";
import { appraiseLot, passesDealFilter, getMinDiffForCategories, AIQuotaExceededError } from "./ai-appraisal.mjs";

// ВАЖНО: за последней реальной страницей категории сайт НЕ отдаёт пустой список —
// он просто повторяет последнюю страницу снова и снова для любого page=N сверх
// предела. Поэтому останавливаться нужно по номеру последней страницы из блока
// пагинации (ul.pagination li.last a), а не по признаку "список пуст" — на этом
// раньше зависал бесконечный цикл.
//
// query-параметр page уже 1-based (page=1 — та же первая страница, что и голый
// URL без query вовсе; page=2 — реально вторая и т.д.) — проверено напрямую
// запросами. 0-based индекс лежит отдельно, в атрибуте data-page, его не используем.
export async function fetchCategoryPage(slug, page) {
  const url = page === 1
    ? `${BASE}/ru/auction/category/${slug}`
    : `${BASE}/ru/auction/category/${slug}?page=${page}&per-page=25`;
  const res = await fetch(url, withTimeout({ headers: { ...BROWSER_HEADERS, Referer: `${BASE}/ru/auction` } }));
  const $ = cheerio.load(await res.text());

  // Фото и цену берём со страницы самого лота (см. scrapeLotDetail) — thumbnail
  // из списка низкого качества, поэтому здесь нужны только id/название.
  const lots = [];
  $("main.lot[data-id]").each((_, el) => {
    const card = $(el);
    const id = card.attr("data-id");
    const rawTitle = card.find(".title h2 a").first().text().trim();
    lots.push({ id, title: rawTitle.replace(new RegExp(`^#${id}\\s*`), "") });
  });

  // На последней странице категории пункт "Последняя" в пагинации становится
  // disabled и превращается в <span> без ссылки (вместо <a href>) — раньше
  // из-за этого totalPages на последней странице тихо схлопывался до 1
  // (например, "стр. 5/1" вместо "5/5"). Номерные ссылки страниц, наоборот,
  // всегда несут атрибут data-page (0-based) независимо от того, активна
  // страница или нет — берём максимум по ним, это надёжнее.
  let totalPages = 1;
  $("ul.pagination a[data-page]").each((_, el) => {
    const dataPage = Number($(el).attr("data-page"));
    if (Number.isFinite(dataPage)) totalPages = Math.max(totalPages, dataPage + 1);
  });

  return { lots, totalPages };
}

// Главное фото в галерее лота лежит в href первой ссылки (id="main-image-link") —
// это оригинал в полном качестве. У вложенного <img src> там же — уменьшенная
// "/thumbs/"-версия, такая же по сути, как и картинка в списке, поэтому её не берём.
export async function scrapeLotDetail(lotId, cookieJar) {
  const url = `${BASE}/ru/auction/${lotId}`;
  const res = await fetch(url, withTimeout({
    headers: { ...BROWSER_HEADERS, Referer: `${BASE}/ru/auction`, Cookie: jarToHeader(cookieJar) },
  }));
  const $ = cheerio.load(await res.text());

  const mainPhoto = $("#main-image-link").attr("href")
    || $(".product-page__product-gallery--main-image a.js-fancybox").first().attr("href")
    || null;

  // Блок описания на странице лота содержит внутри себя ещё и виджет "поделиться"
  // и служебные <style>/<script> — вырезаем их перед извлечением текста, иначе
  // в описание для ИИ попадает разметка и CSS вместо реального текста.
  const descriptionNode = $("#tab-description").clone();
  descriptionNode.find(".social-share, style, script").remove();
  const description = descriptionNode.text().replace(/\s+/g, " ").trim();

  const { gated, currentBid } = parsePriceFromLoadedHtml($);
  return { mainPhoto, price: gated ? null : currentBid, description, gated };
}

// Проверяет ДО полного скана, видит ли аккаунт вообще цены (гейт "Только
// зарегистрированные пользователи..." бывает даже у формально залогиненного
// аккаунта — например, если он не прошёл модерацию на сайте). Смотрим на
// первый попавшийся лот из переданных разделов — не гонять же весь скан
// впустую, чтобы в конце получить 0 сделок без объяснения причины.
export async function checkPricesVisible(categories, cookieJar) {
  for (const { slug } of categories) {
    const { lots } = await fetchCategoryPage(slug, 1);
    if (lots.length) {
      const detail = await scrapeLotDetail(lots[0].id, cookieJar);
      return { visible: !detail.gated };
    }
  }
  return { visible: null }; // ни в одном разделе не нашлось ни одного лота — нечем проверить
}

const defaultPoliteWait = () => new Promise((r) => setTimeout(r, 400 + Math.random() * 200));

// Простой пул с ограничением параллелизма — нужен для запросов к ИИ: они должны
// идти ПАРАЛЛЕЛЬНО скрапингу (а не отдельным долгим шагом после него), чтобы не
// отставать от него по времени, но при этом не заваливать polza.ai сотнями
// одновременных запросов разом.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => {
      active--;
      runNext();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

/**
 * Полный обход списка разделов + деталей каждого лота + оценка ИИ.
 * categories: [{ slug, name }, ...]
 * cookieJar: из loginAndGetSession (или {} для гостевого режима без цены)
 * options.politeWait: функция паузы между запросами к fajans.lv (по умолчанию случайные 400-600мс)
 * options.aiConcurrency: сколько лотов оценивать через ИИ одновременно (по умолчанию 5)
 * options.onProgress: колбэк({ stage: "listing"|"detail"|"appraising", ... }) для статуса в боте/консоли
 * options.isCancelled: функция () => boolean — проверяется между запросами; при true
 *   обход останавливается досрочно (уже запущенные оценки ИИ доигрываются до конца)
 *
 * Возвращает { deals, scanned, found, gatedMidScan, aiUnavailable }, где deals —
 * лоты, прошедшие фильтр "аукционная цена минимум в 3 раза меньше рыночной, и
 * разница — не меньше минимального порога для раздела" (порог по умолчанию 100€,
 * но для некоторых разделов другой — см. getMinDiffForCategories в ai-appraisal.mjs),
 * с добавленными полями marketPrice/aiComment.
 * gatedMidScan: true значит, что скан прервался досрочно из-за потери доступа к
 * ценам (см. GATED_STREAK_LIMIT ниже). aiUnavailable: true значит, что скан
 * прервался из-за того, что ИИ перестал отвечать (лимит/баланс у провайдера,
 * либо просто серия отказов подряд — см. AI_FAILURE_STREAK_LIMIT ниже). В обоих
 * случаях результат может быть неполным.
 */
export async function scrapeCategories(categories, cookieJar, options = {}) {
  const politeWait = options.politeWait || defaultPoliteWait;
  const onProgress = options.onProgress || (() => {});
  const isCancelled = options.isCancelled || (() => false);
  const aiLimit = createLimiter(options.aiConcurrency || 5);

  // Один лот может относиться сразу к нескольким нужным нам разделам (например,
  // статуэтка из фарфора попадает и в "Фарфор", и в "Статуэтки") — дедуплицируем
  // по id, объединяя названия разделов через " / " вместо дублей в выдаче.
  const lotsById = new Map();
  categoriesLoop: for (const { slug, name } of categories) {
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const { lots, totalPages: pagesReported } = await fetchCategoryPage(slug, page);
      totalPages = pagesReported;
      onProgress({ stage: "listing", slug, name, page, totalPages });
      for (const lot of lots) {
        const existing = lotsById.get(lot.id);
        if (existing) {
          if (!existing.categories.includes(name)) existing.categories.push(name);
        } else {
          lotsById.set(lot.id, { ...lot, categories: [name] });
        }
      }
      if (isCancelled()) break categoriesLoop;
      await politeWait();
    }
  }

  const allLots = [...lotsById.values()];

  const deals = [];
  const pendingAppraisals = [];
  let aiDispatched = 0;
  let aiDone = 0;
  // Клиент может в будущем сменить провайдера ИИ — у каждого свой формат ошибки
  // на исчерпанный лимит/баланс, и все заранее не предусмотришь. Поэтому кроме
  // точечного распознавания уже известного формата (polza.ai, см. ниже) держим
  // и универсальный детектор: если несколько запросов ПОДРЯД проваливаются
  // (неважно, почему и в каком формате пришла ошибка) — считаем, что ИИ стал
  // недоступен, и не тратим время на скрапинг остальных лотов впустую.
  const AI_FAILURE_STREAK_LIMIT = 8; // с запасом больше уровня параллелизма (5)
  let consecutiveAiFailures = 0;
  let aiUnavailable = false;

  function queueAppraisal(lot, minDiff) {
    if (aiUnavailable) return;
    if (lot.price == null || !lot.mainPhoto) return; // без цены/фото оценивать нечего
    aiDispatched++;
    pendingAppraisals.push(
      aiLimit(async () => {
        try {
          const { marketPrice, comment } = await appraiseLot({
            title: lot.title,
            description: lot.description,
            mainPhoto: lot.mainPhoto,
          });
          consecutiveAiFailures = 0;
          if (passesDealFilter(lot.price, marketPrice, minDiff)) {
            deals.push({ ...lot, marketPrice, aiComment: comment });
          }
        } catch (err) {
          if (err instanceof AIQuotaExceededError) {
            aiUnavailable = true; // известный формат — реагируем сразу же, без ожидания серии
          } else {
            consecutiveAiFailures++;
            if (consecutiveAiFailures >= AI_FAILURE_STREAK_LIMIT) aiUnavailable = true;
          }
          // Ошибку ИИ по одному лоту (кроме двух случаев выше) не считаем фатальной
          // для всего скана — просто пропускаем этот лот, как и при ошибках скрапинга.
        } finally {
          aiDone++;
          onProgress({ stage: "appraising", done: aiDone, total: aiDispatched });
        }
      })
    );
  }

  // Скан всех разделов может идти очень долго (тысячи лотов) — если сессия
  // fajans.lv протухнет посреди него, каждый следующий лот молча вернётся с
  // gated:true (цена скрыта), и без этой проверки скан бы тихо доехал до конца
  // с сильно неполным результатом, не предупредив, что что-то сломалось.
  // Несколько гейтов подряд — явный признак именно этого, а не случайности.
  const GATED_STREAK_LIMIT = 5;
  let consecutiveGated = 0;
  let gatedMidScan = false;

  let scanned = 0;
  for (const [i, lot] of allLots.entries()) {
    const category = lot.categories.join(" / ");
    try {
      const detail = await scrapeLotDetail(lot.id, cookieJar);
      consecutiveGated = detail.gated ? consecutiveGated + 1 : 0;
      const result = {
        id: lot.id,
        category,
        title: lot.title,
        mainPhoto: detail.mainPhoto,
        price: detail.price,
        description: detail.description,
      };
      scanned++;
      queueAppraisal(result, getMinDiffForCategories(lot.categories));
    } catch {
      // Ошибку скрапинга одного лота не считаем фатальной — просто пропускаем его.
    }
    onProgress({ stage: "detail", index: i + 1, total: allLots.length });
    if (consecutiveGated >= GATED_STREAK_LIMIT) {
      gatedMidScan = true;
      break;
    }
    if (aiUnavailable) break;
    if (isCancelled()) break;
    await politeWait();
  }

  // Скрапинг деталей рассчитан на неспешный политвейт (400-600мс/лот), а ИИ-оценки
  // идут параллельно ему пачками — к моменту завершения цикла выше обычно почти
  // всё уже оценено, здесь лишь донидаем самый хвост.
  await Promise.all(pendingAppraisals);

  return { deals, scanned, found: allLots.length, gatedMidScan, aiUnavailable };
}
