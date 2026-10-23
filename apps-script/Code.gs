/**
 * Дашборд «Просмотры уроков ЦОК» — сборщик данных из папки Google Диска.
 * Раз в 5 минут обрабатывает новые выгрузки и кладёт готовые цифры в data.json в репозитории сайта.
 *
 * Что делает: читает все выгрузки из Metabase (xlsx, csv или Google-таблицы) в папке,
 * склеивает их по дням (для каждого дня берётся самая полная версия) и отдаёт
 * сайту сводные цифры в JSON: просмотры учеников по дням, регионам, школам, курсам, урокам
 * и 15-минутным интервалам, а также число просмотров учителей (строки без региона).
 * Учитываются только данные начиная с START_DATE.
 * Уже обработанные файлы запоминаются в служебном файле в той же папке,
 * поэтому каждый файл читается один раз.
 *
 * Настройка: вставьте ниже ID папки (часть ссылки после /folders/).
 */
const FOLDER_ID = 'ВСТАВЬТЕ_СЮДА_ID_ПАПКИ';

const STATE_FILE_NAME = '_dashboard_state.json'; // служебный файл, не удаляйте и не переименовывайте
const TZ_OFFSET_HOURS = 3;                         // Metabase отдаёт время в UTC, переводим в Москву
const REFRESH_MINUTES = 5;                         // как часто скрипт сам проверяет папку (после запуска setup)
const STATE_VERSION = 6;                           // формат служебного файла (6 — с биллингом)
const START_DATE = '2026-10-06';                   // учитываем данные только с этой даты (мск)
// Уроки, убранные из каталога «Моей школы» при чистке (октябрь 2026): их просмотры не оплачиваются
// и в статистику не попадают. Номера уроков у Фоксфорда (lessonProviderId).
const EXCLUDED_LESSONS = new Set([
  '443370', '442265', '443892', '442400', '442478', '443890', '443362', '442359', '443017', '443153',
  '443252', '442327', '443304', '442488', '443228', '442325', '442348', '442354', '443088', '443378',
  '442484', '443015', '443019', '443099', '443894', '442262', '443090', '443092', '443159', '443164',
  '443300', '442267', '442398', '443057', '443061', '443082', '443084', '443213', '443224', '443235',
  '443312', '443316', '443368', '443392', '443402', '443413', '443421'
]);
// С 23.10.2026 Metabase отдаёт выгрузку в новом формате (есть колонки timeStart, timeEnd, vua.total_points),
// и время в ней на 3 часа раньше прежнего: до Москвы нужно прибавить 6 часов, а не 3.
const TZ_OFFSET_HOURS_NEW = 6;

// ---------- Биллинг (вкладка закрыта паролем, в data.json эти цифры не попадают) ----------
// Пароль задаётся в «Настройки проекта» → «Свойства скрипта» под именем BILLING_PASSWORD.
// Урок ученика попадает в биллинг, если время на уроке (от timeStart до timeEnd) не меньше 30% нормы
// и не больше самой нормы, а баллов за урок больше 30. Норма: 1–4 классы — 20 минут, 5–11 классы — 30 минут.
const BILL_MIN_SHARE = 0.3;
const BILL_MIN_POINTS = 30;                        // нужно строго больше
const BILL_NORM_MIN = function (grade) { return grade <= 4 ? 20 : 30; };
const BILL_BAND = function (grade) { return grade <= 6 ? '1-6' : '7-11'; };
const BILL_PRICES = { '1-6': 105, '7-11': 300 };   // рублей за урок
const BILL_MAX_FAILS = 10;                         // после стольких неверных паролей вход закрывается на 15 минут
// Класс курса (courseProviderId → класс)
const COURSE_GRADES = {
  '11215': 11, '11217': 11, '11218': 11, '11253': 9, '11254': 8, '11255': 1, '11257': 2, '11258': 3, '11260': 4,
  '11264': 5, '11265': 6, '11266': 7, '11268': 8, '11271': 9, '14678': 1, '14679': 2, '14680': 3, '14681': 4,
  '14682': 1, '14683': 2, '14684': 3, '14685': 4, '14690': 5, '14691': 6, '14692': 7, '14693': 8, '14694': 9,
  '14700': 5, '14701': 6, '14702': 7, '14703': 8, '14704': 9, '14705': 7, '14706': 8, '14707': 9, '14710': 7,
  '14713': 5, '14714': 6, '14715': 7, '14717': 9, '14719': 8
};

const SLOT_DAYS = 15;                             // за сколько последних дней сайт получает разбивку по 15 минутам
const CHUNK = 40000;                               // ответ хранится в кэше кусками (лимит Google — 100 КБ на кусок)

