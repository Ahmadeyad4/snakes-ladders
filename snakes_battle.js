// وضع المعركة لحية ودرج (السيرفر هو الحَكَم). كل لاعب جندي واحد بنوع عشوائي:
// 0 مندفع (2♥) | 1 مدرع (3♥) | 2 قناص (2♥) | 3 مهندس (2♥)
const HP = [2, 3, 2, 2];
// الملاجئ: خانة 0 وكل مضاعف 10. ما ينضرب أحد عليها.
const isSafe = n => n === 0 || n % 10 === 0;

function init(room) {
  // اختيار اللاعب أولاً، ومن ما اختار ياخذ نوع عشوائي (يفضَّل نوع ما اختاره غيره)
  const picked = room.players.map(p => (Number.isInteger(p.pick) && p.pick >= 0 && p.pick <= 3 ? p.pick : null));
  const pool = [0, 1, 2, 3].filter(c => !picked.includes(c)).sort(() => Math.random() - 0.5);
  room.players.forEach((p, i) => {
    p.cls = picked[i] != null ? picked[i] : (pool.length ? pool.pop() : Math.floor(Math.random() * 4));
    p.pos = 0; p.hp = HP[p.cls]; p.traps = []; p.shield = false;
  });
  room.phase = 'roll'; room.extra = false;
  resetTurn(room);
}
function resetTurn(room) { room.ts = { shot: false, trapped: false }; }

// ضربة: المدرع يمتص 1 من الالتحام. إذا مات يرجع لآخر ملجأ تحته بكامل طاقته.
function hit(room, qi, dmg, kind) {
  const q = room.players[qi];
  if (q.cls === 1 && kind === 'melee') dmg = Math.max(0, dmg - 1);
  let killed = false;
  if (dmg > 0) {
    q.hp -= dmg;
    if (q.hp <= 0) { q.hp = HP[q.cls]; q.pos = Math.floor(q.pos / 10) * 10; killed = true; }
  }
  return { i: qi, dmg, kind, killed, hp: q.hp };
}

// رمية + حركة. يرجع { from, land, to, hits, trap, rush }
function move(room, pi, dice, SNAKES, LADDERS) {
  const p = room.players[pi], from = p.pos, hits = [];
  let land = from + dice, trap = false;
  if (land > 100) return { from, land: from, to: from, hits, trap, rush: false };
  for (let s = from + 1; s <= land; s++) {          // فخ خصم بالطريق (حتى لو مرّيت فوقه)
    const o = room.players.findIndex((q, qi) => qi !== pi && q.traps.includes(s));
    if (o >= 0) { room.players[o].traps.splice(room.players[o].traps.indexOf(s), 1); land = s; trap = true; break; }
  }
  let to = land, rush = false;
  if (!trap) {
    if (SNAKES[land]) {
      if (p.cls === 1 && !p.shield) { p.shield = true; hits.push({ i: pi, kind: 'shield', dmg: 0 }); }   // درع المدرع: يتجاهل أول لدغة
      else to = SNAKES[land];
    } else if (LADDERS[land]) to = LADDERS[land];
  }
  p.pos = to;
  if (trap) hits.push(hit(room, pi, 1, 'trap'));
  else if (to < 100 && !isSafe(to)) {                 // الوقوف على عدو = ضربة فورية (المندفع ضررين برمية 4+)
    room.players.forEach((q, qi) => {
      if (qi === pi || q.pos !== to) return;
      const h = hit(room, qi, (p.cls === 0 && dice >= 4) ? 2 : 1, 'melee');
      hits.push(h);
      if (h.killed && p.cls === 0) rush = true;       // المندفع يقتل = رمية إضافية
    });
  }
  return { from, land, to: p.pos, hits, trap, rush };
}

// القناص: بعد حركته يضرب عدو يبعد 2..6 خانات قدامه (مرة بالدور، مو على الملاجئ)
function snipeTargets(room, pi) {
  const p = room.players[pi], out = [];
  if (!p || p.cls !== 2 || !room.ts || room.ts.shot) return out;
  room.players.forEach((q, qi) => {
    const d = q.pos - p.pos;
    if (qi !== pi && d >= 2 && d <= 6 && !isSafe(q.pos)) out.push({ i: qi, d });
  });
  return out;
}
function snipe(room, pi, qi) {
  if (!snipeTargets(room, pi).some(t => t.i === qi)) return null;
  room.ts.shot = true;
  return hit(room, qi, 1, 'snipe');
}

// المهندس: ينصب فخ مخفي بخانته (مو ملجأ). أقصى فخين، والأقدم يختفي.
function canTrap(room, pi) {
  const p = room.players[pi];
  if (!p || p.cls !== 3 || !room.ts || room.ts.trapped) return false;
  if (p.pos <= 0 || p.pos >= 100 || isSafe(p.pos)) return false;
  return !room.players.some(q => q.traps.includes(p.pos));
}
function placeTrap(room, pi) {
  if (!canTrap(room, pi)) return false;
  const p = room.players[pi];
  p.traps.push(p.pos);
  if (p.traps.length > 2) p.traps.shift();
  room.ts.trapped = true;
  return true;
}
const hasActs = (room, pi) => canTrap(room, pi) || snipeTargets(room, pi).length > 0;

module.exports = { HP, init, resetTurn, move, snipeTargets, snipe, canTrap, placeTrap, hasActs };
