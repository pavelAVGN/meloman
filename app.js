'use strict';
const $ = s => document.querySelector(s);
const audio = $('#audio');

// ---------- Хранилище (IndexedDB: песни вместе с аудиофайлом) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('meloman', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('songs', mode);
    const req = fn(t.objectStore('songs'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const getSong = id => tx('readonly', s => s.get(id));
const putSong = song => tx('readwrite', s => s.put(song));
const delSong = id => tx('readwrite', s => s.delete(id));

// ---------- LRC ----------
const TS = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const toSec = (m, s) => +m * 60 + parseFloat(String(s).replace(':', '.'));
const splitWords = t => t.split(/\s+/).filter(Boolean);

function parseLrc(txt) {
  let offset = 0;
  const out = [];
  for (const raw of txt.split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    const times = [...raw.matchAll(TS)];
    if (!times.length) continue;
    let body = raw.replace(TS, '').trim();
    let words = null;
    if (/<\d+:\d+/.test(body)) { // расширенный LRC с таймингом слов
      words = [];
      const re = /<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g;
      let m;
      while ((m = re.exec(body))) for (const w of splitWords(m[3])) words.push({ t: toSec(m[1], m[2]) - offset, w });
      body = words.map(x => x.w).join(' ');
    }
    for (const t of times) out.push({ t: toSec(t[1], t[2]) - offset, text: body, words: times.length > 1 ? null : words });
  }
  out.sort((a, b) => a.t - b.t);
  out.forEach((l, i) => { l.end = i + 1 < out.length ? out[i + 1].t : l.t + 6; });
  return out.filter(l => l.text); // пустые строки нужны были только как конец предыдущей
}
const hasTimestamps = txt => /\[\d+:\d+/.test(txt);
const fmt = s => { const m = Math.floor(s / 60), x = (s - m * 60).toFixed(2).padStart(5, '0'); return `${String(m).padStart(2, '0')}:${x}`; };

// ---------- Пропуски ----------
const norm = t => t.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, '').trim();
const letters = w => w.replace(/[^a-zа-яё0-9]/gi, '').length;

function makeGaps(lines, count) {
  const seen = new Set(), cand = [];
  lines.forEach((l, i) => {
    const key = norm(l.text);
    // берём строки, где 3+ слова, и которые раньше не звучали (иначе ответ уже на экране был)
    if (i > 0 && splitWords(l.text).length >= 3 && !seen.has(key)) cand.push(i);
    seen.add(key);
  });
  count = Math.min(count, cand.length);
  const gaps = [];
  for (let k = 0; k < count; k++) { // равномерно по песне
    const a = Math.floor(k * cand.length / count), b = Math.floor((k + 1) * cand.length / count);
    const li = cand[a + Math.floor(Math.random() * (b - a))];
    const w = splitWords(lines[li].text);
    let m = w.length >= 6 && Math.random() < 0.5 ? 2 : 1;
    while (m < w.length - 1 && letters(w.slice(w.length - m).join('')) < 4) m++; // не прячем одно «а»/«хей»
    const from = w.length - m;
    gaps.push({ line: li, from, time: gapTime(lines[li], from), done: false });
  }
  return gaps;
}
function gapTime(l, from) {
  if (l.words && l.words[from]) return l.words[from].t - 0.08;
  const w = splitWords(l.text);
  const before = w.slice(0, from).join(' ').length + 1;
  const dur = Math.min(l.end - l.t, 8);
  return l.t + dur * (before / (l.text.length + 1)) - 0.15;
}

// ---------- Счёт ----------
let teams = JSON.parse(localStorage.getItem('meloman.teams') || 'null') || { names: ['Команда 1', 'Команда 2'], score: [0, 0] };
const saveTeams = () => localStorage.setItem('meloman.teams', JSON.stringify(teams));
function renderScore() {
  $('#score').innerHTML = teams.names.map((n, i) =>
    `<input data-i="${i}" value="${esc(n)}"><b>${teams.score[i]}</b>`).join('<span>:</span>') +
    '<button id="resetScore" title="Обнулить счёт">0</button>';
  $('#score').querySelectorAll('input').forEach(inp => inp.onchange = () => { teams.names[inp.dataset.i] = inp.value || `Команда ${+inp.dataset.i + 1}`; saveTeams(); });
  $('#resetScore').onclick = () => { if (confirm('Обнулить счёт?')) { teams.score = [0, 0]; saveTeams(); renderScore(); } };
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Экраны ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
  if (id !== 'play' && id !== 'tapper') { audio.pause(); releaseWake(); }
  window.scrollTo(0, 0);
}

async function renderLibrary() {
  const songs = (await getAll()).sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  $('#emptyHint').hidden = songs.length > 0;
  $('#songList').innerHTML = songs.map(s => `
    <li><div class="meta"><b>${esc(s.title)}</b><small>${esc(s.artist || '')}</small></div>
    <button data-play="${s.id}" class="big">▶</button>
    <button data-edit="${s.id}">✎</button>
    <button data-del="${s.id}">🗑</button></li>`).join('');
  show('library');
}
$('#songList').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.play) startGame(b.dataset.play);
  if (b.dataset.edit) openEditor(b.dataset.edit);
  if (b.dataset.del && confirm('Удалить песню?')) { await delSong(b.dataset.del); renderLibrary(); }
};
$('#goHome').onclick = renderLibrary;
$('#addSong').onclick = () => openEditor(null);

