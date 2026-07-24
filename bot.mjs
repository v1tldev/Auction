import "dotenv/config";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { run } from "@grammyjs/runner";
import { CATEGORIES } from "./src/categories.mjs";
import { scrapeCategories } from "./src/scrape-core.mjs";
import { loginAndGetSession } from "./src/fajans-auth.mjs";
import { getSelectedSlugs, setSelectedSlugs } from "./src/bot-store.mjs";

if (!process.env.BOT_TOKEN) {
  console.error("В .env не задан BOT_TOKEN — получите токен у @BotFather в Telegram и впишите его в .env");
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

const NAME_TO_SLUG = new Map(CATEGORIES.map((c) => [c.name, c.slug]));
const DONE_LABEL = "✅ Готово";
const SELECT_CATEGORIES_LABEL = "📂 Выбрать разделы";
const START_ANALYSIS_LABEL = "▶️ Начать анализ";
const CANCEL_LABEL = "❌ Отменить сканирование";

// Состояние экрана на чат: какое reply-меню сейчас показано и id последнего
// служебного сообщения бота (чтобы удалять его перед показом следующего экрана).
const uiState = new Map(); // chatId -> { mode: "main" | "categories" | "scanning", lastMessageId }
// Флаги отмены для запущенных сканирований.
const runningScans = new Map(); // chatId -> { cancelled: boolean }
// Результаты последнего анализа: { lots, index } — index нужен для режима "листать".
const sessions = new Map();

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
    .text(SELECT_CATEGORIES_LABEL).row()
    .text(START_ANALYSIS_LABEL)
    .resized();
}

function categoriesKeyboard(selectedSlugs) {
  const kb = new Keyboard();
  CATEGORIES.forEach((cat, i) => {
    const mark = selectedSlugs.includes(cat.slug) ? "✅ " : "▫️ ";
    kb.text(mark + cat.name);
    if (i % 2 === 1) kb.row();
  });
  if (CATEGORIES.length % 2 === 1) kb.row();
  kb.text(DONE_LABEL);
  return kb.resized();
}

function cancelKeyboard() {
  return new Keyboard().text(CANCEL_LABEL).resized();
}

function resultsMenu() {
  return new InlineKeyboard()
    .text("📋 Списком", "results:list").row()
    .text("🔎 Листать", "results:browse:0");
}

function browseKeyboard(index, total) {
  return new InlineKeyboard()
    .text("◀️", "results:browse:" + (index - 1))
    .text(`${index + 1}/${total}`, "noop")
    .text("▶️", "results:browse:" + (index + 1));
}

function formatLot(lot) {
  const price = lot.price != null ? `${lot.price} €` : "цена скрыта";
  const market = lot.marketPrice != null ? `${lot.marketPrice} €` : "?";
  const comment = lot.aiComment ? `\n💬 ${lot.aiComment}` : "";
  return `#${lot.id} [${lot.category}]\n${lot.title}\nЦена на аукционе: ${price}\nРыночная цена (оценка ИИ): ${market}${comment}\nhttps://www.fajans.lv/ru/auction/${lot.id}`;
}

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  getState(chatId).mode = "main";
  await showScreen(
    ctx,
    chatId,
    "Привет! Это бот-мониторинг лотов fajans.lv.\n\nВыберите разделы для анализа и запустите сбор данных.",
    mainKeyboard()
  );
});

async function finishScanning(ctx, chatId, text) {
  const state = getState(chatId);
  state.mode = "main";
  await showScreen(ctx, chatId, text, mainKeyboard());
}