// Куда класть готовые цифры для сайта. Ключ доступа GitHub хранится не здесь, а в
// «Настройки проекта» → «Свойства скрипта» под именем GITHUB_TOKEN (код лежит в открытом репозитории).
const GITHUB_REPO = 'romannkiselev-cloud/cok-views';
const GITHUB_BRANCH = 'main';
const GITHUB_PATH = 'data.json';

/**
 * Запасной путь для сайта: обычно он берёт data.json из репозитория, а сюда обращается,
 * только если data.json ещё нет. Ответ отдаётся из кэша; если кэш пуст, собирается прямо здесь.
 */
function doGet(e) {
  const fresh = e && e.parameter && e.parameter.fresh;
  if (!fresh) {
    const hit = cacheGet_();
    if (hit) return json_(hit);
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_(JSON.stringify({ error: 'Скрипт занят обработкой файлов, обновите страницу через минуту.' }));
  try {
    const out = JSON.stringify(publicView_(build_(20000)));
    cachePut_(out, 60);
    return json_(out);
  } catch (err) {
    return json_(JSON.stringify({ error: String((err && err.message) || err) }));
  } finally {
    lock.releaseLock();
  }
}

/** Запустите ОДИН раз из редактора: включает автоматическую проверку папки раз в 5 минут. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refresh') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refresh').timeBased().everyMinutes(REFRESH_MINUTES).create();
  refresh();
  Logger.log('Готово: папка будет проверяться раз в ' + REFRESH_MINUTES + ' минут.');
}

/** Обрабатывает новые файлы в папке и кладёт готовый ответ в кэш. Запускается по расписанию. */
function refresh() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const r = build_(240000);
    const pub = publicView_(r);
    cachePut_(JSON.stringify(pub), REFRESH_MINUTES * 60 * 3);
    pushToGithub_(pub);
    Logger.log('Файлов учтено: ' + r.filesTotal + ', дней: ' + Object.keys(r.days).length + ', ждут обработки: ' + r.pending + ', ошибки: ' + JSON.stringify(r.errors));
  } finally {
    lock.releaseLock();
  }
}

/** Проверка из редактора: обработать папку и показать итог в журнале. */
function test() { refresh(); }

/**
 * Кладёт цифры в data.json в репозитории сайта — только если они изменились,
 * чтобы не плодить лишние обновления сайта.
 */
function pushToGithub_(pub) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('GITHUB_TOKEN не задан — данные на сайт не отправлены.'); return; }
  const copy = JSON.parse(JSON.stringify(pub));
  delete copy.generatedAt;
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(copy), Utilities.Charset.UTF_8));
  if (props.getProperty('LAST_PUSH_HASH') === hash) { Logger.log('Данные не изменились — на сайт не отправляем.'); return; }
  const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const cur = UrlFetchApp.fetch(url + '?ref=' + GITHUB_BRANCH, { headers: headers, muteHttpExceptions: true });
  let sha = null;
  if (cur.getResponseCode() === 200) sha = JSON.parse(cur.getContentText()).sha;
  else if (cur.getResponseCode() !== 404) throw new Error('GitHub не отдал текущий data.json: ' + cur.getResponseCode() + ' ' + cur.getContentText().slice(0, 200));
  const body = { message: 'Обновлены данные дашборда', branch: GITHUB_BRANCH, content: Utilities.base64Encode(JSON.stringify(pub), Utilities.Charset.UTF_8) };
  if (sha) body.sha = sha;
  const res = UrlFetchApp.fetch(url, { method: 'put', headers: headers, contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) throw new Error('GitHub не принял data.json: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  props.setProperty('LAST_PUSH_HASH', hash);
  Logger.log('Данные отправлены на сайт.');
}

function json_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Кэш ответа (кусками, чтобы не упираться в лимит размера) ----------
function cachePut_(s, seconds) {
  const cache = CacheService.getScriptCache();
  const parts = {};
  let n = 0;
  for (let i = 0; i < s.length; i += CHUNK) parts['out_' + (n++)] = s.slice(i, i + CHUNK);
  parts['out_n'] = String(n);
  try { cache.putAll(parts, Math.min(seconds, 21600)); } catch (_) { /* не удалось закэшировать — просто соберём заново в следующий раз */ }
}

function cacheGet_() {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get('out_n'), 10);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push('out_' + i);
  const got = cache.getAll(keys);
  let s = '';
  for (let i = 0; i < n; i++) { if (got['out_' + i] == null) return null; s += got['out_' + i]; }
  return s;
}