// ---------- Редактор ----------
let editing = null, newAudio = null;
async function openEditor(id) {
  editing = id ? await getSong(id) : { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), gaps: 3 };
  newAudio = null;
  $('#edTitle').textContent = id ? 'Редактировать песню' : 'Новая песня';
  $('#fTitle').value = editing.title || '';
  $('#fArtist').value = editing.artist || '';
  $('#fLrc').value = editing.lrc || '';
  $('#fGaps').value = editing.gaps || 3;
  $('#fAudio').value = '';
  $('#audioName').textContent = editing.audioName ? `Сейчас: ${editing.audioName}` : '';
  $('#lrcStatus').textContent = '';
  show('editor');
}
$('#fAudio').onchange = () => {
  newAudio = $('#fAudio').files[0] || null;
  if (newAudio && !$('#fTitle').value) $('#fTitle').value = newAudio.name.replace(/\.[^.]+$/, '');
};
$('#fLrcFile').onchange = async e => { const f = e.target.files[0]; if (f) { $('#fLrc').value = await f.text(); lrcInfo(); } e.target.value = ''; };
$('#fLrc').oninput = lrcInfo;
function lrcInfo() {
  const t = $('#fLrc').value;
  $('#lrcStatus').textContent = !t.trim() ? '' : hasTimestamps(t)
    ? `Строк с таймингом: ${parseLrc(t).length}`
    : 'В тексте нет таймингов — нажми «Разметить тапами».';
}
$('#findLrc').onclick = async () => {
  const title = $('#fTitle').value.trim(), artist = $('#fArtist').value.trim();
  if (!title) return alert('Сначала впиши название песни');
  $('#lrcStatus').textContent = 'Ищу на lrclib.net…';
  try {
    const q = new URLSearchParams({ track_name: title });
    if (artist) q.set('artist_name', artist);
    const r = await fetch('https://lrclib.net/api/search?' + q);
    const hit = (await r.json()).find(x => x.syncedLyrics);
    if (!hit) { $('#lrcStatus').textContent = 'Текст с таймингом не нашёлся. Вставь его вручную или разметь тапами.'; return; }
    $('#fLrc').value = hit.syncedLyrics;
    if (!artist) $('#fArtist').value = hit.artistName || '';
    $('#lrcStatus').textContent = `Нашёл: ${hit.artistName} — ${hit.trackName}. Проверь, что это та же версия песни.`;
  } catch { $('#lrcStatus').textContent = 'Не получилось подключиться к lrclib.net'; }
};
$('#cancelEdit').onclick = renderLibrary;
$('#saveSong').onclick = async () => {
  const lrc = $('#fLrc').value;
  if (!$('#fTitle').value.trim()) return alert('Впиши название');
  if (!newAudio && !editing.audio) return alert('Выбери аудиофайл');
  if (!parseLrc(lrc).length) return alert('Нужен текст с таймингами (LRC). Можно разметить тапами.');
  Object.assign(editing, {
    title: $('#fTitle').value.trim(), artist: $('#fArtist').value.trim(), lrc,
    gaps: Math.max(1, Math.min(15, +$('#fGaps').value || 3)),
  });
  if (newAudio) { editing.audio = newAudio; editing.audioName = newAudio.name; }
  await putSong(editing);
  renderLibrary();
};