async function startAnalysis(ctx, chatId) {
  const selectedSlugs = getSelectedSlugs(chatId);
  const categories = CATEGORIES.filter((c) => selectedSlugs.includes(c.slug));

  if (!categories.length) {
    await ctx.reply("Сначала выберите хотя бы один раздел.");
    return;
  }

  const state = getState(chatId);
  state.mode = "scanning";
  const cancelToken = { cancelled: false };
  runningScans.set(chatId, cancelToken);

  await showScreen(
    ctx,
    chatId,
    `Начинаю сбор данных по разделам:\n${categories.map((c) => c.name).join(", ")}\n\n(нажмите «${CANCEL_LABEL}», чтобы остановить)`,
    cancelKeyboard()
  );

  // Статус прогресса шлём отдельным обычным сообщением, а не правкой того,
  // что показывает кнопку отмены: Telegram запрещает редактировать текст
  // сообщения, отправленного вместе с ReplyKeyboardMarkup — editMessageText
  // на такое сообщение стабильно падает с 400 "message can't be edited".
  // Раньше это молча проглатывалось пустым catch{}, из-за чего прогресс
  // никогда не отображался, хотя сбор данных на самом деле шёл.
  const progressMsg = await ctx.reply("Собираю данные...");
  const progressMessageId = progressMsg.message_id;

  const { FAJANS_USER, FAJANS_PASS, API_KEY } = process.env;
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
  try {
    const login = await loginAndGetSession(FAJANS_USER, FAJANS_PASS);
    if (!login.success) {
      loginFailed = true;
    } else {
      let lastEditAt = 0;
      const result = await scrapeCategories(categories, login.cookieJar, {
        isCancelled: () => cancelToken.cancelled,
        async onProgress(p) {
          const now = Date.now();
          if (now - lastEditAt < 2500) return; // не долбим Telegram API правками чаще раза в 2.5с
          lastEditAt = now;
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

  const wasCancelled = cancelToken.cancelled;
  sessions.set(chatId, { lots: deals, index: 0 });

  await finishScanning(
    ctx,
    chatId,
    wasCancelled
      ? `Сканирование отменено. Успело собраться ${scanned} лотов, из них подходящих по цене — ${deals.length}.`
      : `Готово! Отсканировано ${scanned} лотов, найдено подходящих по цене — ${deals.length}.`
  );

  if (deals.length) {
    await ctx.reply("Как показать результаты?", { reply_markup: resultsMenu() });
  }
}

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const state = getState(chatId);

  if (state.mode === "main") {
    if (text === SELECT_CATEGORIES_LABEL) {
      state.mode = "categories";
      const selected = getSelectedSlugs(chatId);
      await showScreen(
        ctx,
        chatId,
        "Выберите разделы для анализа (нажмите, чтобы включить/выключить):",
        categoriesKeyboard(selected)
      );
      return;
    }
    if (text === START_ANALYSIS_LABEL) {
      await startAnalysis(ctx, chatId);
      return;
    }
    return;
  }

  if (state.mode === "categories") {
    if (text === DONE_LABEL) {
      state.mode = "main";
      const selected = getSelectedSlugs(chatId);
      const names = CATEGORIES.filter((c) => selected.includes(c.slug)).map((c) => c.name);
      await showScreen(
        ctx,
        chatId,
        `Сохранено. Выбрано разделов: ${selected.length}.\n${names.join(", ") || "(ничего не выбрано)"}`,
        mainKeyboard()
      );
      return;
    }

    const bareName = text.replace(/^(✅ |▫️ )/, "");
    const slug = NAME_TO_SLUG.get(bareName);
    if (slug) {
      const selected = getSelectedSlugs(chatId);
      const updated = selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug];
      setSelectedSlugs(chatId, updated);
      await showScreen(
        ctx,
        chatId,
        "Выберите разделы для анализа (нажмите, чтобы включить/выключить):",
        categoriesKeyboard(updated)
      );
    }
    return;
  }

  if (state.mode === "scanning") {
    console.log("[DEBUG] in scanning branch, text matches CANCEL_LABEL?", text === CANCEL_LABEL, "runningScans has token?", runningScans.has(chatId));
    if (text === CANCEL_LABEL) {
      const token = runningScans.get(chatId);
      if (token && !token.cancelled) {
        token.cancelled = true;
        console.log("[DEBUG] cancelled flag set to true");
        await ctx.reply("Останавливаю сканирование, подождите...");
      }
    }
    return;
  }
});

bot.callbackQuery("results:list", async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();
  const session = sessions.get(chatId);
  if (!session || !session.lots.length) {
    await ctx.reply("Сначала запустите анализ.");
    return;
  }

  // Укладываемся в лимит Telegram на длину сообщения (4096 символов) — режем на части.
  let chunk = "";
  for (const lot of session.lots) {
    const line = formatLot(lot);
    if (chunk && (chunk + "\n\n" + line).length > 3500) {
      await ctx.reply(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n\n" + line : line;
    }
  }
  if (chunk) await ctx.reply(chunk);
});

bot.callbackQuery(/^results:browse:(-?\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();
  const session = sessions.get(chatId);
  if (!session || !session.lots.length) {
    await ctx.reply("Сначала запустите анализ.");
    return;
  }

  const total = session.lots.length;
  let index = Number(ctx.match[1]);
  if (index < 0) index = total - 1;
  if (index >= total) index = 0;
  session.index = index;

  const lot = session.lots[index];
  const caption = formatLot(lot);
  const keyboard = browseKeyboard(index, total);

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
  run(bot);
  console.log("Бот запущен.");
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
