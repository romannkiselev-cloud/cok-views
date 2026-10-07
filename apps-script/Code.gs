/**
 * Дашборд «Просмотры уроков ЦОК» — сборщик данных из папки Google Диска.
 *
 * Что делает: читает все выгрузки из Metabase (xlsx, csv или Google-таблицы) в папке,
 * склеивает их по дням (для каждого дня берётся самая полная версия) и отдаёт
 * сайту сводные цифры в JSON: просмотры учеников по дням, регионам, школам и 15-минутным
 * интервалам, а также число просмотров учителей (строки без региона).
 * Уже обработанные файлы запоминаются в служебном файле в той же папке,
 * поэтому каждый файл читается один раз.
 *
 * Настройка: вставьте ниже ID папки (часть ссылки после /folders/).
 */
const FOLDER_ID = 'ВСТАВЬТЕ_СЮДА_ID_ПАПКИ';

const STATE_FILE_NAME = '_dashboard_state.json'; // служебный файл, не удаляйте и не переименовывайте
const TZ_OFFSET_HOURS = 3;                         // Metabase отдаёт время в UTC, переводим в Москву
const CACHE_SECONDS = 60;                          // как часто пересобирать ответ
const TIME_BUDGET_MS = 20000;                      // сколько времени тратить на новые файлы за один запрос

function doGet(e) {
  const fresh = e && e.parameter && e.parameter.fresh;
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('out');
    if (hit) return json_(hit);
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_(JSON.stringify({ error: 'Сервер занят обработкой файлов, обновите страницу через минуту.' }));
  try {
    const out = JSON.stringify(build_());
    try { cache.put('out', out, CACHE_SECONDS); } catch (_) { /* ответ больше лимита кэша — просто не кэшируем */ }
    return json_(out);
  } catch (err) {
    return json_(JSON.stringify({ error: String((err && err.message) || err) }));
  } finally {
    lock.releaseLock();
  }
}

/** Запустите вручную из редактора, чтобы выдать доступ и проверить, что всё читается. */
function test() {
  const r = build_();
  Logger.log('Файлов обработано: ' + r.filesTotal + ', дней: ' + Object.keys(r.days).length + ', ошибки: ' + JSON.stringify(r.errors));
}

function json_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function build_() {
  const started = Date.now();
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const st = loadState_(folder);
  const state = st.state;
  let changed = false, pending = 0, latest = null;
  const errors = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    if (name === STATE_FILE_NAME) continue;
    const mime = f.getMimeType();
    const isSheet = mime === MimeType.GOOGLE_SHEETS;
    if (!isSheet && !/\.(xlsx|csv)$/i.test(name)) continue;
    const id = f.getId(), upd = f.getLastUpdated().getTime();
    if (!latest || upd > latest.updated) latest = { name: name, updated: upd };
    if (state.processed[id] === upd) continue;
    if (Date.now() - started > TIME_BUDGET_MS) { pending++; continue; }
    try {
      const rows = isSheet ? readGoogleSheet_(id) : /\.csv$/i.test(name) ? Utilities.parseCsv(f.getBlob().getDataAsString('UTF-8')) : readXlsx_(f.getBlob());
      const agg = aggregate_(rows);
      mergeDays_(state.days, agg.days);
      state.processed[id] = upd;
      changed = true;
    } catch (err) {
      errors.push({ file: name, message: String((err && err.message) || err) });
    }
  }
  if (changed) {
    state.updatedAt = new Date().toISOString();
    saveState_(folder, st.file, state);
  }
  return {
    generatedAt: new Date().toISOString(),
    stateUpdatedAt: state.updatedAt || null,
    filesTotal: Object.keys(state.processed).length,
    latestFile: latest,
    pending: pending,
    errors: errors,
    days: state.days
  };
}

// ---------- Состояние ----------
function loadState_(folder) {
  const it = folder.getFilesByName(STATE_FILE_NAME);
  if (it.hasNext()) {
    const file = it.next();
    try {
      const s = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (s && s.days && s.processed) return { file: file, state: s };
    } catch (_) { /* повреждён — соберём заново */ }
    return { file: file, state: { processed: {}, days: {} } };
  }
  return { file: null, state: { processed: {}, days: {} } };
}