// ---------- Разметка тапами ----------
let tapLines = [], tapTimes = [];
$('#tapSync').onclick = () => {
  const src = newAudio || editing.audio;
  if (!src) return alert('Сначала выбери аудиофайл');
  tapLines = $('#fLrc').value.split(/\r?\n/).map(l => l.replace(TS, '').replace(/<[^>]+>/g, '').trim()).filter(l => l && !/^\[\w+:/.test(l));
  if (!tapLines.length) return alert('Вставь текст песни (просто строки, без таймингов)');
  tapTimes = [];
  setAudio(src);
  $('#tapBtn').textContent = '▶ Старт';
  tapRender();
  show('tapper');
};
function tapRender() {
  $('#tapPrev').textContent = tapLines[tapTimes.length - 1] || '';
  $('#tapNext').textContent = tapLines[tapTimes.length] || '— конец текста —';
}
$('#tapBtn').onclick = () => {
  if (audio.paused) { audio.play(); $('#tapBtn').textContent = 'СТРОКА ▸'; return; }
  if (tapTimes.length < tapLines.length) tapTimes.push(audio.currentTime);
  tapRender();
  if (tapTimes.length === tapLines.length) $('#tapBtn').textContent = 'Все строки размечены — жми «Готово»';
};
$('#tapUndo').onclick = () => { if (tapTimes.length) { const t = tapTimes.pop(); audio.currentTime = Math.max(0, t - 3); tapRender(); } };
$('#tapCancel').onclick = () => { audio.pause(); show('editor'); };
$('#tapDone').onclick = () => {
  audio.pause();
  if (tapTimes.length) {
    const end = audio.currentTime;
    $('#fLrc').value = tapTimes.map((t, i) => `[${fmt(t)}]${tapLines[i]}`).join('\n') + (tapTimes.length === tapLines.length ? `\n[${fmt(end)}]` : '');
  }
  lrcInfo();
  show('editor');
};

// ---------- Игра ----------
let song = null, lines = [], gaps = [], curIdx = -2, activeGap = null, revealed = new Set(), raf = 0, audioUrl = null;

function setAudio(blob) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
}

async function startGame(id) {
  song = await getSong(id);
  lines = parseLrc(song.lrc);
  setAudio(song.audio);
  $('#playTitle').textContent = `${song.artist ? song.artist + ' — ' : ''}${song.title}`;
  newGaps();
  show('play');
  requestWake();
  loop();
}
function newGaps() {
  gaps = makeGaps(lines, song.gaps || 3);
  revealed = new Set(); activeGap = null; curIdx = -2;
  $('#gapPanel').hidden = true;
  gapInfo();
}
const gapOn = i => gaps.find(g => g.line === i);
function gapInfo() {
  const done = gaps.filter(g => g.done).length;
  $('#gapInfo').textContent = gaps.length ? `Пропуски: ${done} / ${gaps.length}` : 'В тексте нет строк для пропусков';
}

function lineHtml(i) {
  const l = lines[i]; if (!l) return '';
  const w = splitWords(l.text), g = gapOn(i);
  if (!g) return esc(l.text);
  const head = esc(w.slice(0, g.from).join(' '));
  const tail = w.slice(g.from);
  if (revealed.has(i)) return `${head} <span class="answer">${esc(tail.join(' '))}</span>`;
  return `${head} ${tail.map(x => `<span class="blank">${' '.repeat(Math.max(3, letters(x)))}</span>`).join(' ')}`;
}
function renderLines(i) {
  $('#lineCur').innerHTML = i >= 0 ? lineHtml(i) : '';
  $('#lineNxt').innerHTML = lineHtml(i + 1);
}
function progress(l, now) {
  if (l.words) {
    const n = l.words.filter(x => x.t <= now).length;
    return n / l.words.length * 100;
  }
  return Math.max(0, Math.min(1, (now - l.t) / Math.min(l.end - l.t, 8))) * 100;
}

