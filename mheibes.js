// لعبة المحيبس (لعبة عراقية تراثية) لكعدة بلي
// من 2 إلى 4 لاعبين: 1 ضد 1، أو 2 ضد 1، أو 2 ضد 2. عدد القبضات متساوي بين الفريقين (اللاعب الوحيد بفريق من اثنين يحمل 4 قبضات).
// فريقين (حسب رقم اللاعب: زوجي = أحمر، فردي = أزرق). فريق يخفي المحبس بإحدى قبضات أعضائه، والفريق الثاني يدور عليه.
// مجموع قبضات الفريق المخفّي = 2 × حجم الفريق الأكبر، وبحد أدنى 4 (حتى لا يصير 1 ضد 1 رمية عملة).
// زملاء الباحث (غير الباحث نفسه) يكدرون "يقترحون" قبضة (hsug) تظهر للباحث وفريقه فقط.
// الباحث: "طلّع" = يطلب فتح قبضة يظنها فاضية (إذا طلعت فيها المحبس يخسر الجولة)، "بات" = يقول المحبس هنا.
// المراحل: تعارف -> إخفاء -> بحث -> نتيجة -> إخفاء ... أول فريق يوصل 5 نقاط يفوز.
'use strict';

const MIN = 2, MAX = 4, WIN = 5;
// عبارات سريعة تراثية (تنرسل بالدردشة كفقاعة فوق اللاعب). لازم تطابق القائمة بالواجهة.
const PHRASES = ['بات!', 'طلّع إيدك!', 'ما بيها شي 😏', 'المحبس بيها!', 'لا تصدّق هزّاتنا 😂', 'عفية! 👏'];
// MHEIBES_SPEED=20 يسرّع كل المراحل (للاختبار فقط)
const SPEED = Math.max(0.1, parseFloat(process.env.MHEIBES_SPEED) || 1);
const T = { intro: 5000, hide: 22000, seek: 45000, step: 25000, result: 5500 };
Object.keys(T).forEach(k => (T[k] = Math.round(T[k] / SPEED)));

const TEAM = ['🔴 الفريق الأحمر', '🔵 الفريق الأزرق'];
const teamOf = i => i % 2;

let api = { sendRoom() {}, broadcast() {}, send() {}, destroy() {} };
function setApi(a) { api = Object.assign({}, api, a); }

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = a => a[Math.floor(Math.random() * a.length)];
const nameOf = (room, i) => (room.players[i] ? room.players[i].name : '؟');
const narr = (room, text, kind) => api.broadcast(room, { t: 'hnarr', text, kind: kind || 'info' });

// ---------- أدوات القبضات ----------
// رقم القبضة = رقم اللاعب * 4 + رقم القبضة عنده (0..3). عدد قبضات كل فريق = 2 × حجم الفريق الأكبر
const members = (room, t) => room.players.map((p, i) => (teamOf(i) === t && !p.left ? i : -1)).filter(i => i >= 0);
const totalFists = room => Math.max(4, 2 * Math.max(members(room, 0).length, members(room, 1).length));
const perPlayer = (room, t) => {
  const n = members(room, t).length;
  return n ? totalFists(room) / n : 0;
};
const fistsOf = (room, t) => {
  const per = perPlayer(room, t);
  return members(room, t).reduce((a, i) => { for (let k = 0; k < per; k++) a.push(i * 4 + k); return a; }, []);
};
const remaining = room => fistsOf(room, room.mh.hiding).filter(f => !room.mh.opened.includes(f));
const validFist = (room, f) => Number.isInteger(f) && fistsOf(room, room.mh.hiding).includes(f);
const fistLabel = (room, f) => {
  const per = perPlayer(room, room.mh.hiding);
  return nameOf(room, f >> 2) + ' (' + (per === 2 ? (f & 3 ? 'اليمين' : 'اليسار') : 'قبضة ' + ((f & 3) + 1)) + ')';
};
function nextMember(room, t, key) {
  const arr = members(room, t);
  if (!arr.length) return -1;
  const mh = room.mh;
  return arr[mh.ctr[key][t]++ % arr.length];
}

