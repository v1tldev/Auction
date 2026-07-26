import * as cheerio from "cheerio";
import { BASE, BROWSER_HEADERS, jarToHeader, parsePriceFromLoadedHtml, withTimeout } from "./fajans-auth.mjs";
import { appraiseLot, passesDealFilter, getMinDiffForCategories, AIQuotaExceededError } from "./ai-appraisal.mjs";
import { getCachedAppraisal, setCachedAppraisal, saveAiCache, fingerprintLot } from "./ai-cache.mjs";

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
//
// Разовый сетевой сбой на этой проверке не должен ронять весь скан ДО его начала
// (раньше исключение отсюда давало "Сканирование прервано из-за ошибки" вместо
// нормального скана) — при ошибке отвечаем "не знаю" и даём скану идти дальше.
export async function checkPricesVisible(categories, cookieJar) {
  for (const { slug } of categories) {
    try {
      const { lots } = await fetchCategoryPage(slug, 1);
      if (!lots.length) continue;
      const detail = await scrapeLotDetail(lots[0].id, cookieJar);
      return { visible: !detail.gated };
    } catch (err) {
      console.error(`Проверка доступа к ценам по разделу "${slug}" не удалась:`, err.message);
    }
  }
  return { visible: null }; // проверить не получилось — считаем "неизвестно" и идём сканировать
}

// Пауза между запросами к fajans.lv у КАЖДОГО параллельного воркера. Вместе с
// DETAIL_CONCURRENCY это и задаёт итоговый темп обращений к сайту: 3 воркера с
// паузой 0.5-0.8с дают примерно 3 запроса/сек. Если fajans.lv когда-нибудь начнёт
// ругаться на нагрузку — крутить надо эти две константы (меньше воркеров и/или
// больше пауза), больше нигде темп не задаётся.
const defaultPoliteWait = () => new Promise((r) => setTimeout(r, 500 + Math.random() * 300));

// Списки лотов по разделам тянем по несколько разделов сразу — это самая быстрая
// фаза (23 раздела, ~120 страниц), и последовательно она тратила впустую полторы минуты.
const LIST_CONCURRENCY = 3;

// Страницы отдельных лотов — самая долгая фаза (~2700 запросов). Раньше они шли
// строго по одному, и скан всех разделов занимал ~50 минут; сама эта длительность
// и была причиной, по которой бот успевал набить флуд-бан Telegram и выглядел
// "умершим". С 3 воркерами это ~15 минут при том же суммарном числе запросов к сайту.
const DETAIL_CONCURRENCY = 3;

// Сколько лотов оцениваем через ИИ одновременно. Один запрос к vision-модели идёт
// 3-8 секунд, поэтому при прежних 5 потоках именно ИИ, а не скрапинг, определял
// длительность первого скана (~30 минут на 2700 лотов). С 8 потоками ИИ примерно
// поспевает за скрапингом, а повторные сканы почти целиком берут оценки из кэша.
const AI_CONCURRENCY = 8;

// Насколько далеко скрапинг может убежать вперёд от ИИ-оценок. Без этого лимита
// при медленном ИИ в памяти копились бы тысячи невыполненных задач вместе с
// описаниями лотов — на сервере с 961 МБ RAM и без swap это прямой путь к тому,
// чтобы процесс убил OOM-killer. Дойдя до лимита, скрапинг просто ждёт, пока ИИ
// разгребёт очередь.
const MAX_AI_BACKLOG = 150;