function loop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    const now = audio.currentTime;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= now; k++) i = k;
    if (i !== curIdx) { curIdx = i; renderLines(i); }
    if (i >= 0) $('#lineCur').style.setProperty('--p', progress(lines[i], now).toFixed(1) + '%');
    if (audio.duration) $('#pSeek').value = Math.round(now / audio.duration * 1000);
    checkGap();
    raf = requestAnimationFrame(tick);
  };
  tick();
}
// стоп на пропуске; ещё и по timeupdate — он идёт, даже когда анимация на паузе (свёрнутое окно)
function checkGap() {
  if (audio.paused || activeGap || $('#play').hidden) return;
  const now = audio.currentTime;
  const g = gaps.find(g => !g.done && now >= g.time && now < g.time + 1.5);
  if (g) {
    curIdx = -2; // перерисовать строки
    for (let k = 0; k < lines.length && lines[k].t <= now; k++) curIdx = k;
    renderLines(curIdx);
    hitGap(g);
  }
}
audio.addEventListener('timeupdate', checkGap);

function hitGap(g) {
  audio.pause();
  activeGap = g;
  // на стопе подсвечиваем только видимую часть строки, чтобы не подсказывать
  $('#lineCur').style.setProperty('--p', '100%');
  $('#gpAsk').hidden = false;
  $('#gpScore').hidden = true;
  $('#gapPanel').hidden = false;
  if (navigator.vibrate) navigator.vibrate(200);
}
$('#gpReveal').onclick = () => {
  const g = activeGap; if (!g) return;
  revealed.add(g.line); renderLines(curIdx);
  $('#gpAnswer').textContent = splitWords(lines[g.line].text).slice(g.from).join(' ');
  $('#gpTeams').innerHTML = teams.names.map((n, i) => `<button class="big" data-team="${i}">+1 ${esc(n)}</button>`).join('') + '<button data-team="-1">Никто</button>';
  $('#gpAsk').hidden = true;
  $('#gpScore').hidden = false;
};
$('#gpTeams').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const t = +b.dataset.team;
  if (t >= 0) { teams.score[t]++; saveTeams(); renderScore(); }
  activeGap.done = true; activeGap = null;
  $('#gapPanel').hidden = true;
  gapInfo();
  audio.play();
};
$('#gpRepeat').onclick = () => {
  const g = activeGap; if (!g) return;
  activeGap = null;
  $('#gapPanel').hidden = true;
  audio.currentTime = Math.max(0, lines[g.line].t - 4);
  audio.play();
};

$('#pToggle').onclick = () => { if (activeGap) return; audio.paused ? audio.play() : audio.pause(); };
audio.onplay = () => $('#pToggle').textContent = '❚❚';
audio.onpause = () => $('#pToggle').textContent = '▶';
audio.onended = () => { $('#pToggle').textContent = '▶'; };
$('#pSeek').oninput = () => {
  if (!audio.duration) return;
  activeGap = null; $('#gapPanel').hidden = true;
  audio.currentTime = $('#pSeek').value / 1000 * audio.duration;
};
$('#pBack').onclick = () => { cancelAnimationFrame(raf); renderLibrary(); };
$('#pReshuffle').onclick = () => { if (confirm('Сделать новые пропуски и начать песню сначала?')) { audio.pause(); audio.currentTime = 0; newGaps(); } };

// ---------- Экран не гаснет во время игры ----------
let wake = null;
async function requestWake() { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWake() { wake?.release().catch(() => {}); wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#play').hidden) requestWake(); });

// ---------- Старт ----------
renderScore();
renderLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
