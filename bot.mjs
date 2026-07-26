import "dotenv/config";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { run } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { CATEGORIES } from "./src/categories.mjs";
import { scrapeCategories, checkPricesVisible } from "./src/scrape-core.mjs";
import { loginAndGetSession } from "./src/fajans-auth.mjs";
import { getAccountOverride, setAccountOverride, clearAccountOverride } from "./src/account-store.mjs";
import { saveLastResults, loadLastResults } from "./src/results-store.mjs";
import { saveAiCache } from "./src/ai-cache.mjs";

if (!process.env.BOT_TOKEN) {
  console.error("В .env не задан BOT_TOKEN — получите токен у @BotFather в Telegram и впишите его в .env");
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

// autoRetry: при 429 Too Many Requests Telegram присылает retry_after, и раньше
// такой запрос просто терялся вместе с сообщением (именно так до клиента не
// доходил финальный отчёт о сканировании). Теперь grammy сам подождёт и повторит.
// maxDelaySeconds ограничивает ожидание минутой: если Telegram затыкает бота на
// 20 минут, ждать столько внутри запроса бессмысленно — лучше отдать ошибку,
// увидеть её в логе и разбираться с причиной.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

// apiThrottler — страховка от флуд-бана на будущее: сам по себе выдерживает лимит
// Telegram (~1 запрос в секунду на чат) и ставит лишние вызовы в очередь вместо
// того, чтобы получать по ним 429. Даже если в коде когда-нибудь снова появится
// место, которое спамит сообщениями, до бана дело уже не дойдёт.
bot.api.config.use(apiThrottler());

// Сколько разделов показывать на одной странице инлайн-клавиатуры выбора
// демо-раздела — весь список (23 штуки) не влезет в один экран без пролистывания.
const DEMO_PAGE_SIZE = 8;

const SCAN_ALL_LABEL = "🔎 Сканировать";
const DEMO_LABEL = "🧪 Демо-тест категории";
const SHOW_LAST_LABEL = "📋 Результаты последнего сканирования";
const ACCOUNT_LABEL = "👤 Сменить аккаунт";
const CHANGE_CREDS_LABEL = "✏️ Сменить логин и пароль";
const RESET_ACCOUNT_LABEL = "↩️ Поставить аккаунт по умолчанию";
const BACK_LABEL = "⬅️ Назад";
const CANCEL_ACCOUNT_LABEL = "❌ Отмена";
const CANCEL_LABEL = "❌ Отменить сканирование";

// Состояние экрана на чат: какое reply-меню сейчас показано, id последнего
// служебного сообщения бота (чтобы удалять его перед показом следующего экрана)
// и pendingUsername — логин, введённый на предыдущем шаге смены аккаунта,
// пока ждём пароль вторым сообщением.
const uiState = new Map(); // chatId -> { mode, lastMessageId, pendingUsername }
// Флаги отмены для запущенных сканирований. Заодно служит признаком "в этом чате
// скан уже идёт" — второй одновременный скан не запускается (см. startAnalysis).
const runningScans = new Map(); // chatId -> { cancelled: boolean }
// Результаты последнего анализа: { groups } — groups: [[categoryName, lots[]], ...].
const sessions = new Map();

// --- логирование ---

// grammy кладёт в объект ошибки (BotError) весь ctx, а внутри ctx лежит
// ctx.api.token — из-за этого console.error(err) целиком выписывал BOT_TOKEN в
// открытом виде в лог pm2, который читает любой, у кого есть доступ к серверу.
// Поэтому: (1) логируем только осмысленные поля ошибки, а не объект целиком,
// (2) на всякий случай прогоняем всё, что уходит в лог и в чат, через scrub().
const TOKEN = process.env.BOT_TOKEN;
function scrub(text) {
  const s = String(text ?? "");
  return TOKEN ? s.split(TOKEN).join("<BOT_TOKEN>") : s;
}

function describeError(err) {
  const e = err?.error ?? err;
  const parts = [scrub(e?.description || e?.message || e)];
  if (e?.error_code === 429) {
    parts.push(`(429 Too Many Requests, retry_after=${e?.parameters?.retry_after ?? "?"}с)`);
  } else if (e?.error_code) {
    parts.push(`(код ${e.error_code})`);
  }
  return parts.join(" ");
}

function logError(prefix, err) {
  console.error(`${prefix}: ${describeError(err)}`);
  const stack = (err?.error ?? err)?.stack;
  if (stack) console.error(scrub(stack).split("\n").slice(1, 4).join("\n"));
}

// --- сторожевой таймер ---

// Страховка на случай зависания скана по ЛЮБОЙ непредвиденной причине (сеть,
// сторонний сервис, что угодно, что мы не предусмотрели явно). Пока идёт скан,
// каждое событие прогресса обновляет отметку времени по своему чату; если
// прогресса нет дольше STALL_TIMEOUT_MS — считаем процесс зависшим, пишем об
// этом в чат и завершаемся, чтобы pm2 перезапустил бота начисто.
//
// Отметки лежат в Map по чатам, а не в двух глобальных переменных: с
// глобальными второй запущенный скан затирал отметку первого, а тот из них,
// который заканчивался раньше, вообще выключал сторожа для всё ещё
// работающего скана.
const STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут без прогресса
const watchdogs = new Map(); // chatId -> время последнего события прогресса

function watchdogTouch(chatId) {
  watchdogs.set(chatId, Date.now());
}
function watchdogEnd(chatId) {
  watchdogs.delete(chatId);
}

setInterval(() => {
  const now = Date.now();
  for (const [chatId, lastProgressAt] of watchdogs) {
    if (now - lastProgressAt < STALL_TIMEOUT_MS) continue;
    const minutes = STALL_TIMEOUT_MS / 60000;
    console.error(`Скан завис (нет прогресса дольше ${minutes} минут) — перезапускаю процесс.`);
    saveAiCache(); // не теряем уже сделанные ИИ-оценки
    // Ждём отправки предупреждения, но не дольше 10 секунд — перезапуститься
    // нужно в любом случае.
    setTimeout(() => process.exit(1), 10000).unref();
    bot.api
      .sendMessage(
        chatId,
        `⚠️ Сканирование зависло (нет прогресса больше ${minutes} минут) — перезапускаю бота. ` +
          "Через минуту попробуйте запустить сканирование заново."
      )
      .catch(() => {}) // не получилось отправить — не страшно, перезапускаемся в любом случае
      .then(() => process.exit(1));
    return;
  }
}, 60000);

function getState(chatId) {
  if (!uiState.has(chatId)) uiState.set(chatId, { mode: "main", lastMessageId: null });
  return uiState.get(chatId);
}

// Удаляет предыдущее служебное сообщение бота и присылает новое вместо него —
// именно так теперь визуально обновляется и главное меню, и список разделов
// (обычные reply-клавиатуры нельзя отредактировать на месте, как inline).
async function showScreen(ctx, chatId, text, keyboard) {
  const state = getState(chatId);
  if (state.lastMessageId) {
    try {
      await ctx.api.deleteMessage(chatId, state.lastMessageId);
    } catch {
      // сообщение уже могло быть удалено вручную или устарело — не страшно
    }
  }
  const sent = await ctx.reply(text, { reply_markup: keyboard });
  state.lastMessageId = sent.message_id;
  return sent;
}

function mainKeyboard() {
  return new Keyboard()
    .text(SCAN_ALL_LABEL).row()
    .text(DEMO_LABEL).row()
    .text(SHOW_LAST_LABEL).row()
    .text(ACCOUNT_LABEL)
    .resized();
}

function accountMenuKeyboard() {
  return new Keyboard()
    .text(CHANGE_CREDS_LABEL).row()
    .text(RESET_ACCOUNT_LABEL).row()
    .text(BACK_LABEL)
    .resized();
}

function cancelAccountKeyboard() {
  return new Keyboard().text(CANCEL_ACCOUNT_LABEL).resized();
}

function cancelKeyboard() {
  return new Keyboard().text(CANCEL_LABEL).resized();
}

// Список разделов постранично — по кнопке на раздел плюс листалка внизу,
// чтобы не вываливать все 23 раздела разом в один экран.
function demoCategoryKeyboard(page) {
  const totalPages = Math.ceil(CATEGORIES.length / DEMO_PAGE_SIZE);
  const start = page * DEMO_PAGE_SIZE;
  const kb = new InlineKeyboard();
  CATEGORIES.slice(start, start + DEMO_PAGE_SIZE).forEach((cat) => {
    kb.text(cat.name, `demorun:${cat.slug}`).row();
  });
  kb.text("◀️", `demopage:${page - 1}`)
    .text(`${page + 1}/${totalPages}`, "noop")
    .text("▶️", `demopage:${page + 1}`);
  return kb;
}

// Telegram не переносит текст кнопки на новую строку, а обрезает его —
// длинные комбинации разделов (лот попал сразу в несколько категорий) иначе
// обрезаются некрасиво посреди слова. Самое длинное ОДНО название раздела —
// 46 символов, так что порог чуть выше режет только составные комбинации.
function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

// Группирует отобранные лоты по разделу (как их вернул скрапинг — лот,
// подошедший сразу под несколько разделов, попадёт в свою комбинированную
// группу, а не задвоится в каждом разделе по отдельности): [[categoryName, lots[]], ...]
function groupDealsByCategory(deals) {
  const groupsMap = new Map();
  for (const lot of deals) {
    if (!groupsMap.has(lot.category)) groupsMap.set(lot.category, []);
    groupsMap.get(lot.category).push(lot);
  }
  return [...groupsMap.entries()];
}

// groups: [[categoryName, lots[]], ...] — по кнопке на раздел, с количеством
// отобранных ИИ лотов в каждом.
function categoriesInlineKeyboard(groups) {
  const kb = new InlineKeyboard();
  groups.forEach(([name, lots], i) => {
    kb.text(`${truncate(name, 48)} (${lots.length})`, `cat:${i}`).row();
  });
  return kb;
}

function browseKeyboard(catIndex, index, total) {
  return new InlineKeyboard()
    .text("◀️", `browse:${catIndex}:${index - 1}`)
    .text(`${index + 1}/${total}`, "noop")
    .text("▶️", `browse:${catIndex}:${index + 1}`)
    .row()
    .text("⬅️ К разделам", "back");
}

// Telegram ограничивает подпись к фото 1024 символами (это меньше, чем 4096
// для обычных текстовых сообщений) — при длинном названии лота и подробном
// комментарии ИИ реальный текст мог превысить лимит, и Telegram отклонял
// отправку фото целиком. Подрезаем с запасом, чтобы это не случалось.
const CAPTION_MAX = 1000;

function formatLot(lot) {
  const price = lot.price != null ? `${lot.price} €` : "цена скрыта";
  const market = lot.marketPrice != null ? `${lot.marketPrice} €` : "?";
  const comment = lot.aiComment ? `\n💬 ${lot.aiComment}` : "";
  const text = `#${lot.id} [${lot.category}]\n${lot.title}\nЦена на аукционе: ${price}\nРыночная цена (оценка ИИ): ${market}${comment}\nhttps://www.fajans.lv/ru/auction/${lot.id}`;
  // Режем по границе слова, а не посреди него.
  return text.length > CAPTION_MAX ? text.slice(0, CAPTION_MAX - 1).replace(/\s+\S*$/, "") + "…" : text;
}

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  // /start посреди скана раньше сбрасывал режим в "main", и следующим нажатием
  // «Сканировать» клиент запускал ВТОРОЙ скан параллельно первому — двойная
  // нагрузка на fajans.lv, двойной поток правок в Telegram и потерянный токен
  // отмены первого скана. Теперь во время скана режим не трогаем.
  if (runningScans.has(chatId)) {
    await ctx.reply(
      `Сейчас идёт сканирование — дождитесь его окончания или нажмите «${CANCEL_LABEL}», чтобы остановить.`
    );
    return;
  }
  state.mode = "main";
  await showScreen(
    ctx,
    chatId,
    "Привет! Это бот-мониторинг лотов fajans.lv.\n\n" +
      `«${SCAN_ALL_LABEL}» — проанализировать ИИ все разделы аукциона.\n` +
      `«${DEMO_LABEL}» — быстрый тестовый прогон по одному разделу на выбор.\n` +
      `«${ACCOUNT_LABEL}» — использовать свой аккаунт fajans.lv вместо стандартного.`,
    mainKeyboard()
  );
});