/**
 * Что получает сайт (только дни начиная с START_DATE):
 *  days    — по дням: просмотры учеников и учителей, регионы, 15-минутные интервалы (за SLOT_DAYS дней);
 *  ls      — по дням: просмотры в связке «урок | номер школы»; из неё сайт считает курсы, уроки, школы и регионы;
 *  schools — справочник школ: [название, код региона]; lessonCourse — урок → курс.
 */
function publicView_(r) {
  const keys = Object.keys(r.days).filter(function (k) { return k >= START_DATE; }).sort();
  const latest = keys.length ? keys[keys.length - 1] : null;
  const shift = function (k, n) { const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const slotsFrom = latest ? shift(latest, -(SLOT_DAYS - 1)) : null;
  const sTot = {};
  keys.forEach(function (k) { const m = r.days[k].ls || {}; Object.keys(m).forEach(function (x) { const sid = x.slice(x.indexOf('|') + 1); sTot[sid] = (sTot[sid] || 0) + m[x]; }); });
  // школы нумеруем, чтобы не повторять длинные ID в каждом дне
  const sids = Object.keys(sTot).sort(function (a, b) { return sTot[b] - sTot[a]; });
  const idx = {}; sids.forEach(function (x, i) { idx[x] = i; });
  const schools = sids.map(function (x) { const inf = (r.schoolInfo || {})[x] || [x === '?' ? 'Школа не указана' : x, '0']; return [inf[0], inf[1]]; });
  const days = {}, ls = {};
  keys.forEach(function (k) {
    const d = r.days[k];
    const day = { date: d.date, total: d.total, students: d.students, teachers: d.teachers, firstAt: d.firstAt, lastAt: d.lastAt, regions: d.regions };
    if (k >= slotsFrom) day.slots = d.slots;
    days[k] = day;
    const o = {}, m = d.ls || {};
    Object.keys(m).forEach(function (x) { const p = x.indexOf('|'); o[x.slice(0, p) + '|' + idx[x.slice(p + 1)]] = m[x]; });
    ls[k] = o;
  });
  return { version: 3, start: START_DATE, generatedAt: r.generatedAt, filesTotal: r.filesTotal, latestFile: r.latestFile, pending: r.pending, errors: r.errors,
    days: days, ls: ls, schools: schools, lessonCourse: r.lessonCourse || {} };
}

function build_(budgetMs) {
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
    if (Date.now() - started > budgetMs) { pending++; continue; }
    try {
      const rows = isSheet ? readGoogleSheet_(id) : /\.csv$/i.test(name) ? Utilities.parseCsv(f.getBlob().getDataAsString('UTF-8')) : readXlsx_(f.getBlob());
      const agg = aggregate_(rows);
      mergeDays_(state.days, agg.days);
      Object.keys(agg.schoolInfo).forEach(function (k) { state.schoolInfo[k] = agg.schoolInfo[k]; });
      Object.keys(agg.lessonCourse).forEach(function (k) { state.lessonCourse[k] = agg.lessonCourse[k]; });
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
    filesTotal: Object.keys(state.processed).length,
    latestFile: latest,
    pending: pending,
    errors: errors,
    days: state.days,
    schoolInfo: state.schoolInfo,
    lessonCourse: state.lessonCourse
  };
}

// ---------- Состояние ----------
function loadState_(folder) {
  const it = folder.getFilesByName(STATE_FILE_NAME);
  if (it.hasNext()) {
    const file = it.next();
    try {
      const s = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      // Состояние старого формата (без школ и курсов) пересобираем заново из всех файлов папки
      if (s && s.days && s.processed && s.version === STATE_VERSION) return { file: file, state: s };
      // Переход 5 → 6: дни оставляем (сайт продолжает показывать цифры), а файлы перечитываем,
      // чтобы посчитать биллинг и учесть новый сдвиг времени
      if (s && s.days && s.processed && s.version === 5) {
        s.version = STATE_VERSION; s.processed = {};
        return { file: file, state: s };
      }
    } catch (_) { /* повреждён — соберём заново */ }
    return { file: file, state: emptyState_() };
  }
  return { file: null, state: emptyState_() };
}

function emptyState_() {
  return { version: STATE_VERSION, processed: {}, days: {}, schoolInfo: {}, lessonCourse: {} };
}

function saveState_(folder, file, state) {
  const body = JSON.stringify(state);
  if (file) file.setContent(body);
  else folder.createFile(STATE_FILE_NAME, body, MimeType.PLAIN_TEXT);
}

// ---------- Склейка дней ----------
/** Для каждого дня оставляем версию с большим числом просмотров: за день просмотров со временем только прибавляется. */
/**
 * Склейка дней из разных выгрузок. Выгрузки из Metabase содержат всю историю, а строки в них
 * могут уточняться (например, у строки позже появляется регион), поэтому день берётся
 * из самой свежей выгрузки. Исключение — первый день выгрузки, который мог начаться
 * не с полуночи: его берём, только если в нём больше строк, чем уже есть.
 */
function mergeDays_(store, incoming) {
  Object.keys(incoming).forEach(function (k) {
    const nd = incoming[k], od = store[k];
    if (!od) { store[k] = nd; return; }
    if (nd.partialStart) { if (nd.total > od.total) store[k] = nd; return; }
    if ((nd.src || 0) >= (od.src || 0)) store[k] = nd;
  });
}

// ---------- Подсчёт ----------
function normKey_(s) { return String(s).toLowerCase().replace(/[^a-zа-я0-9]/g, ''); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }

function toMsk_(v, offH) {
  let ms = null;
  if (typeof v === 'number') ms = Math.round((v - 25569) * 86400000);
  else if (v instanceof Date) ms = v.getTime();
  else if (typeof v === 'string' && v.trim()) {
    let s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) { s = s.replace(' ', 'T'); if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z'; }
    else if (/^\d+(\.\d+)?$/.test(s)) return toMsk_(parseFloat(s), offH);
    ms = Date.parse(s);
  }
  if (ms === null || isNaN(ms)) return null;
  return new Date(ms + (offH == null ? TZ_OFFSET_HOURS : offH) * 3600000); // читаем через getUTC* — это московское время
}

/** rows: массив массивов, первая строка — заголовки. */
function aggregate_(rows) {
  if (!rows || rows.length < 2) throw new Error('В файле нет строк с данными');
  const head = rows[0].map(normKey_);
  const find = function (exact, part) { let i = head.indexOf(exact); if (i < 0) i = head.findIndex(function (h) { return part.some(function (p) { return h.indexOf(p) >= 0; }); }); return i; };
  const cT = find('createdat', ['created']);
  const cR = find('region', ['region', 'регион']);
  const cS = find('shortschoolname', ['schoolname', 'школ']);
  const cSid = head.indexOf('schoolid');
  const cC = find('courseproviderid', ['course']);
  const cL = find('lessonproviderid', ['lesson']);
  // новый формат выгрузки (с 23.10.2026): есть время урока и баллы, а время сдвинуто на 3 часа раньше
  const cTS = head.indexOf('timestart'), cTE = head.indexOf('timeend'), cP = find('vuatotalpoints', ['points']);
  const isNew = cTS >= 0 && cTE >= 0 && cP >= 0;
  const off = isNew ? TZ_OFFSET_HOURS_NEW : TZ_OFFSET_HOURS;
  if (cT < 0 || cR < 0) throw new Error('Нет колонок created_at и region — выгрузите тот же вопрос из Metabase без изменения колонок');
  const days = {}, schoolInfo = {}, lessonCourse = {};
  const str = function (v) { return v == null ? '' : String(v).trim().replace(/\.0+$/, ''); };
  let minKey = null, bad = 0, maxMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const t = toMsk_(r[cT], off);
    if (!t) { bad++; continue; }
    if (t.getTime() > maxMs) maxMs = t.getTime();
    if (cL >= 0 && EXCLUDED_LESSONS.has(str(r[cL]))) continue; // урок убран из каталога МШ
    const k = t.toISOString().slice(0, 10);
    const hm = pad_(t.getUTCHours()) + ':' + pad_(t.getUTCMinutes());
    const rc = parseInt(r[cR], 10), code = isNaN(rc) ? '0' : String(rc);
    let d = days[k];
    if (!d) {
      d = days[k] = { date: k, total: 0, students: 0, teachers: 0, firstAt: hm, lastAt: hm, partialStart: false, regions: {}, ls: {}, slots: [] };
      for (let s = 0; s < 96; s++) d.slots.push(0);
      if (isNew) d.bill = { '1-6': 0, '7-11': 0, unknown: 0 }; // уроки, попавшие в биллинг
    }
    d.total++;
    if (hm < d.firstAt) d.firstAt = hm;
    if (hm > d.lastAt) d.lastAt = hm;
    if (code === '0') { d.teachers++; continue; } // строки без региона — просмотры учителей
    d.students++;
    d.regions[code] = (d.regions[code] || 0) + 1;
    d.slots[Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / 15)]++;
    const sn = cS >= 0 ? str(r[cS]) : '';
    // номер школы уникален только внутри региона, поэтому ключ школы — «регион:номер»
    const sidRaw = (cSid >= 0 ? str(r[cSid]) : '') || sn, sid = sidRaw ? code + ':' + sidRaw : '';
    if (sid) schoolInfo[sid] = [sn || sid, code];
    const cid = cC >= 0 ? str(r[cC]) : '', lid = cL >= 0 ? str(r[cL]) : '';
    if (lid && cid) lessonCourse[lid] = cid;
    // Одна связка «урок | школа» даёт всё остальное: курс (через урок) и регион (через школу)
    if (isNew) billRow_(d, r, cid, cTS, cTE, cP);
    const pk = (lid || '?') + '|' + (sid || '?');
    d.ls[pk] = (d.ls[pk] || 0) + 1;
    if (!minKey || k < minKey) minKey = k;
  }
  if (minKey) days[minKey].partialStart = true; // первый день файла мог начаться не с полуночи
  Object.keys(days).forEach(function (k) { days[k].src = maxMs; }); // момент выгрузки: чем больше, тем свежее
  return { days: days, schoolInfo: schoolInfo, lessonCourse: lessonCourse, bad: bad };
}