// ---------- التهيئة ----------
function clearBots(room) {
  const mh = room.mh;
  if (!mh) return;
  (mh.botT || []).forEach(clearTimeout); mh.botT = [];
  (mh.fxT || []).forEach(clearTimeout); mh.fxT = [];
}
function reset(room) {
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  room.mh = null;
  room.players.forEach(p => { p.left = false; });
}
function init(room) {
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  room.players.forEach(p => { p.left = false; });
  room.turn = -1; room.winner = -1; room.phase = null;
  room.mh = {
    phase: 'intro', round: 0, seq: 0, deadline: 0, total: 0, botT: [], fxT: [], closing: false, winner: null,
    score: [0, 0], hiding: Math.random() < 0.5 ? 0 : 1, next: null, hider: -1, searcher: -1,
    ring: -1, opened: [], tells: {}, fxN: {}, fxAt: {}, sugs: {}, reveal: null, ctr: { hid: [0, 0], seek: [0, 0] },
  };
  narr(room, '💍 المحيبس! فريق يخفي المحبس والثاني يدور عليه (عدد القبضات متساوي). أول فريق يوصل ' + WIN + ' نقاط يفوز', 'info');
  setPhase(room, 'intro', T.intro);
}

// ---------- المراحل والمؤقتات ----------
function setPhase(room, phase, ms) {
  const mh = room.mh;
  mh.phase = phase; mh.seq++; mh.closing = false;
  mh.total = ms; mh.deadline = Date.now() + ms;
  arm(room);
  api.sendRoom(room);
}
// يشغّل المؤقت (ويجدول الأجهزة) من الموعد المحفوظ. آمن للاستدعاء أكثر من مرة.
function arm(room) {
  const mh = room.mh;
  if (!mh || room.state !== 'play') return;
  clearTimeout(room.timer); room.timer = null;
  (mh.botT || []).forEach(clearTimeout); mh.botT = [];
  if (!room.players.some(p => p.ws)) return; // ما في أحد متصل: ننتظر رجوع أحدهم
  const seq = mh.seq;
  room.timer = setTimeout(() => {
    if (room.mh === mh && mh.seq === seq && room.state === 'play') advance(room);
  }, Math.max(300, mh.deadline - Date.now()));
  scheduleBots(room);
}
function resume(room) {
  const mh = room.mh;
  if (!mh || room.state !== 'play') return;
  if (mh.deadline - Date.now() < 6000) mh.deadline = Date.now() + Math.min(mh.total, 6000);
  arm(room);
}
// يعيد ضبط مؤقت المرحلة الحالية بدون ما يلمس الأجهزة
function retime(room, ms) {
  const mh = room.mh;
  mh.deadline = Date.now() + ms; mh.total = ms; mh.closing = false;
  clearTimeout(room.timer); room.timer = null;
  if (!room.players.some(p => p.ws)) return;
  const seq = mh.seq;
  room.timer = setTimeout(() => {
    if (room.mh === mh && mh.seq === seq && room.state === 'play') advance(room);
  }, ms);
}
// إنهاء مبكر للمرحلة بعد مهلة قصيرة
function close(room, ms) {
  const mh = room.mh;
  if (!mh || mh.closing || !room.players.some(p => p.ws)) return;
  mh.closing = true;
  ms = Math.max(40, Math.round(ms / SPEED));
  const seq = mh.seq;
  mh.deadline = Math.min(mh.deadline, Date.now() + ms);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.mh === mh && mh.seq === seq && room.state === 'play') advance(room);
  }, ms);
}
function advance(room) {
  const mh = room.mh;
  if (!mh || room.state !== 'play') return;
  switch (mh.phase) {
    case 'intro': case 'result': startRound(room); break;
    case 'hide':
      if (mh.ring < 0) { const f = fistsOf(room, mh.hiding); if (f.length) mh.ring = pick(f); }
      startSeek(room); break;
    case 'seek': timeoutSeek(room); break;
  }
}