async function finishScanning(ctx, chatId, text) {
  const state = getState(chatId);
  state.mode = "main";
  await showScreen(ctx, chatId, text, mainKeyboard());
}

// Одна строка статуса на ВСЕ стадии скана. Раньше строк было три (список /
// детали / оценка ИИ), стадии чередовались, и троттлинг, который сбрасывался
// при смене стадии, не работал вообще: бот отправлял ~2 правки в секунду и
// получал от Telegram флуд-бан на 20+ минут — именно это клиент видел как
// "бот умер и перестал отвечать".
function renderProgress(p) {
  if (p.stage === "listing") {
    return `Собираю списки лотов: раздел ${p.done}/${p.total}, найдено — ${p.lots}`;
  }
  const parts = [`Обрабатываю лоты: ${p.index}/${p.total}`];
  if (p.aiTotal) parts.push(`оценка ИИ: ${p.aiDone}/${p.aiTotal}`);
  if (p.cached) parts.push(`из кэша: ${p.cached}`);
  return parts.join(" · ");
}

// Лимит Telegram — примерно 1 сообщение в секунду на чат, а скан длится десятки
// минут, так что правка раз в 5 секунд — единственный безопасный режим (это ~180
// правок за скан вместо прежних ~5500).
const PROGRESS_MIN_INTERVAL_MS = 5000;