/** Засчитывает просмотр ученика в биллинг дня, если он проходит условия. */
function billRow_(d, r, cid, cTS, cTE, cP) {
  const grade = COURSE_GRADES[cid];
  if (!grade) { d.bill.unknown++; return; }
  const a = toMsk_(r[cTS], 0), b = toMsk_(r[cTE], 0);
  if (!a || !b) return;                                   // урок не начинали
  const minutes = (b.getTime() - a.getTime()) / 60000, norm = BILL_NORM_MIN(grade);
  if (minutes < BILL_MIN_SHARE * norm || minutes > norm) return;
  const pts = parseFloat(String(r[cP] == null ? '' : r[cP]).replace(',', '.'));
  if (!(pts > BILL_MIN_POINTS)) return;
  d.bill[BILL_BAND(grade)]++;
}

/** Ответ вкладке «Биллинг»: число засчитанных уроков по месяцам и группам классов. */
function billingView_(state) {
  const keys = Object.keys(state.days || {}).filter(function (k) { return k >= START_DATE; }).sort();
  const months = {};
  let latest = null, noData = 0;
  keys.forEach(function (k) {
    const d = state.days[k], m = k.slice(0, 7);
    const mo = months[m] || (months[m] = { month: m, from: k, to: k, lessons: { '1-6': 0, '7-11': 0 }, unknown: 0, daysWithoutData: 0 });
    mo.to = k;
    if (!d.bill) { mo.daysWithoutData++; noData++; return; }
    mo.lessons['1-6'] += d.bill['1-6'] || 0; mo.lessons['7-11'] += d.bill['7-11'] || 0; mo.unknown += d.bill.unknown || 0;
    latest = { date: k, lastAt: d.lastAt };
  });
  return { version: 1, generatedAt: new Date().toISOString(), updatedAt: state.updatedAt || null, latest: latest,
    prices: BILL_PRICES, rules: { minShare: BILL_MIN_SHARE, minPoints: BILL_MIN_POINTS, norms: { '1-4': BILL_NORM_MIN(1), '5-11': BILL_NORM_MIN(5) } },
    months: Object.keys(months).sort().map(function (m) { return months[m]; }), daysWithoutData: noData };
}