function saveState_(folder, file, state) {
  const body = JSON.stringify(state);
  if (file) file.setContent(body);
  else folder.createFile(STATE_FILE_NAME, body, MimeType.PLAIN_TEXT);
}

// ---------- Склейка дней ----------
/** Для каждого дня оставляем версию с большим числом просмотров: за день просмотров со временем только прибавляется. */
function mergeDays_(store, incoming) {
  Object.keys(incoming).forEach(function (k) {
    const nd = incoming[k], od = store[k];
    if (!od || nd.total > od.total || (nd.total === od.total && od.partialStart && !nd.partialStart)) store[k] = nd;
  });
}

// ---------- Подсчёт ----------
function normKey_(s) { return String(s).toLowerCase().replace(/[^a-zа-я0-9]/g, ''); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }

function toMsk_(v) {
  let ms = null;
  if (typeof v === 'number') ms = Math.round((v - 25569) * 86400000);
  else if (v instanceof Date) ms = v.getTime();
  else if (typeof v === 'string' && v.trim()) {
    let s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) { s = s.replace(' ', 'T'); if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z'; }
    else if (/^\d+(\.\d+)?$/.test(s)) return toMsk_(parseFloat(s));
    ms = Date.parse(s);
  }
  if (ms === null || isNaN(ms)) return null;
  return new Date(ms + TZ_OFFSET_HOURS * 3600000); // читаем через getUTC* — это московское время
}

/** rows: массив массивов, первая строка — заголовки. */
function aggregate_(rows) {
  if (!rows || rows.length < 2) throw new Error('В файле нет строк с данными');
  const head = rows[0].map(normKey_);
  const find = function (exact, part) { let i = head.indexOf(exact); if (i < 0) i = head.findIndex(function (h) { return part.some(function (p) { return h.indexOf(p) >= 0; }); }); return i; };
  const cT = find('createdat', ['created']);
  const cR = find('region', ['region', 'регион']);
  const cS = find('shortschoolname', ['schoolname', 'школ']);
  if (cT < 0 || cR < 0) throw new Error('Нет колонок created_at и region — выгрузите тот же вопрос из Metabase без изменения колонок');
  const days = {};
  let minKey = null, bad = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const t = toMsk_(r[cT]);
    if (!t) { bad++; continue; }
    const k = t.toISOString().slice(0, 10);
    const hm = pad_(t.getUTCHours()) + ':' + pad_(t.getUTCMinutes());
    const rc = parseInt(r[cR], 10), code = isNaN(rc) ? '0' : String(rc);
    let d = days[k];
    if (!d) { d = days[k] = { date: k, total: 0, students: 0, teachers: 0, firstAt: hm, lastAt: hm, partialStart: false, regions: {}, schools: {}, slots: [] }; for (let s = 0; s < 96; s++) d.slots.push(0); }
    d.total++;
    if (hm < d.firstAt) d.firstAt = hm;
    if (hm > d.lastAt) d.lastAt = hm;
    if (code === '0') { d.teachers++; continue; } // строки без региона — просмотры учителей
    d.students++;
    d.regions[code] = (d.regions[code] || 0) + 1;
    d.slots[Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / 15)]++;
    if (cS >= 0) {
      const sn = r[cS] == null ? '' : String(r[cS]).trim();
      if (sn) { const sk = code + '|' + sn; d.schools[sk] = (d.schools[sk] || 0) + 1; }
    }
    if (!minKey || k < minKey) minKey = k;
  }
  if (minKey) days[minKey].partialStart = true; // первый день файла мог начаться не с полуночи
  return { days: days, bad: bad };
}

// ---------- Чтение файлов ----------
function readGoogleSheet_(id) {
  const ss = SpreadsheetApp.openById(id);
  const tz = ss.getSpreadsheetTimeZone();
  const values = ss.getSheets()[0].getDataRange().getValues();
  return values.map(function (row) {
    return row.map(function (v) {
      // дата в таблице хранится «по часам на стене»: восстанавливаем исходное время UTC из выгрузки
      return v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS") + 'Z' : v;
    });
  });
}