function scanSummary(result, wasCancelled) {
  const head = wasCancelled
    ? `Сканирование отменено. Успело обработаться ${result.scanned} лотов из ${result.found}`
    : `Готово! Обработано ${result.scanned} лотов`;
  const lines = [`${head}, из них подходящих по цене — ${result.deals.length}.`];

  const notes = [];
  if (result.cached) notes.push(`${result.cached} оценок взято из кэша (без запроса к ИИ)`);
  const hidden = result.scanned - result.priced;
  if (hidden > 0) notes.push(`у ${hidden} лотов цена была скрыта`);
  if (result.failed) notes.push(`${result.failed} лотов не открылись`);
  if (notes.length) lines.push(notes.join(", ") + ".");

  return lines.join("\n");
}

// Обёртка над сканом: гарантирует, что чат вернётся в рабочее состояние ЧТО БЫ НИ
// СЛУЧИЛОСЬ. Раньше здесь был try/finally без catch, и любая ошибка Telegram-API
// (например, отказ отправить финальное сообщение из-за флуд-бана) оставляла чат
// в режиме "scanning" навсегда: обработчик текста в этом режиме молча игнорирует
// всё, кроме кнопки отмены, поэтому бот выглядел полностью мёртвым.
async function startAnalysis(ctx, chatId, categories) {
  if (runningScans.has(chatId)) {
    await ctx.reply(`Сканирование уже идёт — дождитесь окончания или нажмите «${CANCEL_LABEL}».`);
    return;
  }

  const state = getState(chatId);
  const cancelToken = { cancelled: false };
  runningScans.set(chatId, cancelToken);
  state.mode = "scanning";
  watchdogTouch(chatId);

  try {
    await runScan(ctx, chatId, categories, cancelToken);
  } catch (err) {
    logError("Сканирование прервано ошибкой", err);
    try {
      await finishScanning(ctx, chatId, `Сканирование прервано из-за ошибки: ${scrub(err?.message)}`);
    } catch (replyErr) {
      logError("Не удалось сообщить в чат об ошибке сканирования", replyErr);
    }
  } finally {
    runningScans.delete(chatId);
    watchdogEnd(chatId);
    state.mode = "main";
    saveAiCache();
  }
}

