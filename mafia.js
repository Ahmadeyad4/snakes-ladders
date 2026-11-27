// لعبة المافيا (خدعة اجتماعية) لكعدة بلي
// الأدوار: مافيا، مواطن، طبيب، محقق. المراحل: توزيع الأدوار -> ليل -> نهار (نقاش) -> تصويت -> غروب -> ليل ...
'use strict';

const MIN = 4, MAX = 10;
// MAFIA_SPEED=20 يسرّع كل المراحل (للاختبار فقط)
const SPEED = Math.max(0.1, parseFloat(process.env.MAFIA_SPEED) || 1);
const T = { reveal: 9000, night: 35000, day: 55000, vote: 30000, dusk: 6000 };
Object.keys(T).forEach(k => (T[k] = Math.round(T[k] / SPEED)));
const FAST_MS = Math.round(4000 / SPEED); // مدة المرحلة إذا ما بقى لاعب بشري حي (يتفرج فقط)

const RN = { mafia: ['🕴️', 'مافيا'], citizen: ['👤', 'مواطن'], doctor: ['🩺', 'الطبيب'], detective: ['🕵️', 'المحقق'] };
const roleTxt = r => RN[r][0] + ' ' + RN[r][1];

let api = { sendRoom() {}, broadcast() {}, send() {}, destroy() {} };
function setApi(a) { api = Object.assign({}, api, a); }

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const present = q => !!(q.bot || q.ws);
const anyAliveHuman = room => room.players.some(p => p.alive && !p.bot && !p.left);
const mafiaCount = n => Math.max(1, Math.floor(n / 3));
const nameOf = (room, i) => (room.players[i] ? room.players[i].name : '؟');
const narr = (room, text, kind) => api.broadcast(room, { t: 'mnarr', text, kind: kind || 'info' });

// ---------- التهيئة ----------
function resetPlayer(p) {
  p.role = null; p.alive = true; p.left = false; p.sel = null; p.vote = undefined;
  p.ready = false; p.known = {}; p.lastSave = -1; p.revealed = false; p.locked = false;
}
function clearBots(room) {
  const mf = room.mf;
  if (!mf) return;
  (mf.botT || []).forEach(clearTimeout);
  mf.botT = [];
}
function reset(room) {
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  room.mf = null;
  room.players.forEach(resetPlayer);
}
function init(room) {
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  const n = room.players.length;
  const roles = [];
  for (let k = 0; k < mafiaCount(n); k++) roles.push('mafia');
  roles.push('doctor', 'detective');
  while (roles.length < n) roles.push('citizen');
  shuffle(roles);
  room.players.forEach((p, i) => { resetPlayer(p); p.role = roles[i]; });
  room.turn = -1; room.winner = -1; room.phase = null;
  room.mf = { phase: 'reveal', day: 0, seq: 0, deadline: 0, total: 0, botT: [], closing: false, winner: null, mafiaN: mafiaCount(n) };
  setPhase(room, 'reveal', T.reveal);
}