/**
 * Вкладка «Биллинг» обращается сюда POST-запросом с паролем. Пароль сверяется со свойством
 * скрипта BILLING_PASSWORD; после BILL_MAX_FAILS неверных попыток вход закрывается на 15 минут.
 */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) { body = {}; }
  const cache = CacheService.getScriptCache();
  const fails = parseInt(cache.get('bill_fails') || '0', 10);
  if (fails >= BILL_MAX_FAILS) return json_(JSON.stringify({ error: 'Слишком много неверных попыток. Попробуйте через 15 минут.', locked: true }));
  const pass = PropertiesService.getScriptProperties().getProperty('BILLING_PASSWORD');
  if (!pass) return json_(JSON.stringify({ error: 'Пароль для биллинга ещё не задан в свойствах скрипта.' }));
  if (String(body.password || '') !== pass) {
    cache.put('bill_fails', String(fails + 1), 900);
    Utilities.sleep(800);
    return json_(JSON.stringify({ error: 'Неверный пароль.', denied: true }));
  }
  try {
    const st = loadState_(DriveApp.getFolderById(FOLDER_ID));
    return json_(JSON.stringify(billingView_(st.state)));
  } catch (err) {
    return json_(JSON.stringify({ error: String((err && err.message) || err) }));
  }
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