async function runScan(ctx, chatId, categories, cancelToken) {
  // При скане всех категорий список из 23 названий в чате только мешает —
  // пишем просто "по всем категориям". Для демо-теста (один раздел) название
  // всё же полезно показать, чтобы было видно, что за раздел проверяется.
  const startText = categories.length > 1
    ? `Начинаю сканирование по всем категориям.\n\n(нажмите «${CANCEL_LABEL}», чтобы остановить)`
    : `Начинаю сканирование раздела: ${categories[0].name}.\n\n(нажмите «${CANCEL_LABEL}», чтобы остановить)`;

  await showScreen(ctx, chatId, startText, cancelKeyboard());

  // Статус прогресса шлём отдельным обычным сообщением, а не правкой того,
  // что показывает кнопку отмены: Telegram запрещает редактировать текст
  // сообщения, отправленного вместе с ReplyKeyboardMarkup — editMessageText
  // на такое сообщение стабильно падает с 400 "message can't be edited".
  const progressMsg = await ctx.reply("Собираю данные...");
  const progressMessageId = progressMsg.message_id;
  const clearProgress = () => ctx.api.deleteMessage(chatId, progressMessageId).catch(() => {});

  // Свой аккаунт (если клиент его задал через "Сменить аккаунт") приоритетнее
  // дефолтного из .env — так у каждого чата может быть свой fajans.lv-логин.
  const override = getAccountOverride(chatId);
  const FAJANS_USER = override?.username ?? process.env.FAJANS_USER;
  const FAJANS_PASS = override?.password ?? process.env.FAJANS_PASS;
  const { API_KEY } = process.env;
  if (!FAJANS_USER || !FAJANS_PASS) {
    await clearProgress();
    await finishScanning(ctx, chatId, "В .env не заданы FAJANS_USER / FAJANS_PASS.");
    return;
  }
  if (!API_KEY) {
    await clearProgress();
    await finishScanning(ctx, chatId, "В .env не задан API_KEY (ключ для оценки ИИ через polza.ai).");
    return;
  }

  const login = await loginAndGetSession(FAJANS_USER, FAJANS_PASS);
  if (!login.success) {
    await clearProgress();
    await finishScanning(ctx, chatId, "Не удалось залогиниться на fajans.lv.");
    return;
  }

  // Аккаунт может формально залогиниться (куки, редирект), но при этом не
  // видеть цены — например, если он не прошёл модерацию на сайте. Раньше
  // это тихо приводило к "0 сделок найдено" без объяснений: скан проходил
  // весь список лотов, а фильтр молча пропускал их все из-за отсутствия
  // цены. Поэтому проверяем доступ к ценам ДО полного скана.
  const access = await checkPricesVisible(categories, login.cookieJar);
  if (access.visible === false) {
    await clearProgress();
    await finishScanning(
      ctx,
      chatId,
      `Аккаунт ${FAJANS_USER} залогинился, но не видит цены на лотах (сайт показывает "Только зарегистрированные пользователи могут принять участие в торгах"). ` +
        "Возможно, аккаунт не прошёл модерацию на fajans.lv — проверьте его статус на сайте или замените аккаунт."
    );
    return;
  }

  let lastEditAt = 0;
  let lastProgressText = null;
  let editInFlight = false;

  const result = await scrapeCategories(categories, login.cookieJar, {
    isCancelled: () => cancelToken.cancelled,
    // Скан идёт долго, и сессия fajans.lv может успеть истечь — тогда скрапер
    // просит перелогиниться вместо того, чтобы оборвать скан с неполным результатом.
    relogin: async () => {
      const fresh = await loginAndGetSession(FAJANS_USER, FAJANS_PASS);
      return fresh.success ? fresh.cookieJar : null;
    },
    async onProgress(p) {
      watchdogTouch(chatId); // отмечаем сразу, до троттлинга UI ниже
      const text = renderProgress(p);
      // Правка тем же текстом Telegram всё равно отклоняется ошибкой — не тратим на неё запрос.
      if (text === lastProgressText) return;
      if (Date.now() - lastEditAt < PROGRESS_MIN_INTERVAL_MS) return;
      // Предыдущая правка ещё не доехала (Telegram тормозит или ждёт retry_after) —
      // не копим очередь запросов, пропускаем этот тик.
      if (editInFlight) return;

      lastEditAt = Date.now();
      lastProgressText = text;
      editInFlight = true;
      try {
        await ctx.api.editMessageText(chatId, progressMessageId, text);
      } catch (err) {
        // Раньше здесь стоял пустой catch {}, и он молча съедал сотни ошибок 429 —
        // из-за этого настоящая причина ("бот сам загнал себя во флуд-бан") вообще
        // не была видна в логах. Теперь всё, кроме безобидного "message is not
        // modified", попадает в лог.
        const e = err?.error ?? err;
        if (!/message is not modified/i.test(e?.description ?? "")) {
          logError("Не удалось обновить сообщение с прогрессом", err);
        }
      } finally {
        editInFlight = false;
      }
    },
  });

  await clearProgress();

  const groups = groupDealsByCategory(result.deals);
  sessions.set(chatId, { groups });
  // Один клиент, один аукцион — сохраняем на диск, чтобы отдать эти же
  // результаты повторно по кнопке "Показать результаты последнего сканирования",
  // даже после перезапуска бота.
  try {
    saveLastResults(groups);
  } catch (err) {
    // Не смогли записать файл — результаты всё равно уже в памяти чата, так что
    // просто пишем в лог и продолжаем.
    logError("Не удалось сохранить результаты сканирования на диск", err);
  }

  const gatedNote = result.gatedMidScan
    ? "\n\n⚠️ Скан прервался раньше времени: аккаунт перестал видеть цены и перелогиниться не удалось. Результат может быть неполным — попробуйте сканировать заново."
    : result.aiUnavailable
    ? "\n\n⚠️ Скан прервался раньше времени: ИИ перестал отвечать (закончился лимит или баланс по ключу). Результат может быть неполным — проверьте ключ ИИ у своего поставщика и попробуйте позже."
    : "";

  await finishScanning(ctx, chatId, scanSummary(result, cancelToken.cancelled) + gatedNote);

  if (groups.length) {
    await ctx.reply("Выберите раздел, чтобы посмотреть отобранные лоты:", {
      reply_markup: categoriesInlineKeyboard(groups),
    });
  }
}

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const state = getState(chatId);

  if (state.mode === "main") {
    if (text === SCAN_ALL_LABEL) {
      await startAnalysis(ctx, chatId, CATEGORIES);
      return;
    }
    if (text === DEMO_LABEL) {
      await ctx.reply("Выберите раздел для демо-теста:", { reply_markup: demoCategoryKeyboard(0) });
      return;
    }
    if (text === SHOW_LAST_LABEL) {
      const groups = loadLastResults();
      if (!groups || !groups.length) {
        await ctx.reply("Пока нет сохранённых результатов — сначала запустите сканирование.");
        return;
      }
      sessions.set(chatId, { groups });
      await ctx.reply("Результаты последнего сканирования:", { reply_markup: categoriesInlineKeyboard(groups) });
      return;
    }
    if (text === ACCOUNT_LABEL) {
      state.mode = "account_menu";
      const override = getAccountOverride(chatId);
      const status = override
        ? `Сейчас используется свой аккаунт: ${override.username}`
        : "Сейчас используется аккаунт по умолчанию (прописан в .env в папке с кодом).";
      await showScreen(ctx, chatId, `${status}\n\nЧто сделать?`, accountMenuKeyboard());
      return;
    }
    // Любое другое сообщение — просто показываем меню заново. Это ещё и страховка:
    // если у клиента на экране осталась старая клавиатура (например, с кнопкой
    // отмены после сбоя), бот на любое нажатие ответит рабочим главным меню, а не
    // будет молчать.
    await showScreen(ctx, chatId, "Главное меню.", mainKeyboard());
    return;
  }

  if (state.mode === "account_menu") {
    if (text === CHANGE_CREDS_LABEL) {
      state.mode = "awaiting_username";
      await showScreen(ctx, chatId, "Пришлите логин (email) от аккаунта fajans.lv:", cancelAccountKeyboard());
      return;
    }
    if (text === RESET_ACCOUNT_LABEL) {
      clearAccountOverride(chatId);
      state.mode = "main";
      await showScreen(ctx, chatId, "Готово, снова используется аккаунт по умолчанию (из .env).", mainKeyboard());
      return;
    }
    if (text === BACK_LABEL) {
      state.mode = "main";
      await showScreen(ctx, chatId, "Главное меню.", mainKeyboard());
      return;
    }
    return;
  }

  if (state.mode === "awaiting_username") {
    if (text === CANCEL_ACCOUNT_LABEL) {
      state.mode = "main";
      await showScreen(ctx, chatId, "Отменено.", mainKeyboard());
      return;
    }
    state.pendingUsername = text.trim();
    state.mode = "awaiting_password";
    // Логин не такой чувствительный, как пароль, но тоже незачем оставлять в истории чата.
    await ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    await showScreen(ctx, chatId, "Теперь пришлите пароль:", cancelAccountKeyboard());
    return;
  }

  if (state.mode === "awaiting_password") {
    if (text === CANCEL_ACCOUNT_LABEL) {
      state.mode = "main";
      delete state.pendingUsername;
      await showScreen(ctx, chatId, "Отменено.", mainKeyboard());
      return;
    }

    const username = state.pendingUsername;
    const password = text.trim();
    delete state.pendingUsername;
    // Пароль тем более не должен оставаться в истории чата плейнтекстом.
    await ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});

    await ctx.reply("Проверяю логин и пароль на fajans.lv...");
    state.mode = "main";
    let login;
    try {
      login = await loginAndGetSession(username, password);
    } catch (err) {
      // Сеть могла отвалиться — раньше это исключение оставляло режим на
      // "awaiting_password", и следующее сообщение клиента бот принимал за пароль.
      logError("Проверка логина на fajans.lv не удалась", err);
      await showScreen(
        ctx,
        chatId,
        `Не получилось проверить логин (${scrub(err?.message)}). Аккаунт не изменён, попробуйте ещё раз.`,
        mainKeyboard()
      );
      return;
    }
    if (!login.success) {
      await showScreen(
        ctx,
        chatId,
        "Не удалось войти с этими данными — fajans.lv не принял логин/пароль. Аккаунт не изменён, остался прежний.",
        mainKeyboard()
      );
      return;
    }

    setAccountOverride(chatId, username, password);
    await showScreen(ctx, chatId, `Готово! Теперь используется аккаунт: ${username}`, mainKeyboard());
    return;
  }

  if (state.mode === "scanning") {
    if (text === CANCEL_LABEL) {
      const token = runningScans.get(chatId);
      if (token && !token.cancelled) {
        token.cancelled = true;
        await ctx.reply("Останавливаю сканирование, подождите...");
      } else {
        // Режим "scanning", а скана нет — значит он только что закончился, и
        // финальное сообщение вот-вот придёт. Молчать нельзя: клиент решит, что
        // бот мёртв.
        await ctx.reply("Сканирование уже завершается, подождите пару секунд.");
      }
    }
    return;
  }
});

