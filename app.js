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
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------- Пропуски ----------
const norm = t => t.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, '').trim();
const letters = w => w.replace(/[^a-zа-яё0-9]/gi, '').length;

function makeGaps(lines, count) {
  const seen = new Set(), cand = [];
  lines.forEach((l, i) => {
    const key = norm(l.text);
    // берём строки, где 3+ слова, и которые раньше не звучали (иначе ответ уже был на экране)
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

// ---------- Плеер: свой файл или YouTube ----------
let yt = null, ytApi = null, ytState = -1, audioUrl = null;

function loadYtApi() {
  if (!ytApi) ytApi = new Promise((res, rej) => {
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; rej(new Error('Не удалось загрузить YouTube. Проверь интернет или включи VPN.')); };
    document.head.append(s);
  });
  return ytApi;
}
async function ytLoad(id) {
  await loadYtApi();
  if (yt) { yt.cueVideoById(id); ytState = 5; return; }
  await new Promise(res => {
    yt = new YT.Player('ytPlayer', {
      videoId: id,
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: res,
        onStateChange: e => { ytState = e.data; onPlayState(); },
        onError: e => alert({ 101: 'Автор запретил показывать этот ролик в других приложениях — выбери другой (например, «Official Audio» или «Lyrics»).', 150: 'Автор запретил показывать этот ролик в других приложениях — выбери другой (например, «Official Audio» или «Lyrics»).', 100: 'Ролик не найден или удалён.', 2: 'Неверная ссылка на ролик.' }[e.data] || 'YouTube не смог воспроизвести ролик.'),
      },
    });
  });
}

const P = {
  kind: 'file',
  get time() { return this.kind === 'yt' ? (yt && yt.getCurrentTime ? yt.getCurrentTime() : 0) : audio.currentTime; },
  set time(t) { if (this.kind === 'yt') { if (yt && yt.seekTo) yt.seekTo(t, true); } else audio.currentTime = t; },
  get paused() { return this.kind === 'yt' ? !(ytState === 1 || ytState === 3) : audio.paused; },
  get duration() { return this.kind === 'yt' ? (yt && yt.getDuration ? yt.getDuration() : 0) : audio.duration || 0; },
  play() { if (this.kind === 'yt') { if (yt && yt.playVideo) yt.playVideo(); } else audio.play().catch(() => {}); },
  pause() { if (this.kind === 'yt') { if (yt && yt.pauseVideo) yt.pauseVideo(); } else audio.pause(); },
};

async function setSource(src) { // src: {source:'yt', ytId} | {audio: Blob}
  P.pause();
  if (src.source === 'yt') {
    P.kind = 'yt';
    audio.removeAttribute('src');
    await ytLoad(src.ytId);
  } else {
    if (yt && yt.stopVideo) yt.stopVideo();
    P.kind = 'file';
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(src.audio);
    audio.src = audioUrl;
  }
}
function onPlayState() {
  $('#pToggle').textContent = P.paused ? '▶' : '❚❚';
}
audio.onplay = audio.onpause = audio.onended = onPlayState;

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
const decodeHtml = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };

// ---------- Экраны ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
  if (id !== 'play' && id !== 'tapper') { P.pause(); releaseWake(); }
  $('#ytBox').classList.toggle('off', !(P.kind === 'yt' && (id === 'play' || id === 'tapper')));
  window.scrollTo(0, 0);
}

