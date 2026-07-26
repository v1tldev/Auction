import "dotenv/config";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { run } from "@grammyjs/runner";
import { CATEGORIES } from "./src/categories.mjs";
import { scrapeCategories, checkPricesVisible } from "./src/scrape-core.mjs";
import { loginAndGetSession } from "./src/fajans-auth.mjs";
import { getAccountOverride, setAccountOverride, clearAccountOverride } from "./src/account-store.mjs";
import { saveLastResults, loadLastResults } from "./src/results-store.mjs";

if (!process.env.BOT_TOKEN) {
  console.error("В .env не задан BOT_TOKEN — получите токен у @BotFather в Telegram и впишите его в .env");
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

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
// Флаги отмены для запущенных сканирований.
const runningScans = new Map(); // chatId -> { cancelled: boolean }
// Результаты последнего анализа: { groups } — groups: [[categoryName, lots[]], ...].
const sessions = new Map();

// Сторожевой таймер на случай зависания скана по ЛЮБОЙ непредвиденной причине
// (сеть, сторонний сервис, что угодно, что мы не предусмотрели явно). Пока идёт
// скан, каждое событие прогресса обновляет watchdogLastProgress; если прогресса
// нет дольше STALL_TIMEOUT_MS — считаем процесс зависшим, пишем об этом в чат
// и завершаемся, чтобы pm2 перезапустил бота начисто.
const STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут без прогресса
let watchdogChatId = null;
let watchdogLastProgress = null;

setInterval(async () => {
  if (watchdogLastProgress === null) return; // сейчас ничего не сканируется
  if (Date.now() - watchdogLastProgress < STALL_TIMEOUT_MS) return;
  const chatId = watchdogChatId;
  console.error(`Скан завис (нет прогресса дольше ${STALL_TIMEOUT_MS / 60000} минут) — перезапускаю процесс.`);
  try {
    await bot.api.sendMessage(
      chatId,
      `⚠️ Сканирование зависло (нет прогресса больше ${STALL_TIMEOUT_MS / 60000} минут) — перезапускаю бота. ` +
        "Через минуту попробуйте запустить сканирование заново."
    );
  } catch {
    // не получилось отправить — не страшно, перезапускаемся в любом случае
  }
  process.exit(1);
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
  return text.length > CAPTION_MAX ? text.slice(0, CAPTION_MAX - 1) + "…" : text;
}

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  getState(chatId).mode = "main";
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

async function startAnalysis(ctx, chatId, categories) {
  const state = getState(chatId);
  state.mode = "scanning";
  const cancelToken = { cancelled: false };
  runningScans.set(chatId, cancelToken);
  watchdogChatId = chatId;
  watchdogLastProgress = Date.now();

  try {

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
  // Раньше это молча проглатывалось пустым catch{}, из-за чего прогресс
  // никогда не отображался, хотя сбор данных на самом деле шёл.
  const progressMsg = await ctx.reply("Собираю данные...");
  const progressMessageId = progressMsg.message_id;

  // Свой аккаунт (если клиент его задал через "Сменить аккаунт") приоритетнее
  // дефолтного из .env — так у каждого чата может быть свой fajans.lv-логин.
  const override = getAccountOverride(chatId);
  const FAJANS_USER = override?.username ?? process.env.FAJANS_USER;
  const FAJANS_PASS = override?.password ?? process.env.FAJANS_PASS;
  const { API_KEY } = process.env;
  if (!FAJANS_USER || !FAJANS_PASS) {
    runningScans.delete(chatId);
    await ctx.api.deleteMessage(chatId, progressMessageId).catch(() => {});
    await finishScanning(ctx, chatId, "В .env не заданы FAJANS_USER / FAJANS_PASS.");
    return;
  }
  if (!API_KEY) {
    runningScans.delete(chatId);
    await ctx.api.deleteMessage(chatId, progressMessageId).catch(() => {});
    await finishScanning(ctx, chatId, "В .env не задан API_KEY (ключ для оценки ИИ через polza.ai).");
    return;
  }

  // Любая ошибка внутри (сеть, разлогинило сессию и т.п.) раньше "проглатывалась"
  // необработанным исключением — чат молчал, а режим навсегда застревал на
  // "сканирование". Теперь при сбое явно показываем причину и возвращаемся в меню.
  let deals = [];
  let scanned = 0;
  let loginFailed = false;
  let pricesGated = false;
  let gatedMidScan = false;
  let aiUnavailable = false;
  try {
    const login = await loginAndGetSession(FAJANS_USER, FAJANS_PASS);
    if (!login.success) {
      loginFailed = true;
    } else {
      // Аккаунт может формально залогиниться (куки, редирект), но при этом не
      // видеть цены — например, если он не прошёл модерацию на сайте. Раньше
      // это тихо приводило к "0 сделок найдено" без объяснений: скан проходил
      // весь список лотов, а фильтр молча пропускал их все из-за отсутствия
      // цены. Теперь проверяем доступ к ценам ДО полного скана.
      const access = await checkPricesVisible(categories, login.cookieJar);
      if (access.visible === false) {
        pricesGated = true;
      } else {
        let lastEditAt = 0;
        let lastStage = null;
        const result = await scrapeCategories(categories, login.cookieJar, {
          isCancelled: () => cancelToken.cancelled,
          async onProgress(p) {
            watchdogLastProgress = Date.now(); // отмечаем сразу, до троттлинга UI ниже
            const now = Date.now();
            // Раньше троттлинг был общим на все три стадии ("список"/"детали"/
            // "оценка ИИ") — а поскольку "детали" тикают чаще и равномернее, они
            // почти всегда "выигрывали" 2.5-секундное окно, и сообщение про ИИ
            // могло вообще не успеть показаться на небольшом разделе. Смена
            // стадии теперь всегда пробивает троттлинг — сама стадия при этом
            // всё равно не мельтешит чаще раза в 2.5с.
            if (p.stage === lastStage && now - lastEditAt < 2500) return;
            lastEditAt = now;
            lastStage = p.stage;
            const progressText =
              p.stage === "listing"
                ? `Собираю список: ${p.name} — стр. ${p.page}/${p.totalPages}`
                : p.stage === "detail"
                ? `Собираю данные по лотам: ${p.index}/${p.total}`
                : `Оцениваю через ИИ: ${p.done}/${p.total}`;
            try {
              await ctx.api.editMessageText(chatId, progressMessageId, progressText);
            } catch {
              // сообщение могло не измениться с прошлой правки — Telegram в этом случае просто отдаёт ошибку, игнорируем
            }
          },
        });
        deals = result.deals;
        scanned = result.scanned;
        gatedMidScan = result.gatedMidScan;
        aiUnavailable = result.aiUnavailable;
      }
    }
  } catch (err) {
    console.error("Ошибка при сканировании:", err);
    runningScans.delete(chatId);
    await ctx.api.deleteMessage(chatId, progressMessageId).catch(() => {});
    await finishScanning(ctx, chatId, `Сканирование прервано из-за ошибки: ${err.message}`);
    return;
  }

  await ctx.api.deleteMessage(chatId, progressMessageId).catch(() => {});

  runningScans.delete(chatId);

  if (loginFailed) {
    await finishScanning(ctx, chatId, "Не удалось залогиниться на fajans.lv.");
    return;
  }
  if (pricesGated) {
    await finishScanning(
      ctx,
      chatId,
      `Аккаунт ${FAJANS_USER} залогинился, но не видит цены на лотах (сайт показывает "Только зарегистрированные пользователи могут принять участие в торгах"). ` +
        "Возможно, аккаунт не прошёл модерацию на fajans.lv — проверьте его статус на сайте или замените аккаунт."
    );
    return;
  }

  const wasCancelled = cancelToken.cancelled;

  const groups = groupDealsByCategory(deals);
  sessions.set(chatId, { groups });
  // Один клиент, один аукцион — сохраняем на диск, чтобы отдать эти же
  // результаты повторно по кнопке "Показать результаты последнего сканирования",
  // даже после перезапуска бота.
  saveLastResults(groups);

  const gatedNote = gatedMidScan
    ? "\n\n⚠️ Скан прервался раньше времени: аккаунт перестал видеть цены на середине (похоже, истекла сессия). Результат может быть неполным — попробуйте сканировать заново."
    : aiUnavailable
    ? "\n\n⚠️ Скан прервался раньше времени: ИИ ограничил доступ по ключу (закончился лимит или баланс). Результат может быть неполным — проверьте ключ ИИ у своего поставщика и попробуйте позже."
    : "";

  await finishScanning(
    ctx,
    chatId,
    (wasCancelled
      ? `Сканирование отменено. Успело собраться ${scanned} лотов, из них подходящих по цене — ${deals.length}.`
      : `Готово! Отсканировано ${scanned} лотов, найдено подходящих по цене — ${deals.length}.`) + gatedNote
  );

  if (groups.length) {
    await ctx.reply("Выберите раздел, чтобы посмотреть отобранные лоты:", { reply_markup: categoriesInlineKeyboard(groups) });
  }
  } finally {
    watchdogChatId = null;
    watchdogLastProgress = null;
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
    const login = await loginAndGetSession(username, password);
    state.mode = "main";
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
    await ctx.reply(`Не удалось показать фото лота #${lot.id}: ${err.message}`);
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
    await ctx.reply(`Не удалось показать фото лота #${lot.id}: ${err.message}`);
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
  await ctx.reply("Выберите раздел, чтобы посмотреть отобранные лоты:", { reply_markup: categoriesInlineKeyboard(session.groups) });
});

bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

bot.catch((err) => console.error("Ошибка бота:", err));

// Обычный bot.start() обрабатывает апдейты СТРОГО ПОСЛЕДОВАТЕЛЬНО: пока не
// завершится текущий обработчик (а "Начать анализ" ждёт весь скан целиком,
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
      console.error("Раннер обновлений упал с ошибкой — перезапускаю процесс:", err);
      process.exit(1);
    }
  );
}

startBot().catch((err) => {
  if (err?.error_code === 409 || /conflict/i.test(err?.description ?? "")) {
    console.error(
      "409 Conflict: похоже, где-то уже запущен ещё один процесс с этим же BOT_TOKEN " +
      "(например, забытый фоновый запуск). Останови все остальные `node bot.mjs` и запусти заново."
    );
  } else {
    console.error("Не удалось запустить бота:", err);
  }
  process.exit(1);
});
