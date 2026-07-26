import fs from "fs";
import path from "path";

// Обычный fs.writeFileSync сначала обрезает файл, а потом пишет данные — если
// процесс умрёт (или его перезапустит pm2) ровно между этим, на диске останется
// пустой/обрезанный JSON, и результаты последнего скана вместе с кэшем ИИ-оценок
// потеряются насовсем. Пишем во временный файл рядом и переименовываем: rename
// в пределах одной файловой системы атомарен, так что читатель всегда видит либо
// старую целую версию, либо новую целую.
export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, filePath);
}

// Возвращает fallback, если файла нет или он битый (например, остался обрезанным
// от старой, ещё не атомарной, версии записи).
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}