function readXlsx_(blob) {
  const entries = unzipEntries_(blob);
  const sheetNames = entries.map(function (e) { return e.name; }).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); });
  if (!sheetNames.length) throw new Error('Не похоже на файл Excel');
  sheetNames.sort(function (a, b) { return parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10); });
  const get = function (n) { const e = entries.filter(function (x) { return x.name === n; })[0]; return e ? e.text() : null; };
  return parseSheetXml_(get(sheetNames[0]), get('xl/sharedStrings.xml'));
}

/**
 * Распаковка xlsx без Utilities.unzip: Metabase пишет архив «потоком» (размеры файлов только
 * в конце), и встроенная распаковка Google такие архивы не читает. Берём размеры и контрольные
 * суммы из оглавления архива, а сами данные разжимаем через Utilities.ungzip.
 */
function unzipEntries_(blob) {
  const b = blob.getBytes();
  const u8 = function (i) { return b[i] & 0xff; };
  const u16 = function (i) { return u8(i) | (u8(i + 1) << 8); };
  const u32 = function (i) { return (u8(i) | (u8(i + 1) << 8) | (u8(i + 2) << 16) | (u8(i + 3) << 24)) >>> 0; };
  const sb = function (v) { v = v & 0xff; return v > 127 ? v - 256 : v; };
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Файл повреждён или это не xlsx: не найдено оглавление архива');
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const list = [];
  for (let k = 0; k < count; k++) {
    if (u32(p) !== 0x02014b50) throw new Error('Файл повреждён: ошибка в оглавлении архива');
    const nl = u16(p + 28), xl = u16(p + 30), cl = u16(p + 32);
    list.push({
      name: Utilities.newBlob(b.slice(p + 46, p + 46 + nl)).getDataAsString('UTF-8'),
      method: u16(p + 10), crc: u32(p + 16), csize: u32(p + 20), usize: u32(p + 24), local: u32(p + 42)
    });
    p += 46 + nl + xl + cl;
  }
  return list.map(function (en) {
    return {
      name: en.name,
      text: function () {
        const start = en.local + 30 + u16(en.local + 26) + u16(en.local + 28);
        const data = b.slice(start, start + en.csize);
        if (en.method === 0) return Utilities.newBlob(data).getDataAsString('UTF-8');
        if (en.method !== 8) throw new Error('Неизвестный способ сжатия в xlsx: ' + en.method);
        const head = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff].map(sb);
        const tail = [en.crc, en.crc >>> 8, en.crc >>> 16, en.crc >>> 24, en.usize, en.usize >>> 8, en.usize >>> 16, en.usize >>> 24].map(sb);
        return Utilities.ungzip(Utilities.newBlob(head.concat(data, tail), 'application/x-gzip')).getDataAsString('UTF-8');
      }
    };
  });
}

function xmlText_(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (m, e) {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function joinT_(xml) {
  let out = '', m;
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  while ((m = re.exec(xml))) out += m[1];
  return xmlText_(out);
}

function colIndex_(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function parseSheetXml_(xml, sstXml) {
  const sst = [];
  if (sstXml) { let m; const re = /<si>([\s\S]*?)<\/si>/g; while ((m = re.exec(sstXml))) sst.push(joinT_(m[1])); }
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const row = [];
    let cm, auto = 0;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1], inner = cm[2] || '';
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      const col = refM ? colIndex_(refM[1]) : auto;
      auto = col + 1;
      const tM = /\bt="([^"]+)"/.exec(attrs), t = tM ? tM[1] : 'n';
      let v = null;
      if (t === 'inlineStr') v = joinT_(inner);
      else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) {
          const raw = xmlText_(vM[1]);
          if (t === 's') v = sst[parseInt(raw, 10)];
          else if (t === 'n') v = parseFloat(raw);
          else if (t === 'b') v = raw === '1';
          else v = raw;
        }
      }
      row[col] = v;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows.push(row);
  }
  return rows;
}