function startRound(room, redo) {
  const mh = room.mh;
  if (!redo) mh.round++;
  if (mh.next != null) { mh.hiding = mh.next; mh.next = null; }
  clearBots(room);
  mh.hider = nextMember(room, mh.hiding, 'hid');
  mh.searcher = nextMember(room, 1 - mh.hiding, 'seek');
  mh.ring = -1; mh.opened = []; mh.tells = {}; mh.fxN = {}; mh.fxAt = {}; mh.sugs = {}; mh.reveal = null;
  narr(room, '🔄 الجولة ' + mh.round + ': ' + TEAM[mh.hiding] + ' يخفي المحبس 💍 و' + nameOf(room, mh.searcher) + ' يدور عليه', 'info');
  setPhase(room, 'hide', T.hide);
}
function startSeek(room) {
  const mh = room.mh;
  clearBots(room);
  narr(room, '🔎 ' + nameOf(room, mh.searcher) + ' يبحث عن المحبس... راقبوا القبضات 👀', 'info');
  setPhase(room, 'seek', T.seek);
  scheduleFx(room);
}

// ---------- نتيجة الجولة ----------
// kind: found (بات صح) | last (آخر قبضة) | miss (بات غلط) | burn (طلّع على قبضة المحبس)
function settle(room, winTeam, kind, fist) {
  const mh = room.mh;
  const st = 1 - mh.hiding;
  mh.reveal = { kind, fist, win: winTeam };
  mh.score[winTeam]++;
  if (winTeam === st) mh.next = st; // الفريق الباحث إذا لقى المحبس يصير هو اللي يخفيه
  clearBots(room);
  const sn = nameOf(room, mh.searcher), holder = fistLabel(room, mh.ring);
  if (kind === 'found') narr(room, '🎉 "بات"! ' + sn + ' لقى المحبس عند ' + holder + ' ← نقطة لـ ' + TEAM[st] + ' والمحبس صار عندهم', 'found');
  else if (kind === 'last') narr(room, '🎯 ما بقت غير قبضة وحدة وفيها المحبس عند ' + holder + ' ← نقطة لـ ' + TEAM[st], 'found');
  else if (kind === 'burn') narr(room, '💥 ' + sn + ' قال "طلّع" على قبضة المحبس (' + holder + ')! ← نقطة لـ ' + TEAM[mh.hiding], 'miss');
  else narr(room, '😅 "بات" غلط! القبضة فاضية والمحبس كان عند ' + holder + ' ← نقطة لـ ' + TEAM[mh.hiding], 'miss');
  if (mh.score[winTeam] >= WIN) { finish(room, winTeam); return; }
  setPhase(room, 'result', T.result);
}
function finish(room, w) {
  const mh = room.mh;
  mh.winner = w; mh.phase = 'done'; mh.seq++;
  clearTimeout(room.timer); room.timer = null;
  clearBots(room);
  room.state = 'done'; room.endReason = 'win';
  room.winner = Math.max(0, room.players.findIndex((p, i) => teamOf(i) === w));
  api.sendRoom(room);
}

// ---------- إجراءات اللاعبين ----------
function doBat(room, f) {
  const mh = room.mh;
  if (f === mh.ring) settle(room, 1 - mh.hiding, 'found', f);
  else settle(room, mh.hiding, 'miss', f);
}
function doOut(room, f) {
  const mh = room.mh;
  if (f === mh.ring) { settle(room, mh.hiding, 'burn', f); return; }
  mh.opened.push(f);
  Object.keys(mh.sugs).forEach(k => { if (mh.sugs[k] === f) delete mh.sugs[k]; }); // القبضة انفتحت: تنمسح الاقتراحات عليها
  const rem = remaining(room);
  narr(room, '🖐️ ' + nameOf(room, mh.searcher) + ' قال "طلّع" على ' + fistLabel(room, f) + ' ← فاضية ✅ (باقي ' + rem.length + ')', 'info');
  api.broadcast(room, { t: 'hopen', fist: f });
  if (rem.length === 1) { settle(room, 1 - mh.hiding, 'last', rem[0]); return; }
  retime(room, T.step);
  api.sendRoom(room);
  if (room.players[mh.searcher] && room.players[mh.searcher].bot) botAt(room, () => botSeek(room), 2200, 4200);
}
function timeoutSeek(room) {
  const rem = remaining(room);
  if (!rem.length) return;
  narr(room, '⏰ انتهى وقت ' + nameOf(room, room.mh.searcher) + '، تم اختيار قبضة عشوائية', 'info');
  doBat(room, pick(rem));
}
// حركة التمويه: أي لاعب من الفريق المخفي يكدر يهز قبضة (تمويه أو إشارة)
function fx(room, fist, by) {
  const mh = room.mh;
  mh.tells[fist] = (mh.tells[fist] || 0) + 1;
  api.broadcast(room, { t: 'hfx', fist, by });
}