// ---------- المراحل والمؤقتات ----------
function setPhase(room, phase, ms) {
  const mf = room.mf;
  mf.phase = phase; mf.seq++; mf.closing = false;
  if (!anyAliveHuman(room)) ms = Math.min(ms, FAST_MS);
  mf.total = ms; mf.deadline = Date.now() + ms;
  if (phase === 'night') room.players.forEach(p => { p.sel = null; p.locked = false; });
  if (phase === 'vote') room.players.forEach(p => { p.vote = undefined; });
  if (phase === 'day') room.players.forEach(p => { p.ready = false; });
  arm(room);
  api.sendRoom(room);
}
// يشغّل المؤقت (ويجدول الأجهزة) من الموعد المحفوظ. آمن للاستدعاء أكثر من مرة.
function arm(room) {
  const mf = room.mf;
  if (!mf || room.state !== 'play') return;
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  if (!room.players.some(p => p.ws)) return; // ما في أحد متصل: ننتظر رجوع أحدهم
  const seq = mf.seq;
  room.timer = setTimeout(() => {
    if (room.mf === mf && mf.seq === seq && room.state === 'play') advance(room);
  }, Math.max(300, mf.deadline - Date.now()));
  scheduleBots(room);
}
function resume(room) {
  const mf = room.mf;
  if (!mf || room.state !== 'play') return;
  if (mf.deadline - Date.now() < 6000) mf.deadline = Date.now() + Math.min(mf.total, 6000);
  arm(room);
}
// إنهاء مبكر للمرحلة بعد مهلة قصيرة (لما الكل خلّص)
function close(room, ms) {
  const mf = room.mf;
  if (!mf || mf.closing || !room.players.some(p => p.ws)) return;
  mf.closing = true;
  ms = Math.max(40, Math.round(ms / SPEED));
  const seq = mf.seq;
  mf.deadline = Math.min(mf.deadline, Date.now() + ms);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.mf === mf && mf.seq === seq && room.state === 'play') advance(room);
  }, ms);
}
function advance(room) {
  const mf = room.mf;
  if (!mf || room.state !== 'play') return;
  switch (mf.phase) {
    case 'reveal': case 'dusk': startNight(room); break;
    case 'night': resolveNight(room); break;
    case 'day': startVote(room); break;
    case 'vote': resolveVote(room); break;
  }
}
function startNight(room) {
  room.mf.day++;
  narr(room, '🌙 حلّ الليل... نامت المدينة، والمافيا تتحرك بالظلام', 'night');
  setPhase(room, 'night', T.night);
}
function startVote(room) {
  narr(room, '🗳️ انتهى النقاش! صوّتوا على من تظنونه مافيا', 'info');
  setPhase(room, 'vote', T.vote);
}

// ---------- نتيجة الليل ----------
function kill(room, i) {
  const p = room.players[i];
  p.alive = false; p.revealed = true;
}
function resolveNight(room) {
  const ps = room.players;
  const tally = {};
  ps.forEach(p => { if (p.alive && p.role === 'mafia' && p.sel != null) tally[p.sel] = (tally[p.sel] || 0) + 1; });
  let best = 0, tied = [];
  for (const k in tally) {
    if (tally[k] > best) { best = tally[k]; tied = [+k]; } else if (tally[k] === best) tied.push(+k);
  }
  const victim = tied.length ? pick(tied) : -1;
  const doc = ps.find(p => p.alive && p.role === 'doctor' && p.sel != null);
  const saved = doc ? doc.sel : -1;
  ps.forEach(p => { if (p.role === 'doctor') p.lastSave = p.alive && p.sel != null ? p.sel : -1; });
  if (victim >= 0 && ps[victim] && ps[victim].alive && victim !== saved) {
    kill(room, victim);
    narr(room, '☀️ أصبح الصباح... وُجد ' + nameOf(room, victim) + ' مقتولاً 💀 وكان ' + roleTxt(ps[victim].role), 'death');
  } else if (victim >= 0 && victim === saved) {
    narr(room, '☀️ أصبح الصباح... المافيا حاولت تقتل أحدهم لكن الطبيب أنقذه! ما مات أحد 🩺', 'save');
  } else {
    narr(room, '☀️ أصبح الصباح... ليلة هادئة، ما مات أحد', 'info');
  }
  if (!checkWin(room)) setPhase(room, 'day', T.day);
}

