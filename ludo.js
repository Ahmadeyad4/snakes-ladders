// منطق لعبة لودو (السيرفر هو الحَكَم). كل قطعة لها رقم تقدّم r:
//   -1      = بالقاعدة (تحتاج 6 حتى تطلع)
//   0..50   = على المسار الخارجي (0 = مربع البداية)
//   51..55  = بالممر الملوّن الأخير
//   56      = وصلت للبيت
// المسار الخارجي 52 مربع، ولكل مقعد مربع بداية = 13 × رقم المقعد.
const SEAT_COLORS = ['#e5383b', '#2fbf71', '#f4c20d', '#2f7be5']; // أحمر، أخضر، أصفر، أزرق
const FINISH = 56;

function seatsFor(n) {
  return n <= 2 ? [0, 2].slice(0, n) : n === 3 ? [0, 1, 2] : [0, 1, 2, 3];
}

function init(room) {
  const seats = seatsFor(room.players.length);
  room.players.forEach((p, i) => {
    p.seat = seats[i];
    // الوضع السريع: قطعة وحدة تبدأ جاهزة على مربع البداية، والفوز بإدخال قطعتين
    p.tokens = room.mode === 'quick' ? [0, -1, -1, -1] : [-1, -1, -1, -1];
    p.color = SEAT_COLORS[p.seat];
    p.pos = 0;
  });
  room.phase = 'roll';
  room.dice = 0;
  room.sixes = 0;
  room.legal = [];
  room.legalBy = {};
  if (room.mode === 'battle') {
    room.players.forEach(p => { p.hp = HPMAX.slice(); p.traps = []; p.absorbed = false; });
    resetTurn(room);
  }
  room.pend = [];       // الرميات المخزّنة التي لم تُستعمل بعد (مثلاً [6, 6, 3])
  room.rollsLeft = 1;   // عدد الرميات المتاحة حالياً (السته تعطي رمية إضافية، وكذلك الأكل والوصول للبيت)
}

function legalMoves(player, dice) {
  const out = [];
  player.tokens.forEach((r, i) => {
    if (r === -1 ? dice === 6 : r + dice <= FINISH) out.push(i);
  });
  return out;
}

// يحسب الحركات المتاحة لكل رقم مخزّن. الأرقام غير المستعملة تبقى مخزّنة لأن قطعة تطلع بالستة
// ممكن تخلّي رقم ثاني (مثل 3) قابل للاستعمال بعدها.
function refreshLegal(room, player) {
  const all = new Set();
  room.legalBy = {};
  for (const v of room.pend) {
    if (room.legalBy[v] !== undefined) continue;
    const t = legalMoves(player, v);
    if (t.length) { room.legalBy[v] = t; t.forEach(x => all.add(x)); }
  }
  room.legal = [...all].sort((a, b) => a - b);
}

const ringIndex = (seat, r) => (13 * seat + r) % 52;
// مربعات آمنة: مربع بداية كل لون + النجمة (بعد 8 مربعات من البداية)
const isSafe = ri => ri % 13 === 0 || ri % 13 === 8;

// القطع القابلة للأكل إذا نزل لاعب pi على المربع الخارجي ri.
// المربعات الآمنة (8: مربعات البداية الأربعة + النجوم الأربعة) ما يصير فيها أكل أبداً.
// التحصين: قطعتان من نفس اللون بنفس المربع ما ينأكلن (الخصم يكدر ينزل عليهن بدون أكل).
function capturable(room, pi, ri) {
  const out = [];
  if (isSafe(ri)) return out;
  room.players.forEach((q, qi) => {
    if (qi === pi) return;
    const here = [];
    q.tokens.forEach((r, qt) => { if (r >= 0 && r <= 50 && ringIndex(q.seat, r) === ri) here.push({ i: qi, tok: qt }); });
    if (here.length === 1) out.push(here[0]);   // قطعة منفردة فقط
  });
  return out;
}

function applyMove(room, pi, ti, dice) {
  const p = room.players[pi];
  const from = p.tokens[ti];
  const to = from === -1 ? 0 : from + dice;
  p.tokens[ti] = to;
  const captured = [];
  if (to <= 50) {
    capturable(room, pi, ringIndex(p.seat, to)).forEach(c => {
      room.players[c.i].tokens[c.tok] = -1; captured.push(c);
    });
  }
  return { from, to, captured };
}

