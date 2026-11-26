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
    p.tokens = [-1, -1, -1, -1];
    p.color = SEAT_COLORS[p.seat];
    p.pos = 0;
  });
  room.phase = 'roll';
  room.dice = 0;
  room.sixes = 0;
  room.legal = [];
}

function legalMoves(player, dice) {
  const out = [];
  player.tokens.forEach((r, i) => {
    if (r === -1 ? dice === 6 : r + dice <= FINISH) out.push(i);
  });
  return out;
}

const ringIndex = (seat, r) => (13 * seat + r) % 52;
// مربعات آمنة: مربع بداية كل لون + النجمة (بعد 8 مربعات من البداية)
const isSafe = ri => ri % 13 === 0 || ri % 13 === 8;

function applyMove(room, pi, ti) {
  const p = room.players[pi];
  const from = p.tokens[ti];
  const to = from === -1 ? 0 : from + room.dice;
  p.tokens[ti] = to;
  const captured = [];
  if (to <= 50) {
    const ri = ringIndex(p.seat, to);
    if (!isSafe(ri)) {
      room.players.forEach((q, qi) => {
        if (qi === pi) return;
        q.tokens.forEach((r, qt) => {
          if (r >= 0 && r <= 50 && ringIndex(q.seat, r) === ri) { q.tokens[qt] = -1; captured.push({ i: qi, tok: qt }); }
        });
      });
    }
  }
  return { from, to, captured };
}

const allHome = p => p.tokens.every(r => r === FINISH);

// اختيار الجهاز: الوصول للبيت > الأكل > الدخول للممر > إخراج قطعة > التقدم
function chooseBot(room, pi, legal) {
  const p = room.players[pi];
  let best = legal[0], bestScore = -1e9;
  for (const ti of legal) {
    const r = p.tokens[ti];
    const to = r === -1 ? 0 : r + room.dice;
    let score = Math.random() * 3;
    if (to === FINISH) score += 90;
    if (to <= 50) {
      const ri = ringIndex(p.seat, to);
      if (!isSafe(ri)) {
        const hit = room.players.some((q, qi) => qi !== pi && q.tokens.some(x => x >= 0 && x <= 50 && ringIndex(q.seat, x) === ri));
        if (hit) score += 100;
      } else score += 12;
    }
    if (to >= 51 && to < FINISH) score += 45;
    if (r === -1) score += 40;
    score += to * 0.2; // قدّم القطع المتقدمة قليلاً
    if (score > bestScore) { bestScore = score; best = ti; }
  }
  return best;
}

module.exports = { SEAT_COLORS, FINISH, init, legalMoves, applyMove, allHome, chooseBot, ringIndex, isSafe };