async function renderLibrary() {
  const songs = (await getAll()).sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  $('#emptyHint').hidden = songs.length > 0;
  $('#songList').innerHTML = songs.map(s => `
    <li><div class="meta"><b>${esc(s.title)}</b><small>${esc(s.artist || '')}${s.source === 'yt' ? ' · YouTube' : ''}</small></div>
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
let editing = null, newAudio = null, editSource = 'file';
async function openEditor(id) {
  editing = id ? await getSong(id) : { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), gaps: 3 };
  newAudio = null;
  $('#edTitle').textContent = id ? 'Редактировать песню' : 'Новая песня';
  $('#fTitle').value = editing.title || '';
  $('#fArtist').value = editing.artist || '';
  $('#fLrc').value = editing.lrc || '';
  $('#fGaps').value = editing.gaps || 3;
  $('#fAudio').value = '';
  $('#fYt').value = '';
  $('#ytKey').value = localStorage.getItem('meloman.ytkey') || '';
  $('#ytResults').innerHTML = '';
  $('#ytStatus').textContent = '';
  $('#audioName').textContent = editing.audioName ? `Сейчас: ${editing.audioName}` : '';
  $('#lrcStatus').textContent = '';
  setEditSource(editing.source || 'file');
  showPicked();
  show('editor');
}
function setEditSource(s) {
  editSource = s;
  $('#srcSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.src === s));
  $('#srcFile').hidden = s !== 'file';
  $('#srcYt').hidden = s !== 'yt';
}
$('#srcSeg').onclick = e => { const b = e.target.closest('button'); if (b) setEditSource(b.dataset.src); };
const showPicked = () => { $('#ytPicked').textContent = editing.ytId ? `Выбран ролик: ${editing.ytTitle || editing.ytId}` : ''; };

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

// Поиск текста на lrclib.net (бесплатно, без ключа)
async function findLyrics() {
  const title = $('#fTitle').value.trim(), artist = $('#fArtist').value.trim();
  if (!title) { $('#lrcStatus').textContent = 'Впиши название песни, чтобы найти текст.'; return false; }
  $('#lrcStatus').textContent = 'Ищу текст на lrclib.net…';
  try {
    const q = new URLSearchParams({ track_name: title });
    if (artist) q.set('artist_name', artist);
    let list = await (await fetch('https://lrclib.net/api/search?' + q)).json();
    if (!list.some(x => x.syncedLyrics)) list = await (await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${artist} ${title}` }))).json();
    const hit = list.find(x => x.syncedLyrics);
    if (!hit) { $('#lrcStatus').textContent = 'Текст с таймингом не нашёлся. Вставь его вручную или разметь тапами.'; return false; }
    $('#fLrc').value = hit.syncedLyrics;
    editing.lrcDuration = hit.duration || null;
    if (!artist) $('#fArtist').value = hit.artistName || '';
    $('#lrcStatus').textContent = `Текст: ${hit.artistName} — ${hit.trackName}${hit.duration ? ` (${mmss(hit.duration)})` : ''}.`;
    return true;
  } catch { $('#lrcStatus').textContent = 'Не получилось подключиться к lrclib.net'; return false; }
}
$('#findLrc').onclick = findLyrics;

// Поиск на YouTube
const ytIdFrom = s => (s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || [])[1] || (/^[\w-]{11}$/.test(s) ? s : null);
const isoDur = s => { const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const ytStatus = t => { $('#ytStatus').textContent = t; };
$('#ytKey').onchange = () => localStorage.setItem('meloman.ytkey', $('#ytKey').value.trim());

$('#ytSearch').onclick = async () => {
  const typed = $('#fYt').value.trim();
  const id = ytIdFrom(typed);
  const q = (!id && typed) || `${$('#fArtist').value} ${$('#fTitle').value}`.trim();
  $('#ytOpen').href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
  if (!$('#fLrc').value.trim() && $('#fTitle').value.trim()) findLyrics(); // текст ищем параллельно

  if (id) { pickYt(id, 'ролик по ссылке'); ytStatus(''); return; }
  if (!q) return ytStatus('Впиши название песни (и исполнителя) или вставь ссылку на ролик.');
  const key = localStorage.getItem('meloman.ytkey');
  if (!key) return ytStatus('Чтобы искать по названию, добавь ключ YouTube (ниже). Или нажми «Открыть YouTube», найди клип, скопируй ссылку и вставь в поле выше.');
  ytStatus('Ищу на YouTube…');
  try {
    const k = encodeURIComponent(key);
    const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=${encodeURIComponent(q)}&key=${k}`)).json();
    if (s.error) throw new Error(s.error.message);
    const items = s.items || [];
    if (!items.length) return ytStatus('Ничего не нашлось.');
    const d = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${items.map(i => i.id.videoId).join(',')}&key=${k}`)).json();
    const dur = Object.fromEntries((d.items || []).map(v => [v.id, isoDur(v.contentDetails.duration)]));
    const target = editing.lrcDuration;
    $('#ytResults').innerHTML = items.map(i => {
      const vid = i.id.videoId, sec = dur[vid];
      const near = target && sec && Math.abs(sec - target) <= 4;
      return `<li data-id="${vid}" data-title="${esc(decodeHtml(i.snippet.title))}" class="${vid === editing.ytId ? 'on' : ''}">
        <img src="${i.snippet.thumbnails.default.url}" alt="">
        <div><b>${esc(decodeHtml(i.snippet.title))}</b>
        <small>${esc(decodeHtml(i.snippet.channelTitle))}${sec ? ` · <span class="${near ? 'near' : ''}">${mmss(sec)}${near ? ' ✓ как у текста' : ''}</span>` : ''}</small></div></li>`;
    }).join('');
    ytStatus(target ? `Выбери ролик. Лучше брать тот, что по длине как текст (${mmss(target)}) — тогда текст совпадёт.` : 'Выбери ролик.');
  } catch (e) { ytStatus('Ошибка поиска: ' + e.message); }
};
$('#ytResults').onclick = e => {
  const li = e.target.closest('li'); if (!li) return;
  pickYt(li.dataset.id, li.dataset.title);
  $('#ytResults').querySelectorAll('li').forEach(x => x.classList.toggle('on', x === li));
};
function pickYt(id, title) {
  editing.ytId = id; editing.ytTitle = title;
  showPicked();
}