// كلاسيك: كل القطع الأربع للبيت. سريع: قطعتان فقط.
const needHome = room => (room.mode === 'quick' ? 2 : room.mode === 'battle' ? 3 : 4);
const hasWon = (room, p) => p.tokens.filter(r => r === FINISH).length >= needHome(room);

// اختيار الجهاز: الوصول للبيت > الأكل > الدخول للممر > إخراج قطعة > التقدم
// يختار أفضل (رقم، قطعة) من الأرقام المخزّنة
function chooseBot(room, pi) {
  const p = room.players[pi];
  let best = null, bestScore = -1e9;
  for (const v in room.legalBy) for (const ti of room.legalBy[v]) {
    const dice = +v;
    const r = p.tokens[ti];
    const to = r === -1 ? 0 : r + dice;
    let score = Math.random() * 3;
    if (to === FINISH) score += 90;
    if (to <= 50) {
      const ri = ringIndex(p.seat, to);
      if (!isSafe(ri)) {
        if (capturable(room, pi, ri).length) score += 100;
      } else score += 12;
    }
    if (to >= 51 && to < FINISH) score += 45;
    if (r === -1) score += 40;
    score += to * 0.2; // قدّم القطع المتقدمة قليلاً
    if (score > bestScore) { bestScore = score; best = { tok: ti, val: dice }; }
  }
  return best;
}


// ================= وضع المعركة (Battle) =================
// كل لاعب عنده 4 جنود، كل جندي بنوع حسب رقمه: 0 مندفع، 1 مدرع، 2 قناص، 3 مهندس.
const CLASSES = ['rusher', 'tank', 'sniper', 'trapper'];
const HPMAX = [2, 3, 2, 2];

// حالة الدور الحالي: مين تحرك، وهل استُعملت قدرة القنص/الفخ
function resetTurn(room) {
  room.ts = { moved: [], shot: false, trapped: false, rush: false };
  const p = room.players[room.turn];
  if (p) p.absorbed = false;   // المدرع يكدر يمتص ضربة وحدة لكل دور
}

const ringDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 52 - d); };
function tokensAtRing(room, ri) {
  const out = [];
  room.players.forEach((q, qi) => q.tokens.forEach((r, qt) => {
    if (r >= 0 && r <= 50 && ringIndex(q.seat, r) === ri) out.push({ i: qi, tok: qt });
  }));
  return out;
}

// ضربة على جندي. kind: melee (التحام) | snipe | trap
// الدرع: يمتص 1 من الالتحام فقط (عادي 1 ← 0، انقضاض 2 ← 1). القنص والفخ يتجاوزان الدرع.
// المدرع يمتص 1 ضرر عن حليف بنفس الخانة أو المجاورة (مرة بالدور) ويخسر هو 1 HP.
function hurt(room, qi, qt, dmg, kind) {
  const q = room.players[qi];
  if (qt === 1 && kind === 'melee') dmg = Math.max(0, dmg - 1);
  let abs = null;
  if (dmg > 0 && qt !== 1 && !q.absorbed && q.hp[1] > 0) {
    const tr = q.tokens[1], vr = q.tokens[qt];
    if (tr >= 0 && tr <= 50 && vr >= 0 && vr <= 50 && ringDist(ringIndex(q.seat, tr), ringIndex(q.seat, vr)) <= 1) {
      q.absorbed = true; dmg -= 1; q.hp[1] -= 1;
      abs = { tok: 1, killed: false };
      if (q.hp[1] <= 0) { q.tokens[1] = -1; q.hp[1] = HPMAX[1]; abs.killed = true; }
    }
  }
  let killed = false;
  if (dmg > 0) {
    q.hp[qt] -= dmg;
    if (q.hp[qt] <= 0) { q.tokens[qt] = -1; q.hp[qt] = HPMAX[qt]; killed = true; }
  }
  return { i: qi, tok: qt, dmg, kind, killed, hp: q.hp[qt], abs };
}