bot.callbackQuery(/^demopage:(-?\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const totalPages = Math.ceil(CATEGORIES.length / DEMO_PAGE_SIZE);
  let page = Number(ctx.match[1]);
  if (page < 0) page = totalPages - 1;
  if (page >= totalPages) page = 0;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: demoCategoryKeyboard(page) });
  } catch {
    // клавиатура могла не измениться с прошлого раза (например, двойное нажатие
    // одной и той же стрелки) — Telegram в этом случае просто отдаёт ошибку, игнорируем
  }
});

bot.callbackQuery(/^demorun:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const category = CATEGORIES.find((c) => c.slug === ctx.match[1]);
  if (!category) return;
  // Инлайн-клавиатура демо-теста остаётся живой в истории чата навсегда, так что
  // сюда легко попасть посреди уже идущего скана — от второго параллельного скана
  // защищает проверка внутри startAnalysis.
  await startAnalysis(ctx, ctx.chat.id, [category]);
});

bot.callbackQuery(/^cat:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();
  const session = sessions.get(chatId);
  const group = session?.groups[Number(ctx.match[1])];
  if (!group) {
    await ctx.reply("Сначала запустите анализ.");
    return;
  }

  const catIndex = Number(ctx.match[1]);
  const [, lots] = group;
  const lot = lots[0];
  const caption = formatLot(lot);
  const keyboard = browseKeyboard(catIndex, 0, lots.length);

  try {
    await ctx.replyWithPhoto(lot.mainPhoto, { caption, reply_markup: keyboard });
  } catch (err) {
    await ctx.reply(`Не удалось показать фото лота #${lot.id}: ${scrub(err?.message)}`);
  }
});