$('#cancelEdit').onclick = renderLibrary;
$('#saveSong').onclick = async () => {
  const lrc = $('#fLrc').value;
  if (!$('#fTitle').value.trim()) return alert('Впиши название');
  if (editSource === 'file' && !newAudio && !editing.audio) return alert('Выбери аудиофайл');
  if (editSource === 'yt' && !editing.ytId) return alert('Выбери ролик на YouTube');
  if (!parseLrc(lrc).length) return alert('Нужен текст с таймингами (LRC). Можно разметить тапами.');
  Object.assign(editing, {
    source: editSource,
    title: $('#fTitle').value.trim(), artist: $('#fArtist').value.trim(), lrc,
    gaps: Math.max(1, Math.min(15, +$('#fGaps').value || 3)),
  });
  if (newAudio) { editing.audio = newAudio; editing.audioName = newAudio.name; }
  await putSong(editing);
  renderLibrary();
};

// ---------- Разметка тапами ----------
let tapLines = [], tapTimes = [];
$('#tapSync').onclick = async () => {
  const src = { source: editSource, ytId: editing.ytId, audio: newAudio || editing.audio };
  if (editSource === 'file' && !src.audio) return alert('Сначала выбери аудиофайл');
  if (editSource === 'yt' && !src.ytId) return alert('Сначала выбери ролик на YouTube');
  tapLines = $('#fLrc').value.split(/\r?\n/).map(l => l.replace(TS, '').replace(/<[^>]+>/g, '').trim()).filter(l => l && !/^\[\w+:/.test(l));
  if (!tapLines.length) return alert('Вставь текст песни (просто строки, без таймингов)');
  tapTimes = [];
  try { await setSource(src); } catch (e) { return alert(e.message); }
  $('#tapBtn').textContent = '▶ Старт';
  tapRender();
  show('tapper');
};
function tapRender() {
  $('#tapPrev').textContent = tapLines[tapTimes.length - 1] || '';
  $('#tapNext').textContent = tapLines[tapTimes.length] || '— конец текста —';
}
$('#tapBtn').onclick = () => {
  if (P.paused && !tapTimes.length && $('#tapBtn').textContent.startsWith('▶')) { P.play(); $('#tapBtn').textContent = 'СТРОКА ▸'; return; }
  if (tapTimes.length < tapLines.length) tapTimes.push(P.time);
  tapRender();
  if (tapTimes.length === tapLines.length) $('#tapBtn').textContent = 'Все строки размечены — жми «Готово»';
};
$('#tapUndo').onclick = () => { if (tapTimes.length) { const t = tapTimes.pop(); P.time = Math.max(0, t - 3); tapRender(); } };
$('#tapCancel').onclick = () => { P.pause(); show('editor'); };
$('#tapDone').onclick = () => {
  P.pause();
  if (tapTimes.length) {
    const end = P.time;
    $('#fLrc').value = tapTimes.map((t, i) => `[${fmt(t)}]${tapLines[i]}`).join('\n') + (tapTimes.length === tapLines.length ? `\n[${fmt(end)}]` : '');
    editing.offset = 0; // тайминги сняты прямо с этой записи
  }
  lrcInfo();
  show('editor');
};

// ---------- Игра ----------
let song = null, lines = [], gaps = [], curIdx = -2, activeGap = null, revealed = new Set(), raf = 0, offset = 0;
const now = () => P.time - offset; // время по тексту

async function startGame(id) {
  song = await getSong(id);
  lines = parseLrc(song.lrc);
  offset = song.offset || 0;
  showOffset();
  try { await setSource(song); } catch (e) { return alert(e.message); }
  $('#playTitle').textContent = `${song.artist ? song.artist + ' — ' : ''}${song.title}`;
  newGaps();
  show('play');
  onPlayState();
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
function progress(l, t) {
  if (l.words) return l.words.filter(x => x.t <= t).length / l.words.length * 100;
  return Math.max(0, Math.min(1, (t - l.t) / Math.min(l.end - l.t, 8))) * 100;
}
const lineAt = t => { let i = -1; for (let k = 0; k < lines.length && lines[k].t <= t; k++) i = k; return i; };

function loop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!activeGap) {
      const t = now(), i = lineAt(t);
      if (i !== curIdx) { curIdx = i; renderLines(i); }
      if (i >= 0) $('#lineCur').style.setProperty('--p', progress(lines[i], t).toFixed(1) + '%');
      if (P.duration) $('#pSeek').value = Math.round(P.time / P.duration * 1000);
    }
    checkGap();
    raf = requestAnimationFrame(tick);
  };
  tick();
}
// Стоп на пропуске. Ещё и по таймеру — он идёт, даже когда анимация на паузе (свёрнутое окно).
function checkGap() {
  if (P.paused || activeGap || $('#play').hidden) return;
  const t = now() + (P.kind === 'yt' ? 0.25 : 0); // YouTube останавливается с задержкой — тормозим чуть раньше
  const g = gaps.find(g => !g.done && t >= g.time && t < g.time + 1.5);
  if (!g) return;
  P.pause();
  activeGap = g;
  curIdx = lineAt(g.time);
  renderLines(curIdx);
  $('#lineCur').style.setProperty('--p', '100%');
  $('#gpAsk').hidden = false;
  $('#gpScore').hidden = true;
  $('#gapPanel').hidden = false;
  try { navigator.vibrate && navigator.vibrate(200); } catch {}
}
audio.addEventListener('timeupdate', checkGap);
setInterval(checkGap, 100);

