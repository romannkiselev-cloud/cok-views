/**
 * Дашборд «Ученики и просмотры уроков ЦОК» — сборщик данных из папки Google Диска.
 * Раз в 5 минут обрабатывает новые выгрузки и кладёт готовые цифры в data.json в репозитории сайта.
 *
 * Что делает: читает все выгрузки из Metabase (xlsx, csv или Google-таблицы) в папке,
 * склеивает их по дням (для каждого дня берётся самая полная версия) и отдаёт
 * сайту сводные цифры в JSON: учеников (user_id) и просмотры (пары «ученик — урок») по дням,
 * регионам, школам, курсам, урокам и 15-минутным интервалам, а также просмотры учителей (строки без региона).
 * Подробно, что как считается, — в комментарии к aggregate_.
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
const STATE_VERSION = 9;                           // формат служебного файла (6 — с биллингом, 7 — с часами по курсам и школам, 8 — с разбивкой биллинга, 9 — ученики и просмотры-пары)
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
// С 16.11.2026 выгрузка «склеенная» (есть колонки user_id и lesson_id): к каждому токену «Моей школы»
// приклеены ВСЕ уроки, которые этот ученик открывал на Фоксфорде, плюс идут строки активности без токена
// (их пропускаем: у них нет ни региона, ни школы). У каждого токена свой user_id: токен — это первый вход ученика.
// Время и баллы для биллинга берутся из строки, где lesson_id совпадает с уроком токена.
// Время в этом формате такое же, как с 23.10 (+6 часов до Москвы) — сверено по токенам из обеих выгрузок.

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

// Часовой пояс региона (часы от UTC) — чтобы показывать, в какое время суток по местному времени открывают уроки.
// Ключ — код региона из выгрузки (в т. ч. дополнительные коды 90–99); всё, чего нет в списке, — UTC+3.
const REGION_UTC = {
  '39': 2,
  '18': 4, '30': 4, '63': 4, '64': 4, '73': 4,
  '2': 5, '45': 5, '56': 5, '59': 5, '66': 5, '72': 5, '74': 5, '86': 5, '89': 5, '96': 5,
  '55': 6,
  '4': 7, '17': 7, '19': 7, '22': 7, '24': 7, '42': 7, '54': 7, '70': 7,
  '3': 8, '38': 8,
  '14': 9, '28': 9, '75': 9,
  '25': 10, '27': 10, '79': 10,
  '49': 11, '65': 11,
  '41': 12, '87': 12
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
 * Что получает сайт (только дни начиная с START_DATE), версия 4:
 *  days    — по дням: views — просмотры учеников (пары «ученик — урок»), repeat — из них повторные,
 *            teachers — просмотры учителей (на сайте не показываются), newStudents — новые ученики;
 *            regions — просмотры по регионам, slots — по 15 минутам (за SLOT_DAYS дней), ch/sh — по часам местного времени;
 *  ls      — по дням: просмотры в связке «урок | номер школы»; из неё сайт считает курсы, уроки, школы и регионы;
 *  u1      — по дням: новые ученики по школам («номер школы» → учеников);
 *  us      — по дням: «курс | номер школы» → ученики, впервые открывшие урок этого курса в этот день;
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
  const days = {}, ls = {}, u1 = {}, us = {};
  let full = true; // все дни посчитаны по-новому (с учениками)
  keys.forEach(function (k) {
    const d = r.days[k];
    if (d.views == null) full = false;
    const day = { date: d.date, total: d.total, views: d.views != null ? d.views : d.students, teachers: d.teachers,
      repeat: d.repeat, newStudents: d.newStudents, firstAt: d.firstAt, lastAt: d.lastAt, regions: d.regions };
    if (d.ch) day.ch = d.ch; // просмотры по курсам и часам местного времени
    if (d.sh) { // то же по школам; школа — её номер в списке schools
      const sh = {};
      Object.keys(d.sh).forEach(function (x) { const p = x.lastIndexOf('|'), i = idx[x.slice(0, p)]; if (i != null) sh[i + '|' + x.slice(p + 1)] = d.sh[x]; });
      day.sh = sh;
    }
    if (k >= slotsFrom) day.slots = d.slots;
    days[k] = day;
    const o = {}, m = d.ls || {};
    Object.keys(m).forEach(function (x) { const p = x.indexOf('|'); o[x.slice(0, p) + '|' + idx[x.slice(p + 1)]] = m[x]; });
    ls[k] = o;
    if (d.u1) { const a = {}; Object.keys(d.u1).forEach(function (s) { if (idx[s] != null) a[idx[s]] = d.u1[s]; }); u1[k] = a; }
    if (d.us) { const a = {}; Object.keys(d.us).forEach(function (x) { const p = x.indexOf('|'), i = idx[x.slice(p + 1)]; if (i != null) a[x.slice(0, p) + '|' + i] = d.us[x]; }); us[k] = a; }
  });
  return { version: 4, start: START_DATE, generatedAt: r.generatedAt, filesTotal: r.filesTotal, latestFile: r.latestFile, pending: r.pending, errors: r.errors,
    students: full, days: days, ls: ls, u1: u1, us: us, schools: schools, lessonCourse: r.lessonCourse || {} };
}

/**
 * Урок → курс из каталога в репозитории сайта (catalog.json): у уроков, которые ученик открыл сам,
 * а не по токену, курса в выгрузке нет. Если каталог не загрузился, курс берётся только из токенов.
 */