bot.callbackQuery(/^browse:(\d+):(-?\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();
  const session = sessions.get(chatId);
  const catIndex = Number(ctx.match[1]);
  const group = session?.groups[catIndex];
  if (!group) {
    await ctx.reply("Сначала запустите анализ.");
    return;
  }

  const [, lots] = group;
  const total = lots.length;
  let index = Number(ctx.match[2]);
  if (index < 0) index = total - 1;
  if (index >= total) index = 0;

  const lot = lots[index];
  const caption = formatLot(lot);
  const keyboard = browseKeyboard(catIndex, index, total);

  try {
    if (ctx.callbackQuery.message.photo) {
      // уже показываем фото-сообщение — редактируем его на месте (вперёд/назад)
      await ctx.editMessageMedia({ type: "photo", media: lot.mainPhoto, caption }, { reply_markup: keyboard });
    } else {
      // первый переход в режим "листать" — исходное сообщение текстовое, фото добавляем новым сообщением
      await ctx.replyWithPhoto(lot.mainPhoto, { caption, reply_markup: keyboard });
    }
  } catch (err) {
    await ctx.reply(`Не удалось показать фото лота #${lot.id}: ${scrub(err?.message)}`);
  }
});

bot.callbackQuery("back", async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply("Сначала запустите анализ.");
    return;
  }
  await ctx.reply("Выберите раздел, чтобы посмотреть отобранные лоты:", {
    reply_markup: categoriesInlineKeyboard(session.groups),
  });
});

bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

bot.catch((err) => {
  // Печатаем ТОЛЬКО безопасные поля: err целиком содержит ctx, а в нём — ctx.api.token.
  const updateId = err?.ctx?.update?.update_id;
  logError(`Ошибка бота${updateId ? ` (update ${updateId})` : ""}`, err);
});

// Необработанный rejection/исключение вне middleware grammy убивало процесс без
// единой строчки в логе — и бот "умирал" молча. Логируем причину и выходим сами,
// чтобы pm2 поднял процесс заново.
process.on("unhandledRejection", (reason) => {
  logError("Необработанный rejection — перезапускаю процесс", reason);
  saveAiCache();
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logError("Необработанное исключение — перезапускаю процесс", err);
  saveAiCache();
  process.exit(1);
});

// pm2 при перезапуске/деплое присылает SIGINT — успеваем сохранить кэш ИИ-оценок,
// иначе оценки, сделанные после последнего сброса на диск, пришлось бы заказывать
// у ИИ заново.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`Получен ${signal} — сохраняю кэш ИИ-оценок и выхожу.`);
    saveAiCache();
    process.exit(0);
  });
}

// Обычный bot.start() обрабатывает апдейты СТРОГО ПОСЛЕДОВАТЕЛЬНО: пока не
// завершится текущий обработчик (а сканирование ждёт весь скан целиком,
// иногда десятки минут), бот вообще не смотрит на новые сообщения — поэтому
// "Отменить" молча вставало в очередь и обрабатывалось только после того, как
// скан уже сам закончился. @grammyjs/runner обрабатывает апдейты параллельно,
// так что нажатие "Отменить" доходит до бота, пока скан ещё идёт.
async function startBot() {
  // drop_pending_updates — чтобы при перезапуске не доигрывать апдейты, скопившиеся
  // пока бот не работал (старые нажатия из прошлых сессий/тестов).
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  const handle = run(bot);
  console.log("Бот запущен.");

  // @grammyjs/runner при неисправимой ошибке (401/409 от Telegram, либо сетевые
  // сбои дольше maxRetryTime) сам останавливает опрос обновлений и роняет
  // handle.task() — но НЕ завершает процесс Node. Раньше это никак не отслеживалось,
  // из-за чего процесс оставался живым, но бот переставал отвечать вообще на что
  // угодно, и требовался ручной restart. Мы сами не вызываем handle.stop() нигде,
  // поэтому любое завершение (успешное или с ошибкой) — это неожиданная остановка
  // раннера, и правильная реакция — завершить процесс, чтобы pm2 перезапустил его.
  handle.task()?.then(
    () => {
      console.error("Раннер обновлений остановился без явной команды — перезапускаю процесс.");
      process.exit(1);
    },
    (err) => {
      logError("Раннер обновлений упал с ошибкой — перезапускаю процесс", err);
      process.exit(1);
    }
  );
}

startBot().catch((err) => {
  const e = err?.error ?? err;
  if (e?.error_code === 409 || /conflict/i.test(e?.description ?? "")) {
    console.error(
      "409 Conflict: похоже, где-то уже запущен ещё один процесс с этим же BOT_TOKEN " +
      "(например, забытый фоновый запуск). Останови все остальные `node bot.mjs` и запусти заново."
    );
  } else {
    logError("Не удалось запустить бота", err);
  }
  process.exit(1);
});