$('#gpReveal').onclick = () => {
  const g = activeGap; if (!g) return;
  revealed.add(g.line); renderLines(curIdx);
  $('#gpAnswer').textContent = splitWords(lines[g.line].text).slice(g.from).join(' ');
  $('#gpTeams').innerHTML = teams.names.map((n, i) => `<button class="big" data-team="${i}">+1 ${esc(n)}</button>`).join('') + '<button data-team="-1">Никто</button>';
  $('#gpAsk').hidden = true;
  $('#gpScore').hidden = false;
};
$('#gpTeams').onclick = e => {
  const b = e.target.closest('button'); if (!b || !activeGap) return;
  const t = +b.dataset.team;
  if (t >= 0) { teams.score[t]++; saveTeams(); renderScore(); }
  activeGap.done = true; activeGap = null;
  $('#gapPanel').hidden = true;
  gapInfo();
  P.play();
};
$('#gpRepeat').onclick = () => {
  const g = activeGap; if (!g) return;
  activeGap = null;
  $('#gapPanel').hidden = true;
  P.time = Math.max(0, lines[g.line].t + offset - 4);
  P.play();
};

$('#pToggle').onclick = () => { if (activeGap) return; P.paused ? P.play() : P.pause(); };
$('#pSeek').oninput = () => {
  if (!P.duration) return;
  activeGap = null; $('#gapPanel').hidden = true;
  P.time = $('#pSeek').value / 1000 * P.duration;
};
$('#pBack').onclick = () => { cancelAnimationFrame(raf); renderLibrary(); };
$('#pReshuffle').onclick = () => { if (confirm('Сделать новые пропуски и начать песню сначала?')) { P.pause(); P.time = 0; newGaps(); } };

// Сдвиг текста относительно песни (у клипа на YouTube бывает другое вступление)
function showOffset() { $('#offVal').textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)} с`; }
let offSaveT = 0;
function moveOffset(d) {
  offset = Math.round((offset + d) * 10) / 10;
  showOffset();
  curIdx = -2;
  clearTimeout(offSaveT);
  offSaveT = setTimeout(() => { song.offset = offset; putSong(song); }, 600);
}
$('#offMinus').onclick = () => moveOffset(-0.5);
$('#offPlus').onclick = () => moveOffset(0.5);

// ---------- Экран не гаснет во время игры ----------
let wake = null;
async function requestWake() { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWake() { wake?.release().catch(() => {}); wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#play').hidden) requestWake(); });

// ---------- Старт ----------
renderScore();
renderLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