let CATALOG_ = null;
function catalogLessons_() {
  if (CATALOG_) return CATALOG_;
  CATALOG_ = {};
  try {
    const res = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/catalog.json', { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const L = JSON.parse(res.getContentText()).lessons || {};
      Object.keys(L).forEach(function (id) { if (L[id] && L[id][0]) CATALOG_[id] = String(L[id][0]); });
    }
  } catch (err) { Logger.log('Каталог уроков не загрузился: ' + err); }
  return CATALOG_;
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
      const agg = aggregate_(rows, catalogLessons_());
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
      // Переход со старой версии: дни оставляем (сайт продолжает показывать цифры), а файлы перечитываем,
      // чтобы досчитать новые поля (биллинг, часы, разбивку биллинга)
      if (s && s.days && s.processed && s.version >= 5 && s.version < STATE_VERSION) {
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

/**
 * rows: массив массивов, первая строка — заголовки; courseOfLesson — урок → курс из каталога (для уроков, которых нет среди токенов).
 *
 * Что считаем (с 16.11.2026):
 *  ученик   — user_id с регионом (токен — это доступ ученика к платформе; в старых выгрузках без user_id ученик = токен);
 *             появляется в момент входа (created_at);
 *  просмотр — пара «ученик — урок»; время — timeStart (с какого-то момента это вход в практическую часть урока),
 *             а если его нет — created_at (так бывает только у урока, с которого ученик пришёл по токену).
 *             Повторные открытия того же урока в выгрузке не видны;
 *  повторный просмотр — второй, третий и следующие уроки одного ученика (по времени просмотра).
 *  Школа и регион — из токена ученика. Строки без региона — учителя: не учитываются (считаем только их число отдельно).
 * По дням: просмотры (views, repeat; по регионам, урокам × школам, 15-минуткам, часам), новые ученики
 * (newStudents; u1 — по школам), us — «курс|школа»: ученики, впервые открывшие урок курса в этот день.
 */
function aggregate_(rows, courseOfLesson) {
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
  // склеенный формат (с 16.11.2026): к строке токена приклеены все уроки ученика
  const cAl = head.indexOf('alias'), cLid = head.indexOf('lessonid'), cU = head.indexOf('userid');
  const isJoined = cAl >= 0 && cLid >= 0 && cL >= 0 && cU >= 0;
  const str = function (v) { return v == null ? '' : String(v).trim().replace(/\.0+$/, ''); };
  const schoolInfo = {}, lessonCourse = {};
  let bad = 0, maxMs = 0;

  // 1. Ученики, их токены и уроки
  const users = {}, order = [];
  const addPair = function (u, lid, t, fixed) {
    if (!lid) return;
    const p = u.pairs[lid];
    if (!p) { u.pairs[lid] = { t: t, fixed: fixed }; return; }
    if (fixed && !p.fixed) { u.pairs[lid] = { t: t, fixed: true }; return; }
    if (!p.fixed && t < p.t) p.t = t;
  };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[cT] == null || r[cT] === '') { if (!isJoined) bad++; continue; } // в склеенной выгрузке — активность без токена
    const t = toMsk_(r[cT], off);
    if (!t) { bad++; continue; }
    if (t.getTime() > maxMs) maxMs = t.getTime();
    const al = cAl >= 0 ? str(r[cAl]) : '';
    const uk = isJoined ? (str(r[cU]) || ('a' + al)) : ('r' + i);
    let u = users[uk];
    if (!u) {
      const rc = parseInt(r[cR], 10), code = isNaN(rc) ? '0' : String(rc);
      const sn = cS >= 0 ? str(r[cS]) : '';
      // номер школы уникален только внутри региона, поэтому ключ школы — «регион:номер»
      const sidRaw = (cSid >= 0 ? str(r[cSid]) : '') || sn, sid = sidRaw ? code + ':' + sidRaw : '';
      if (sid && code !== '0') schoolInfo[sid] = [sn || sid, code];
      u = users[uk] = { code: code, sid: sid, t0: t, toks: {}, pairs: {} };
      order.push(uk);
    }
    const lid = str(r[cL]), cid = cC >= 0 ? str(r[cC]) : '';
    if (lid && cid) lessonCourse[lid] = cid;
    if (t < u.t0) u.t0 = t;
    const tk = al || ('r' + i);
    let tok = u.toks[tk];
    if (!tok) { tok = u.toks[tk] = { t: t, lid: lid, cid: cid, own: isJoined ? null : r }; addPair(u, lid, t, true); }
    if (isJoined) {
      const aLid = str(r[cLid]);
      const ts = toMsk_(r[cTS], off);
      if (ts && ts.getTime() > maxMs) maxMs = ts.getTime();
      if (aLid === lid) { // свой урок токена: время просмотра — timeStart, если он есть (иначе остаётся created_at)
        if (!tok.own) tok.own = r;
        if (ts && !tok.tsSet) { tok.tsSet = true; u.pairs[lid] = { t: ts, fixed: true }; }
        continue;
      }
      if (aLid && ts) addPair(u, aLid, ts, false);
    }
  }

  // 2. Раскладываем по дням
  const days = {};
  const courseOf = function (lid) { return lessonCourse[lid] || (courseOfLesson && courseOfLesson[lid]) || ''; };
  const day = function (k, hm) {
    let d = days[k];
    if (!d) {
      d = days[k] = { date: k, total: 0, views: 0, repeat: 0, teachers: 0, newStudents: 0, firstAt: hm, lastAt: hm, partialStart: false,
        regions: {}, ls: {}, slots: [], ch: {}, sh: {}, u1: {}, us: {} };
      for (let s = 0; s < 96; s++) d.slots.push(0);
      if (isNew) { d.bill = { '1-6': 0, '7-11': 0, unknown: 0 }; d.bR = {}; d.bC = {}; } // уроки, попавшие в биллинг: всего, «регион|классы», по курсам
    }
    if (hm < d.firstAt) d.firstAt = hm;
    if (hm > d.lastAt) d.lastAt = hm;
    return d;
  };
  const keyOf = function (t) { return t.toISOString().slice(0, 10); };
  const hmOf = function (t) { return pad_(t.getUTCHours()) + ':' + pad_(t.getUTCMinutes()); };
  let minKey = null;
  for (let j = 0; j < order.length; j++) {
    const u = users[order[j]], code = u.code, sid = u.sid, teacher = code === '0';
    const tz = REGION_UTC[code] != null ? REGION_UTC[code] : 3;
    const firstCourse = {};
    const lids = Object.keys(u.pairs).filter(function (lid) { return !EXCLUDED_LESSONS.has(lid); }) // урок убран из каталога МШ
      .sort(function (x, y) { return u.pairs[x].t - u.pairs[y].t; });
    lids.forEach(function (lid, n) {
      const t = u.pairs[lid].t, k = keyOf(t), d = day(k, hmOf(t));
      d.total++;
      if (teacher) { d.teachers++; return; } // строки без региона — учителя
      d.views++;
      if (n > 0) d.repeat++; // второй и следующие уроки ученика
      d.regions[code] = (d.regions[code] || 0) + 1;
      d.slots[Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / 15)]++;
      const cid = courseOf(lid), lh = (t.getUTCHours() + tz - 3 + 24) % 24;
      if (cid) d.ch[cid + '|' + lh] = (d.ch[cid + '|' + lh] || 0) + 1;
      if (sid) d.sh[sid + '|' + lh] = (d.sh[sid + '|' + lh] || 0) + 1;
      const pk = lid + '|' + (sid || '?');
      d.ls[pk] = (d.ls[pk] || 0) + 1;
      if (cid && (!firstCourse[cid] || t < firstCourse[cid])) firstCourse[cid] = t;
      if (!minKey || k < minKey) minKey = k;
    });
    if (!teacher) { // ученик — в день входа (created_at)
      const d = day(keyOf(u.t0), hmOf(u.t0)), s = sid || '?';
      d.newStudents++;
      d.u1[s] = (d.u1[s] || 0) + 1;
      Object.keys(firstCourse).forEach(function (cid) { const dc = days[keyOf(firstCourse[cid])], x = cid + '|' + s; dc.us[x] = (dc.us[x] || 0) + 1; });
    }
    // биллинг — по уроку токена, на день входа (как и раньше)
    if (isNew && !teacher) Object.keys(u.toks).forEach(function (tk) {
      const tok = u.toks[tk];
      if (EXCLUDED_LESSONS.has(tok.lid)) return;
      billRow_(day(keyOf(tok.t), hmOf(tok.t)), tok.own, tok.cid, cTS, cTE, cP, code);
    });
  }
  if (minKey) days[minKey].partialStart = true; // первый день файла мог начаться не с полуночи
  Object.keys(days).forEach(function (k) { days[k].src = maxMs; }); // момент выгрузки: чем больше, тем свежее
  return { days: days, schoolInfo: schoolInfo, lessonCourse: lessonCourse, bad: bad, users: order.length };
}