// Простой пул с ограничением параллелизма.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    // try/catch — на случай задачи, которая бросит СИНХРОННО (не вернув promise):
    // без него счётчик active остался бы навсегда завышенным, и после нескольких
    // таких задач пул встал бы намертво вместе со всем сканом.
    let promise;
    try {
      promise = Promise.resolve(task());
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(resolve, reject).finally(() => {
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
 *
 * categories: [{ slug, name }, ...]
 * cookieJar: из loginAndGetSession (или {} для гостевого режима без цены)
 * options.politeWait: пауза каждого воркера между запросами к fajans.lv (по умолчанию 500-800мс)
 * options.listConcurrency / options.detailConcurrency: сколько запросов к fajans.lv параллельно
 * options.aiConcurrency: сколько лотов оценивать через ИИ одновременно (по умолчанию 6)
 * options.onProgress: колбэк({ stage: "listing"|"scanning", ... }) для статуса в боте/консоли.
 *   ВАЖНО: стадия ровно одна на всю долгую часть скана ("scanning") и несёт в себе
 *   сразу и прогресс скрапинга, и прогресс ИИ. Раньше стадий было две ("detail" и
 *   "appraising"), они шли вперемешку, и троттлинг на стороне бота, который
 *   сбрасывался при смене стадии, оказывался полностью бесполезен — бот отправлял
 *   ~2 правки сообщения в секунду и ловил флуд-бан Telegram на 20+ минут.
 * options.isCancelled: функция () => boolean — проверяется между запросами; при true
 *   обход останавливается досрочно (уже запущенные оценки ИИ доигрываются до конца)
 * options.relogin: необязательная async-функция () => cookieJar|null. Вызывается один
 *   раз, если посреди скана сессия fajans.lv перестала видеть цены: раньше такой скан
 *   просто обрывался с неполным результатом, теперь есть шанс перелогиниться и доехать.
 *
 * Возвращает { deals, scanned, priced, found, failed, cached, gatedMidScan, aiUnavailable },
 * где deals — лоты, прошедшие фильтр "аукционная цена минимум в 3 раза меньше рыночной,
 * и разница — не меньше минимального порога для раздела" (порог по умолчанию 100€, но
 * для некоторых разделов другой — см. getMinDiffForCategories в ai-appraisal.mjs), с
 * добавленными полями marketPrice/aiComment.
 * scanned — сколько страниц лотов удалось забрать, priced — у скольких из них была видна
 * цена (без цены лот не оценивается), failed — сколько запросов не удалось, cached —
 * сколько оценок взяли из кэша вместо обращения к ИИ.
 * gatedMidScan: true значит, что скан прервался досрочно из-за потери доступа к ценам
 * (см. GATED_WINDOW ниже). aiUnavailable: true значит, что скан прервался из-за того,
 * что ИИ перестал отвечать (лимит/баланс у провайдера либо затяжная серия отказов).
 * В обоих случаях результат может быть неполным.
 */
export async function scrapeCategories(categories, cookieJar, options = {}) {
  const politeWait = options.politeWait || defaultPoliteWait;
  const onProgress = options.onProgress || (() => {});
  const isCancelled = options.isCancelled || (() => false);
  const relogin = options.relogin || null;
  const listLimit = createLimiter(options.listConcurrency || LIST_CONCURRENCY);
  const detailLimit = createLimiter(options.detailConcurrency || DETAIL_CONCURRENCY);
  const aiLimit = createLimiter(options.aiConcurrency || AI_CONCURRENCY);
  const maxAiBacklog = options.maxAiBacklog || MAX_AI_BACKLOG;

  // Сессия может обновиться посреди скана (см. relogin ниже), поэтому держим её
  // в изменяемой переменной, а не читаем аргумент напрямую.
  let jar = cookieJar;

  // Общий флаг досрочной остановки: потеря доступа к ценам или отвалившийся ИИ.
  // Задачи в пуле проверяют его и мгновенно выходят, поэтому остановка не ждёт,
  // пока прокрутится вся очередь.
  let stop = false;

  // ---------- фаза 1: списки лотов по разделам ----------

  // Один лот может относиться сразу к нескольким нужным нам разделам (например,
  // статуэтка из фарфора попадает и в "Фарфор", и в "Статуэтки") — дедуплицируем
  // по id, объединяя названия разделов через " / " вместо дублей в выдаче.
  const lotsById = new Map();
  // Разделы теперь обходятся параллельно, поэтому порядок, в котором лот узнаёт о
  // своих разделах, стал непредсказуемым. Для getMinDiffForCategories это важно
  // (он берёт порог ПЕРВОГО совпавшего спецраздела), да и выдача не должна
  // тасоваться между сканами — приводим всё к порядку из CATEGORIES.
  const categoryOrder = new Map(categories.map((c, i) => [c.name, i]));
  let categoriesDone = 0;
  let listingErrors = 0;

  const emitListingProgress = () =>
    onProgress({ stage: "listing", done: categoriesDone, total: categories.length, lots: lotsById.size });

  await Promise.all(
    categories.map(({ slug, name }) =>
      listLimit(async () => {
        let totalPages = 1;
        for (let page = 1; page <= totalPages; page++) {
          if (isCancelled()) return;
          let pageData;
          try {
            pageData = await fetchCategoryPage(slug, page);
          } catch (err) {
            // Раньше сбой на любой странице любого раздела ронял весь скан целиком.
            // Теперь теряем только этот раздел (о чём пишем в лог) и идём дальше.
            listingErrors++;
            console.error(`Не удалось получить страницу ${page} раздела "${name}":`, err.message);
            break;
          }
          totalPages = pageData.totalPages;
          for (const lot of pageData.lots) {
            const existing = lotsById.get(lot.id);
            if (existing) {
              if (!existing.categories.includes(name)) existing.categories.push(name);
            } else {
              lotsById.set(lot.id, { ...lot, categories: [name] });
            }
          }
          emitListingProgress();
          await politeWait();
        }
        categoriesDone++;
        emitListingProgress();
      })
    )
  );

  if (!lotsById.size && listingErrors) {
    // Ни одного лота и при этом были сетевые ошибки — это не "аукцион пуст", а
    // недоступный сайт. Сообщаем честной ошибкой, а не бодрым "найдено 0 лотов".
    throw new Error("не удалось получить списки лотов ни по одному разделу — похоже, fajans.lv недоступен");
  }

  const allLots = [...lotsById.values()];
  for (const lot of allLots) {
    lot.categories.sort((a, b) => categoryOrder.get(a) - categoryOrder.get(b));
  }
  // Стабильный порядок обхода и выдачи: как в списке разделов, а внутри раздела —
  // от свежих лотов к старым.
  allLots.sort(
    (a, b) =>
      categoryOrder.get(a.categories[0]) - categoryOrder.get(b.categories[0]) || Number(b.id) - Number(a.id)
  );
  allLots.forEach((lot, i) => {
    lot.order = i;
  });

  // ---------- фаза 2: детали лотов + оценка ИИ параллельно ----------

  const deals = [];
  const pendingAppraisals = [];
  let aiDispatched = 0;
  let aiDone = 0;
  let cacheHits = 0;

  // Клиент может в будущем сменить провайдера ИИ — у каждого свой формат ошибки на
  // исчерпанный лимит/баланс, и все заранее не предусмотришь. Поэтому кроме точечного
  // распознавания уже известного формата (polza.ai, см. ai-appraisal.mjs) держим и
  // универсальный детектор затяжного отказа.
  //
  // Важно, что счётчик отказов ОБЩИЙ на все параллельные запросы: короткого сетевого
  // сбоя хватало, чтобы 5-6 запросов "в полёте" провалились подряд и добили старый
  // порог в 8, после чего скан обрывался на середине из-за ерунды. Поэтому теперь
  // требуется не только серия отказов, но и отсутствие хотя бы одного успеха в
  // течение AI_FAILURE_SILENCE_MS — сетевой blip такое условие не выполняет, а
  // реально умерший ключ выполняет сразу.
  const AI_FAILURE_STREAK_LIMIT = 12;
  const AI_FAILURE_SILENCE_MS = 3 * 60 * 1000;
  let consecutiveAiFailures = 0;
  let lastAiSuccessAt = Date.now();
  let aiUnavailable = false;

  // Скан всех разделов идёт долго — если сессия fajans.lv протухнет посреди него,
  // каждый следующий лот молча вернётся с gated:true (цена скрыта), и без этой
  // проверки скан бы тихо доехал до конца с сильно неполным результатом, не
  // предупредив, что что-то сломалось. Раньше считались строго идущие подряд
  // gated-лоты, но при параллельном обходе "подряд" — понятие условное, поэтому
  // смотрим на скользящее окно последних результатов: все gated — значит доступ к
  // ценам действительно потерян, а не попался отдельный странный лот.
  const GATED_WINDOW = 8;
  const RELOGIN_LIMIT = 3;
  const gatedWindow = [];
  let gatedMidScan = false;
  let reloginPromise = null;
  let reloginAttempts = 0;

  let scanned = 0;
  let priced = 0;
  let failed = 0;
  let detailDone = 0;

  const emitScanProgress = () =>
    onProgress({
      stage: "scanning",
      index: detailDone,
      total: allLots.length,
      aiDone,
      aiTotal: aiDispatched,
      cached: cacheHits,
    });

  function queueAppraisal(lot, minDiff) {
    if (aiUnavailable || stop) return;

    // Лот уже оценивали в прошлый раз, и с тех пор его на сайте не редактировали —
    // берём оценку из кэша, но фильтр считаем по СВЕЖЕЙ цене (она-то как раз
    // меняется от скана к скану). Если название/описание/фото изменились,
    // fingerprint не совпадёт и лот уйдёт на переоценку (см. ai-cache.mjs).
    const fingerprint = fingerprintLot(lot);
    const cached = getCachedAppraisal(lot.id, fingerprint);
    if (cached) {
      cacheHits++;
      if (passesDealFilter(lot.price, cached.marketPrice, minDiff)) {
        deals.push({ ...lot, marketPrice: cached.marketPrice, aiComment: cached.comment });
      }
      return;
    }

    aiDispatched++;
    pendingAppraisals.push(
      aiLimit(async () => {
        // Задача могла простоять в очереди, пока ИИ отвалился или пользователь
        // нажал "Отменить" — тогда запрос уже не нужен. Без этой проверки отмена
        // ждала, пока догорит вся накопленная очередь оценок (до полутора минут),
        // и выглядела как "кнопка не работает".
        if (aiUnavailable || isCancelled()) {
          aiDone++;
          return;
        }
        try {
          const { marketPrice, comment } = await appraiseLot({
            title: lot.title,
            description: lot.description,
            mainPhoto: lot.mainPhoto,
          });
          consecutiveAiFailures = 0;
          lastAiSuccessAt = Date.now();
          setCachedAppraisal(lot.id, fingerprint, marketPrice, comment);
          if (passesDealFilter(lot.price, marketPrice, minDiff)) {
            deals.push({ ...lot, marketPrice, aiComment: comment });
          }
        } catch (err) {
          if (err instanceof AIQuotaExceededError) {
            aiUnavailable = true; // известный формат — реагируем сразу же, без ожидания серии
            stop = true;
          } else {
            consecutiveAiFailures++;
            if (
              consecutiveAiFailures >= AI_FAILURE_STREAK_LIMIT &&
              Date.now() - lastAiSuccessAt >= AI_FAILURE_SILENCE_MS
            ) {
              aiUnavailable = true;
              stop = true;
            }
          }
          // Ошибку ИИ по одному лоту (кроме двух случаев выше) не считаем фатальной
          // для всего скана — просто пропускаем этот лот, как и при ошибках скрапинга.
        } finally {
          aiDone++;
          emitScanProgress();
        }
      })
    );
  }

  // Не даём скрапингу убежать от ИИ дальше, чем на maxAiBacklog необработанных лотов
  // (см. комментарий к MAX_AI_BACKLOG).
  async function waitForAiCapacity() {
    while (!stop && !isCancelled() && aiDispatched - aiDone > maxAiBacklog) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Все gated подряд в окне — либо сессия истекла, либо аккаунт потерял доступ.
  // Пробуем перелогиниться и только если не вышло — останавливаем скан с пометкой
  // gatedMidScan. Попыток даём несколько: скан длинный, и сессия за это время
  // вполне может истечь больше одного раза, а разрешив ровно одну попытку, мы бы
  // после второго истечения снова тихо доехали до конца с неполным результатом —
  // ровно тем молчаливым сбоем, от которого и защищаемся.
  //
  // Несколько лотов (по числу воркеров) после потери сессии успевают уйти в
  // пропуск — их запросы уже были в полёте со старыми куками. На фоне ~2700 лотов
  // это допустимая потеря, зато скан доезжает до конца.
  async function handleGateResult(isGated) {
    gatedWindow.push(isGated);
    if (gatedWindow.length > GATED_WINDOW) gatedWindow.shift();
    if (gatedWindow.length < GATED_WINDOW || !gatedWindow.every(Boolean)) return;

    // Перелогин уже идёт по инициативе другого воркера — просто ждём его.
    if (reloginPromise) {
      await reloginPromise;
      return;
    }
    if (!relogin || reloginAttempts >= RELOGIN_LIMIT) {
      gatedMidScan = true;
      stop = true;
      return;
    }

    reloginAttempts++;
    reloginPromise = (async () => {
      console.warn(
        `Цены перестали быть видны посреди скана — пробую перелогиниться на fajans.lv ` +
          `(попытка ${reloginAttempts} из ${RELOGIN_LIMIT}).`
      );
      try {
        const fresh = await relogin();
        if (fresh) {
          jar = fresh;
          gatedWindow.length = 0;
          console.warn("Перелогин удался, продолжаю скан.");
          return;
        }
        console.error("Перелогин не удался (сайт не принял логин/пароль) — останавливаю скан.");
      } catch (err) {
        console.error("Перелогин не удался:", err.message);
      }
      gatedMidScan = true;
      stop = true;
    })();

    try {
      await reloginPromise;
    } finally {
      // Обнуляем, чтобы следующая потеря сессии тоже смогла запустить перелогин.
      reloginPromise = null;
    }
  }

  async function processLot(lot) {
    if (stop || isCancelled()) return;
    await waitForAiCapacity();
    if (stop || isCancelled()) return;

    try {
      const detail = await scrapeLotDetail(lot.id, jar);
      scanned++;
      await handleGateResult(detail.gated);
      if (!detail.gated) {
        priced++;
        queueAppraisal(
          {
            id: lot.id,
            order: lot.order,
            category: lot.categories.join(" / "),
            title: lot.title,
            mainPhoto: detail.mainPhoto,
            price: detail.price,
            description: detail.description,
          },
          getMinDiffForCategories(lot.categories)
        );
      }
    } catch {
      // Ошибку скрапинга одного лота не считаем фатальной — просто пропускаем его.
      failed++;
    }
    detailDone++;
    emitScanProgress();
    if (!stop && !isCancelled()) await politeWait();
  }

  await Promise.all(allLots.map((lot) => detailLimit(() => processLot(lot))));

  // Скрапинг деталей идёт с неспешным политвейтом, а ИИ-оценки — параллельно ему,
  // так что к этому моменту почти всё уже оценено; здесь лишь донидаем хвост.
  await Promise.all(pendingAppraisals);
  saveAiCache();

  // Стабильный порядок выдачи (раньше зависел от того, в каком порядке ответил ИИ,
  // то есть был случайным), плюс выкидываем description — он нужен только для
  // запроса к ИИ, а в результатах занимает место в памяти и в last-scan.json.
  deals.sort((a, b) => a.order - b.order);
  const cleanDeals = deals.map(({ order, description, ...rest }) => rest);

  return {
    deals: cleanDeals,
    scanned,
    priced,
    found: allLots.length,
    failed,
    cached: cacheHits,
    gatedMidScan,
    aiUnavailable,
  };
}