// ---------- نتيجة التصويت ----------
function resolveVote(room) {
  const ps = room.players;
  const tally = {};
  ps.forEach(p => { if (p.alive && p.vote !== undefined) tally[p.vote] = (tally[p.vote] || 0) + 1; });
  let best = 0, tied = [];
  for (const k in tally) {
    if (tally[k] > best) { best = tally[k]; tied = [+k]; } else if (tally[k] === best) tied.push(+k);
  }
  const parts = Object.keys(tally).map(Number).sort((a, b) => tally[b] - tally[a])
    .map(k => (k === -1 ? 'تخطّي' : nameOf(room, k)) + ' (' + tally[k] + ')');
  if (parts.length) narr(room, '📊 الأصوات: ' + parts.join('، '), 'info');
  if (tied.length === 1 && tied[0] !== -1 && best > 0 && ps[tied[0]] && ps[tied[0]].alive) {
    const v = tied[0];
    kill(room, v);
    narr(room, '⚖️ قرر الأهالي طرد ' + nameOf(room, v) + '... وكان ' + roleTxt(ps[v].role) + (ps[v].role === 'mafia' ? ' 🎉' : ' 😢'), 'death');
  } else {
    narr(room, '🤝 تعادل أو تخطّي، ما انطرد أحد اليوم', 'info');
  }
  if (!checkWin(room)) setPhase(room, 'dusk', T.dusk);
}

// ---------- الفوز ----------
function checkWin(room) {
  const al = room.players.filter(p => p.alive);
  const m = al.filter(p => p.role === 'mafia').length;
  const o = al.length - m;
  let w = null;
  if (m === 0) w = 'citizens'; else if (m >= o) w = 'mafia';
  if (!w) return false;
  finish(room, w);
  return true;
}
function finish(room, w) {
  const mf = room.mf;
  mf.winner = w; mf.phase = 'done'; mf.seq++;
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  room.state = 'done'; room.endReason = 'win';
  room.players.forEach(p => { p.revealed = true; });
  room.winner = Math.max(0, room.players.findIndex(p => (w === 'mafia') === (p.role === 'mafia')));
  api.sendRoom(room);
}

// ---------- إجراءات اللاعبين ----------
const validTarget = (room, t) => Number.isInteger(t) && t >= 0 && t < room.players.length && room.players[t].alive;

function checkNightDone(room) {
  const need = room.players.filter(q => q.alive && present(q) && (q.role === 'mafia' || q.role === 'doctor' || q.role === 'detective'));
  if (need.length && need.every(q => q.sel != null)) close(room, 1600);
}
function checkVoteDone(room) {
  const need = room.players.filter(q => q.alive && present(q));
  if (need.length && need.every(q => q.vote !== undefined)) close(room, 1500);
}
function checkDayDone(room) {
  const hum = room.players.filter(q => q.alive && !q.bot && q.ws);
  if (hum.length && hum.every(q => q.ready)) close(room, 900);
}
function checkProgress(room) {
  const ph = room.mf && room.mf.phase;
  if (ph === 'night') checkNightDone(room);
  else if (ph === 'vote') checkVoteDone(room);
  else if (ph === 'day') checkDayDone(room);
}

function handle(room, p, m) {
  const mf = room.mf;
  if (!mf || room.state !== 'play' || !p.alive || p.left) return;
  const i = room.players.indexOf(p);
  if (m.t === 'mact') {
    if (mf.phase !== 'night') return;
    const t = parseInt(m.target);
    if (!validTarget(room, t)) return;
    const tp = room.players[t];
    if (p.role === 'mafia') {
      if (tp.role === 'mafia') return;
      p.sel = t;
    } else if (p.role === 'doctor') {
      if (p.locked) return;
      if (t === p.lastSave) return api.send(p.ws, { t: 'err', msg: 'ما تكدر تنقذ نفس الشخص ليلتين ورا بعض' });
      p.sel = t; p.locked = true;
    } else if (p.role === 'detective') {
      if (p.locked || t === i) return;
      p.sel = t; p.locked = true; p.known[t] = tp.role === 'mafia';
      api.send(p.ws, { t: 'mpriv', text: '🔍 نتيجة التحقيق: ' + tp.name + (tp.role === 'mafia' ? ' ← مافيا 🔴' : ' ← بريء ✅') });
    } else return;
    checkNightDone(room);
  } else if (m.t === 'mvote') {
    if (mf.phase !== 'vote') return;
    const t = m.target == null ? -1 : parseInt(m.target);
    if (t !== -1 && (!validTarget(room, t) || t === i)) return;
    p.vote = t;
    checkVoteDone(room);
  } else if (m.t === 'mready') {
    if (mf.phase !== 'day') return;
    p.ready = true;
    checkDayDone(room);
  } else return;
  api.sendRoom(room);
}