// تحريك بوضع المعركة: يمشي خطوة خطوة، وإذا داس فخ خصم يتوقف ويتضرر. بعدها اشتباك فوري إذا وقف جنب عدو.
function applyMoveBattle(room, pi, ti, dice) {
  const p = room.players[pi];
  const from = p.tokens[ti];
  const hits = [], captured = [];
  let to, trap = false;
  if (from === -1) to = 0;
  else {
    to = from + dice;
    for (let r = from + 1; r <= to && r <= 50; r++) {
      const ri = ringIndex(p.seat, r);
      const owner = room.players.findIndex((q, qi) => qi !== pi && q.traps && q.traps.includes(ri));
      if (owner >= 0) {
        const q = room.players[owner];
        q.traps.splice(q.traps.indexOf(ri), 1);   // الفخ ينكشف وينتهي
        to = r; trap = true; break;
      }
    }
  }
  p.tokens[ti] = to;
  if (trap) {
    const h = hurt(room, pi, ti, 1, 'trap');
    hits.push(h);
    if (h.killed) captured.push({ i: pi, tok: ti });
    if (h.abs && h.abs.killed) captured.push({ i: pi, tok: 1 });
  } else if (to <= 50 && from !== -1) {
    const dmg = (ti === 0 && dice >= 4) ? 2 : 1;      // المندفع: انقضاض بضررين إذا كانت الرمية 4 أو أكثر
    capturable(room, pi, ringIndex(p.seat, to)).forEach(t => {
      const h = hurt(room, t.i, t.tok, dmg, 'melee');
      hits.push(h);
      if (h.killed) captured.push({ i: t.i, tok: t.tok });
      if (h.abs && h.abs.killed) captured.push({ i: t.i, tok: 1 });
    });
  }
  return { from, to, captured, hits, trap, rushKill: ti === 0 && captured.some(c => c.i !== pi) };
}

// القناص: بعد ما يتحرك بنفس الدور، مرة وحدة، يضرب عدو يبعد 2 أو 3 خانات أمامه بدون أي جندي بالخانات الفاصلة
function snipeTargets(room, pi) {
  const out = [];
  const p = room.players[pi];
  if (!p || room.mode !== 'battle' || !room.ts || room.ts.shot || !room.ts.moved.includes(2)) return out;
  const r = p.tokens[2];
  if (r < 0 || r > 50) return out;
  for (let d = 2; d <= 3; d++) {
    if (r + d > 50) break;
    if (tokensAtRing(room, ringIndex(p.seat, r + d - 1)).length) break;   // خط الرؤية مسدود
    const ri = ringIndex(p.seat, r + d);
    capturable(room, pi, ri).forEach(c => out.push({ i: c.i, tok: c.tok, d }));   // الآمنة والمحصّنة ما تنضرب
  }
  return out;
}
function doSnipe(room, pi, qi, qt) {
  if (!snipeTargets(room, pi).some(t => t.i === qi && t.tok === qt)) return null;
  room.ts.shot = true;
  const h = hurt(room, qi, qt, 1, 'snipe');
  const captured = [];
  if (h.killed) captured.push({ i: qi, tok: qt });
  if (h.abs && h.abs.killed) captured.push({ i: qi, tok: 1 });
  return { hit: h, captured };
}

// المهندس: بعد حركته ينصب فخ بالخانة اللي يقف عليها (غير آمنة). أقصى فخين، والأقدم يختفي.
function canTrap(room, pi) {
  const p = room.players[pi];
  if (!p || room.mode !== 'battle' || !room.ts || room.ts.trapped || !room.ts.moved.includes(3)) return false;
  const r = p.tokens[3];
  if (r < 0 || r > 50) return false;
  const ri = ringIndex(p.seat, r);
  if (isSafe(ri)) return false;
  return !room.players.some(q => q.traps && q.traps.includes(ri));
}
function placeTrap(room, pi) {
  if (!canTrap(room, pi)) return false;
  const p = room.players[pi];
  p.traps.push(ringIndex(p.seat, p.tokens[3]));
  if (p.traps.length > 2) p.traps.shift();
  room.ts.trapped = true;
  return true;
}

module.exports = { CLASSES, HPMAX, resetTurn, applyMoveBattle, snipeTargets, doSnipe, canTrap, placeTrap, capturable, needHome, hasWon, SEAT_COLORS, FINISH, init, legalMoves, refreshLegal, applyMove, chooseBot, ringIndex, isSafe };