function handle(room, p, m) {
  const mh = room.mh;
  if (!mh || room.state !== 'play' || p.left) return;
  const i = room.players.indexOf(p);
  if (m.t === 'hhide') {
    if (mh.phase !== 'hide' || i !== mh.hider || mh.ring >= 0) return;
    const f = parseInt(m.fist);
    const hiderFists = fistsOf(room, mh.hiding);
    if (!hiderFists.includes(f)) return;
    mh.ring = f;
    close(room, 900);
    api.sendRoom(room);
  } else if (m.t === 'hout' || m.t === 'hbat') {
    if (mh.phase !== 'seek' || i !== mh.searcher) return;
    const f = parseInt(m.fist);
    if (!validFist(room, f) || mh.opened.includes(f)) return;
    if (m.t === 'hout') doOut(room, f); else doBat(room, f);
  } else if (m.t === 'hsug') {
    // اقتراح من زميل الباحث: ضغطة تقترح القبضة، وضغطة ثانية عليها تلغي الاقتراح
    if (mh.phase !== 'seek' || teamOf(i) === mh.hiding || i === mh.searcher) return;
    const f = parseInt(m.fist);
    if (!validFist(room, f) || mh.opened.includes(f)) return;
    const now = Date.now();
    if (now - (p.lastSug || 0) < 300) return;
    p.lastSug = now;
    if (mh.sugs[i] === f) delete mh.sugs[i]; else mh.sugs[i] = f;
    api.sendRoom(room);
  } else if (m.t === 'hfx') {
    if ((mh.phase !== 'hide' && mh.phase !== 'seek') || teamOf(i) !== mh.hiding) return;
    const f = parseInt(m.fist);
    if (!validFist(room, f) || mh.opened.includes(f)) return;
    const now = Date.now();
    if (now - (p.lastFx || 0) < 500) return;
    p.lastFx = now;
    mh.fxN[i] = (mh.fxN[i] || 0) + 1;
    if (mh.fxN[i] > 14) return;
    fx(room, f, i);
  }
}

// انسحاب لاعب أو انقطاعه الطويل: يبقى مكانه بالقائمة حتى ما تتغير أرقام الفرق
function leave(room, p, why) {
  const mh = room.mh;
  if (!mh) return;
  const idx = room.players.indexOf(p);
  p.left = true;
  delete mh.sugs[idx];
  if (!room.players.some(q => !q.bot && !q.left)) { api.destroy(room); return; }
  narr(room, '🚪 ' + p.name + (why === 'dc' ? ' انقطع اتصاله' : ' انسحب'), 'info');
  if (!members(room, 0).length || !members(room, 1).length) { finish(room, members(room, 0).length ? 0 : 1); return; }
  if (mh.phase === 'hide' || mh.phase === 'seek') {
    // تغيّر عدد القبضات، فنعيد الجولة بدون احتساب نقطة
    narr(room, '🔁 نعيد الجولة بدون احتساب نقطة', 'info');
    startRound(room, true);
    return;
  }
  api.sendRoom(room);
}