// انسحاب لاعب أو انقطاعه الطويل أثناء اللعب: يبقى مكانه بالقائمة (ميت) حتى ما تتغير الفهارس
function leave(room, p, why) {
  const mf = room.mf;
  if (!mf) return;
  const wasAlive = p.alive;
  p.alive = false; p.revealed = true; p.left = true; p.sel = null;
  if (!room.players.some(q => !q.bot && !q.left)) { api.destroy(room); return; }
  narr(room, '🚪 ' + p.name + (why === 'dc' ? ' انقطع اتصاله' : ' انسحب') + ' وكان ' + roleTxt(p.role), 'info');
  if (wasAlive && checkWin(room)) return;
  checkProgress(room);
  api.sendRoom(room);
}

// ---------- الدردشة ----------
// يرجع null إذا اللاعب ما يكدر يحجي هسه، أو { scope, to } للمستلمين
function chatRoute(room, p) {
  const mf = room.mf;
  if (room.state !== 'play' || !mf) return { scope: null, to: room.players };
  if (!p.alive) return { scope: 'dead', to: room.players.filter(q => !q.alive) };
  if (mf.phase === 'night') {
    if (p.role !== 'mafia') return null;
    return { scope: 'mafia', to: room.players.filter(q => !q.alive || q.role === 'mafia') };
  }
  return { scope: null, to: room.players };
}