/** Засчитывает просмотр ученика в биллинг дня, если он проходит условия. */
function billRow_(d, r, cid, cTS, cTE, cP, code) {
  const grade = COURSE_GRADES[cid];
  if (!grade) { d.bill.unknown++; return; }
  if (!r) return;                                         // у токена нет активности по этому уроку — урок не начинали
  const a = toMsk_(r[cTS], 0), b = toMsk_(r[cTE], 0);
  if (!a || !b) return;                                   // урок не начинали
  const minutes = (b.getTime() - a.getTime()) / 60000, norm = BILL_NORM_MIN(grade);
  if (minutes < BILL_MIN_SHARE * norm || minutes > norm) return;
  const pts = parseFloat(String(r[cP] == null ? '' : r[cP]).replace(',', '.'));
  if (!(pts > BILL_MIN_POINTS)) return;
  const band = BILL_BAND(grade);
  d.bill[band]++;
  if (d.bR) d.bR[code + '|' + band] = (d.bR[code + '|' + band] || 0) + 1;
  if (d.bC) d.bC[cid] = (d.bC[cid] || 0) + 1;
}

/** Ответ вкладке «Биллинг»: число засчитанных уроков по месяцам и группам классов. */
function billingView_(state) {
  const keys = Object.keys(state.days || {}).filter(function (k) { return k >= START_DATE; }).sort();
  const months = {};
  let latest = null, noData = 0;
  keys.forEach(function (k) {
    const d = state.days[k], m = k.slice(0, 7);
    const mo = months[m] || (months[m] = { month: m, from: k, to: k, lessons: { '1-6': 0, '7-11': 0 }, unknown: 0, daysWithoutData: 0, byRegion: {}, byCourse: {} });
    mo.to = k;
    if (!d.bill) { mo.daysWithoutData++; noData++; return; }
    mo.lessons['1-6'] += d.bill['1-6'] || 0; mo.lessons['7-11'] += d.bill['7-11'] || 0; mo.unknown += d.bill.unknown || 0;
    // разбивка: засчитанные уроки и все просмотры учеников за те же дни (для доли попадания в биллинг)
    const reg = function (c) { return mo.byRegion[c] || (mo.byRegion[c] = { '1-6': 0, '7-11': 0, views: 0 }); };
    Object.keys(d.regions || {}).forEach(function (c) { reg(c).views += d.regions[c]; });
    Object.keys(d.bR || {}).forEach(function (x) { const p = x.indexOf('|'); reg(x.slice(0, p))[x.slice(p + 1)] += d.bR[x]; });
    const crs = function (c) { return mo.byCourse[c] || (mo.byCourse[c] = { lessons: 0, views: 0 }); };
    Object.keys(d.ch || {}).forEach(function (x) { crs(x.slice(0, x.indexOf('|'))).views += d.ch[x]; });
    Object.keys(d.bC || {}).forEach(function (c) { crs(c).lessons += d.bC[c]; });
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
  const find = function (n) { return entries.filter(function (x) { return x.name === n; })[0] || null; };
  const sheet = find(sheetNames[0]), sstEntry = find('xl/sharedStrings.xml');
  const sst = parseSst_(sstEntry ? sstEntry.text() : null);
  // Небольшие листы — проверенным способом (Utilities.ungzip). Большие (склеенная выгрузка с 16.11 —
  // около 150 МБ текста) так не распаковать: у Apps Script лимит 50 МБ на blob. Их распаковываем сами
  // кусками по 1 МБ и сразу разбираем строки, не держа весь текст листа в памяти.
  if (sheet.usize <= XLSX_STREAM_FROM) return parseSheetXml_(sheet.text(), sst);
  return readSheetStream_(sheet, sst);
}

const XLSX_STREAM_FROM = 30 * 1024 * 1024; // с какого размера листа (байт без сжатия) читаем его кусками

/**
 * Потоковое чтение листа. Чтобы не тратить память на строки, которые всё равно не нужны,
 * оставляем только строки с заполненным created_at (если такая колонка есть): в склеенной
 * выгрузке две трети строк — активность на Фоксфорде без токена «Моей школы».
 */
function readSheetStream_(entry, sst) {
  const rows = [];
  let cT = -1, text = '';
  const keep = function (row) {
    if (!rows.length) { cT = row.map(normKey_).indexOf('createdat'); rows.push(row); return; }
    if (cT < 0 || (row[cT] != null && row[cT] !== '')) rows.push(row);
  };
  const dec = utf8Decoder_();
  const feed = function (bytes, last) {
    text += dec(bytes, last);
    const e = text.lastIndexOf('</row>');
    if (e < 0) return;
    parseRows_(text.slice(0, e + 6), sst, keep);
    text = text.slice(e + 6);
  };
  if (entry.method === 0) feed(entry.raw(), true);
  else if (entry.method === 8) { inflateRaw_(entry.raw(), function (chunk) { feed(chunk, false); }); feed(new Uint8Array(0), true); }
  else throw new Error('Неизвестный способ сжатия в xlsx: ' + entry.method);
  return rows;
}

/** Декодер UTF-8 для кусков: символ, разрезанный границей куска, доклеивается к следующему. */
function utf8Decoder_() {
  let carry = null;
  return function (u8, last) {
    let a = u8;
    if (carry) { a = new Uint8Array(carry.length + u8.length); a.set(carry); a.set(u8, carry.length); carry = null; }
    let end = a.length;
    if (!last && end) {
      let i = end - 1, k = 0;
      while (i > 0 && k < 3 && (a[i] & 0xc0) === 0x80) { i--; k++; }
      const c = a[i], need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
    }
    if (end < a.length) carry = a.slice(end);
    const units = new Uint16Array(end);
    let n = 0;
    for (let i = 0; i < end;) {
      let c = a[i++];
      if (c >= 0xf0) {
        c = (((c & 0x07) << 18) | ((a[i++] & 0x3f) << 12) | ((a[i++] & 0x3f) << 6) | (a[i++] & 0x3f)) - 0x10000;
        units[n++] = 0xd800 + (c >> 10); c = 0xdc00 + (c & 0x3ff);
      } else if (c >= 0xe0) c = ((c & 0x0f) << 12) | ((a[i++] & 0x3f) << 6) | (a[i++] & 0x3f);
      else if (c >= 0xc0) c = ((c & 0x1f) << 6) | (a[i++] & 0x3f);
      units[n++] = c;
    }
    let s = '';
    for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, units.subarray(i, Math.min(n, i + 8192)));
    return s;
  };
}

/**
 * Распаковка deflate (RFC 1951) кусками: onChunk получает очередные ≤ 1 МБ распакованных байт
 * (Uint8Array; использовать сразу, буфер потом перезаписывается).
 */
function inflateRaw_(inp, onChunk) {
  const W = 32768, CH = 1 << 20, buf = new Uint8Array(W + CH);
  let op = 0, from = 0, ip = 0, bb = 0, bc = 0;
  const flush = function () {
    if (op > from) onChunk(buf.subarray(from, op));
    if (op > W) { buf.copyWithin(0, op - W, op); op = W; }
    from = op;
  };
  const need = function (n) { while (bc < n) { bb |= (ip < inp.length ? inp[ip] : 0) << bc; ip++; bc += 8; } };
  const bits = function (n) { if (!n) return 0; need(n); const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
  const build = function (lens, n) {
    let max = 0;
    for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
    const cnt = new Uint16Array(16), next = new Uint16Array(16);
    for (let i = 0; i < n; i++) cnt[lens[i]]++;
    cnt[0] = 0;
    let code = 0;
    for (let b = 1; b <= 15; b++) { code = (code + cnt[b - 1]) << 1; next[b] = code; }
    const m = max || 1, size = 1 << m, tab = new Int32Array(size);
    for (let i = 0; i < n; i++) {
      const l = lens[i];
      if (!l) continue;
      let c = next[l]++, r = 0;
      for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
      for (let j = r; j < size; j += 1 << l) tab[j] = (i << 4) | l;
    }
    return { t: tab, m: m };
  };
  const dec = function (h) {
    need(h.m);
    const e = h.t[bb & ((1 << h.m) - 1)], l = e & 15;
    if (!l) throw new Error('Файл повреждён: ошибка в сжатых данных xlsx');
    bb >>>= l; bc -= l;
    return e >> 4;
  };
  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let fixL = null, fixD = null, last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {                                   // блок без сжатия
      bits(bc & 7);
      const len = bits(16); bits(16);
      for (let k = 0; k < len; k++) {
        let v;
        if (bc >= 8) v = bits(8); else v = inp[ip++];
        buf[op++] = v; if (op === buf.length) flush();
      }
      continue;
    }
    let L, D;
    if (type === 1) {                                   // фиксированные коды
      if (!fixL) {
        const l = new Uint8Array(288), d = new Uint8Array(30);
        for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        for (let i = 0; i < 30; i++) d[i] = 5;
        fixL = build(l, 288); fixD = build(d, 30);
      }
      L = fixL; D = fixD;
    } else if (type === 2) {                            // свои коды в начале блока
      const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hc; i++) cl[ORD[i]] = bits(3);
      const C = build(cl, 19), lens = new Uint8Array(hl + hd);
      for (let i = 0; i < hl + hd;) {
        const s = dec(C);
        if (s < 16) { lens[i++] = s; continue; }
        let rep, v = 0;
        if (s === 16) { if (!i) throw new Error('Файл повреждён: ошибка в сжатых данных xlsx'); v = lens[i - 1]; rep = 3 + bits(2); }
        else if (s === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        while (rep-- && i < hl + hd) lens[i++] = v;
      }
      L = build(lens.subarray(0, hl), hl); D = build(lens.subarray(hl), hd);
    } else throw new Error('Файл повреждён: ошибка в сжатых данных xlsx');
    for (;;) {
      const s = dec(L);
      if (s < 256) { buf[op++] = s; if (op === buf.length) flush(); continue; }
      if (s === 256) break;
      const li = s - 257, len = LB[li] + bits(LE[li]);
      const di = dec(D), dist = DB[di] + bits(DE[di]);
      for (let k = 0; k < len; k++) { buf[op] = buf[op - dist]; op++; if (op === buf.length) flush(); }
    }
  }
  flush();
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
    const begin = function () { return en.local + 30 + u16(en.local + 26) + u16(en.local + 28); };
    return {
      name: en.name,
      method: en.method,
      usize: en.usize,
      raw: function () { // сжатые данные как Uint8Array — для потоковой распаковки
        const start = begin(), out = new Uint8Array(en.csize);
        for (let i = 0; i < en.csize; i++) out[i] = b[start + i] & 0xff;
        return out;
      },
      text: function () {
        const start = begin();
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

function parseSst_(sstXml) {
  const sst = [];
  if (sstXml) { let m; const re = /<si>([\s\S]*?)<\/si>/g; while ((m = re.exec(sstXml))) sst.push(joinT_(m[1])); }
  return sst;
}

function parseSheetXml_(xml, sst) {
  const rows = [];
  parseRows_(xml, sst, function (row) { rows.push(row); });
  return rows;
}

/** Разбирает строки листа из куска XML (кусок должен заканчиваться на </row>) и отдаёт их по одной. */
function parseRows_(xml, sst, onRow) {
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
    onRow(row);
  }
}