// ---------- الأجهزة (بوتات) ----------
function botAt(room, fn, lo, hi) {
  const mh = room.mh, seq = mh.seq;
  mh.botT.push(setTimeout(() => { if (room.mh === mh && mh.seq === seq && room.state === 'play') fn(); }, rnd(lo, Math.max(lo + 300, hi)) / SPEED));
}
function scheduleBots(room) {
  const mh = room.mh;
  if (mh.phase === 'hide') {
    const h = room.players[mh.hider];
    if (h && h.bot) botAt(room, () => botHide(room), 2000, 5500);
  } else if (mh.phase === 'seek') {
    const s = room.players[mh.searcher];
    if (s && s.bot) botAt(room, () => botSeek(room), 3000, 5500);
    // أجهزة زملاء الباحث تقترح قبضة (الأقل هزّات = الأقل شكاً)
    members(room, 1 - mh.hiding).forEach(j => {
      const q = room.players[j];
      if (q && q.bot && j !== mh.searcher) botAt(room, () => botSug(room, j), 3500, 9000);
    });
  }
}
function botHide(room) {
  const mh = room.mh;
  if (mh.phase !== 'hide' || mh.ring >= 0) return;
  const f = fistsOf(room, mh.hiding);
  if (!f.length) return;
  mh.ring = pick(f);
  close(room, 700);
  api.sendRoom(room);
}
// الأجهزة تمويه: الجهاز المخبّي يهز قبضة المحبس أحياناً (إشارة ضعيفة)، وباقي أجهزة الفريق تهز قبضات عشوائية
function scheduleFx(room) {
  const mh = room.mh, seq = mh.seq;
  const at = fn => mh.fxT.push(setTimeout(() => { if (room.mh === mh && mh.seq === seq && mh.phase === 'seek' && room.state === 'play') fn(); }, rnd(2500, T.seek * 0.65)));
  const hider = room.players[mh.hider];
  if (hider && hider.bot) {
    for (let k = 3 + Math.floor(Math.random() * 3); k > 0; k--) {
      at(() => { const f = Math.random() < 0.32 ? mh.ring : pick(fistsOf(room, mh.hiding)); if (!mh.opened.includes(f)) fx(room, f, mh.hider); });
    }
  }
  members(room, mh.hiding).forEach(i => {
    const q = room.players[i];
    if (q.bot && i !== mh.hider) for (let k = 1 + Math.floor(Math.random() * 2); k > 0; k--) {
      at(() => { const f = pick(fistsOf(room, mh.hiding)); if (!mh.opened.includes(f)) fx(room, f, i); });
    }
  });
}
function botSug(room, j) {
  const mh = room.mh;
  if (mh.phase !== 'seek') return;
  const rem = remaining(room);
  if (!rem.length) return;
  const sorted = rem.map(f => [f, (mh.tells[f] || 0) + Math.random() * 1.6]).sort((a, b) => a[1] - b[1]);
  mh.sugs[j] = sorted[0][0];
  api.sendRoom(room);
}
function botSeek(room) {
  const mh = room.mh;
  if (mh.phase !== 'seek') return;
  const rem = remaining(room);
  if (!rem.length) return;
  const sc = f => (mh.tells[f] || 0) + Math.random() * 1.6; // كل ما زادت الهزّات زاد الشك
  const sorted = rem.map(f => [f, sc(f)]).sort((a, b) => a[1] - b[1]);
  const pBat = Math.min(0.55, 0.12 + 0.1 * mh.opened.length);
  if (Math.random() < pBat) doBat(room, sorted[sorted.length - 1][0]);
  else doOut(room, sorted[0][0]);
}

// ---------- الحالة المرسلة لكل لاعب ----------
function view(room, i) {
  const mh = room.mh, me = room.players[i];
  if (!mh || !me) return null;
  const showRing = mh.phase === 'result' || mh.phase === 'done' || (i === mh.hider && (mh.phase === 'hide' || mh.phase === 'seek'));
  return {
    phase: mh.phase, round: mh.round, left: Math.max(0, mh.deadline - Date.now()), total: mh.total,
    score: mh.score, win: WIN, hiding: mh.hiding, hider: mh.hider, searcher: mh.searcher,
    team: teamOf(i), fists: fistsOf(room, mh.hiding), per: perPlayer(room, mh.hiding), opened: mh.opened,
    locked: mh.ring >= 0, ring: showRing ? mh.ring : -1,
    sug: mh.phase === 'seek' && teamOf(i) !== mh.hiding ? Object.keys(mh.sugs).map(k => [+k, mh.sugs[k]]) : [],
    reveal: mh.phase === 'result' || mh.phase === 'done' ? mh.reveal : null,
    winner: mh.winner,
    players: room.players.map((p, k) => ({ t: teamOf(k), l: !!p.left })),
  };
}

module.exports = { MIN, MAX, WIN, PHRASES, setApi, init, reset, resume, handle, leave, view };