// ---------- الأجهزة (بوتات) ----------
function scheduleBots(room) {
  const mf = room.mf, seq = mf.seq;
  const bots = room.players.filter(p => p.bot && p.alive);
  if (!bots.length) return;
  const fast = mf.total <= FAST_MS * 1.2;
  const at = (fn, lo, hi) => {
    const ms = fast ? rnd(mf.total * 0.1, mf.total * 0.6) : rnd(lo, Math.max(lo + 500, hi)) / SPEED;
    mf.botT.push(setTimeout(() => { if (room.mf === mf && mf.seq === seq && room.state === 'play') fn(); }, ms));
  };
  if (mf.phase === 'night') bots.forEach(b => { if (b.role !== 'citizen') at(() => botNight(room, b), 2000, 10000); });
  else if (mf.phase === 'day' && !fast) bots.forEach(b => { for (let k = 1 + Math.floor(Math.random() * 2); k > 0; k--) at(() => botTalk(room, b), 3000, mf.total * 0.8); });
  else if (mf.phase === 'vote') bots.forEach(b => at(() => botVote(room, b), 3000, 20000));
}
function botNight(room, b) {
  const mf = room.mf;
  if (!b.alive || mf.phase !== 'night' || b.sel != null) return;
  const i = room.players.indexOf(b);
  const al = room.players.map((p, k) => (p.alive ? k : -1)).filter(k => k >= 0);
  if (b.role === 'mafia') {
    const targets = al.filter(k => room.players[k].role !== 'mafia');
    if (!targets.length) return;
    const mate = room.players.find(p => p.role === 'mafia' && p.alive && p.sel != null);
    b.sel = mate && Math.random() < 0.8 && targets.includes(mate.sel) ? mate.sel : pick(targets);
  } else if (b.role === 'doctor') {
    const opts = al.filter(k => k !== b.lastSave);
    if (!opts.length) return;
    b.sel = pick(opts); b.locked = true;
  } else if (b.role === 'detective') {
    const others = al.filter(k => k !== i);
    const fresh = others.filter(k => b.known[k] === undefined);
    const pool = fresh.length ? fresh : others;
    if (!pool.length) return;
    const t = pick(pool);
    b.sel = t; b.locked = true; b.known[t] = room.players[t].role === 'mafia';
  } else return;
  checkNightDone(room);
  api.sendRoom(room);
}
function leader(room, cands) {
  const cnt = {};
  room.players.forEach(p => { if (p.alive && p.vote >= 0 && cands.includes(p.vote)) cnt[p.vote] = (cnt[p.vote] || 0) + 1; });
  let best = 0, who = null;
  for (const k in cnt) if (cnt[k] > best) { best = cnt[k]; who = +k; }
  return who;
}
function botVote(room, b) {
  const mf = room.mf;
  if (!b.alive || mf.phase !== 'vote' || b.vote !== undefined) return;
  const i = room.players.indexOf(b);
  const others = room.players.map((p, k) => (p.alive && k !== i ? k : -1)).filter(k => k >= 0);
  if (!others.length) return;
  let t = -1;
  if (b.role === 'mafia') {
    const cands = others.filter(k => room.players[k].role !== 'mafia');
    const l = leader(room, cands);
    t = cands.length ? (l != null && Math.random() < 0.6 ? l : pick(cands)) : -1;
  } else {
    const sus = Object.keys(b.known).map(Number).filter(k => b.known[k] && room.players[k] && room.players[k].alive);
    if (b.role === 'detective' && sus.length) t = sus[0];
    else if (Math.random() < 0.12) t = -1;
    else { const l = leader(room, others); t = l != null && Math.random() < 0.5 ? l : pick(others); }
  }
  b.vote = t;
  checkVoteDone(room);
  api.sendRoom(room);
}
const BOT_LINES = [
  'أنا مواطن بريء والله 🙏', 'شنو رأيكم؟ منو يشبه المافيا؟', 'لا تتسرعون بالتصويت!',
  'أنا أشك بـ{n} 🤔', 'ليش {n} ساكت؟', 'أحس المافيا بينّا هسه 😏', 'ثقوا بيّ، أنا ما أكدر أكذب', 'خلونا نفكر شوي قبل التصويت',
];
function botTalk(room, b) {
  if (!b.alive || room.mf.phase !== 'day') return;
  const i = room.players.indexOf(b);
  let others = room.players.map((p, k) => (p.alive && k !== i && (b.role !== 'mafia' || p.role !== 'mafia') ? k : -1)).filter(k => k >= 0);
  if (!others.length) others = [i];
  const text = pick(BOT_LINES).replace('{n}', nameOf(room, pick(others)).replace(/^🤖\s*/, ''));
  api.broadcast(room, { t: 'chat', i, text, emoji: false, scope: null });
}

// ---------- الحالة المرسلة لكل لاعب (مخصصة حسب ما يحق له يشوف) ----------
function view(room, i) {
  const mf = room.mf, me = room.players[i];
  if (!mf || !me) return null;
  const done = room.state === 'done';
  const seeAll = done || !me.alive;
  const mate = me.role === 'mafia';
  const showV = mf.phase === 'vote' || mf.phase === 'dusk';
  return {
    phase: mf.phase, day: mf.day, left: Math.max(0, mf.deadline - Date.now()), total: mf.total,
    role: me.role, alive: !!me.alive, mafiaN: mf.mafiaN, winner: mf.winner,
    sel: me.sel == null ? -1 : me.sel, locked: !!me.locked, vote: me.vote === undefined ? null : me.vote, ready: !!me.ready,
    last: me.role === 'doctor' ? me.lastSave : -1,
    known: me.role === 'detective' ? me.known : null,
    msel: mate ? room.players.map(p => (p.role === 'mafia' && p.alive && p.sel != null ? p.sel : -1)) : null,
    players: room.players.map((p, k) => ({
      a: !!p.alive, l: !!p.left,
      r: k === i || seeAll || p.revealed || (mate && p.role === 'mafia') ? p.role : null,
      v: showV && p.alive ? (p.vote === undefined ? null : p.vote) : null,
      rd: mf.phase === 'day' ? !!p.ready : false,
    })),
  };
}

module.exports = { MIN, MAX, setApi, init, reset, resume, handle, leave, chatRoute, view };
