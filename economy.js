// النظام المالي لكعدة بلي: عملات + متجر (أغراض دائمة ومؤقتة) + مكافأة يومية + جوائز نهاية اللعبة
// كل شيء هنا يعمل على السيرفر فقط (المتصفح يعرض ويطلب، والسيرفر يقرر)، والبيانات تُحفظ داخل حساب اللاعب u.eco
const HOUR = 3600e3, DAY = 24 * HOUR;
const num = (v, d) => { const n = parseInt(v); return Number.isFinite(n) && n >= 0 ? n : d; };

// ---------- إعدادات يمكن تعديلها من Render > Environment ----------
const START_COINS = num(process.env.ECON_START, 100);          // هدية أول مرة
const CAP_MULTI = num(process.env.ECON_CAP_MULTI, 600);        // أقصى ربح يومي من اللعب مع لاعبين حقيقيين
const CAP_SOLO = num(process.env.ECON_CAP_SOLO, 120);          // أقصى ربح يومي من اللعب ضد الجهاز
const MIN_GAME_MS = num(process.env.ECON_MIN_GAME_MS, 45000);  // لعبة أقصر من هذا ما تعطي جائزة (منع التزريع)
const SOLO_FACTOR = 0.3;                                       // جائزة اللعب ضد الجهاز = 30% من العادية
const REWARDS = {                                              // جائزة الفوز / المشاركة
  snakes: { win: 40, lose: 12 },
  ludo: { win: 40, lose: 12 },
  mafia: { win: 50, lose: 15 },
  mheibes: { win: 40, lose: 12 },
};
const DAILY_COOLDOWN = 20 * HOUR;       // المكافأة اليومية كل 20 ساعة
const DAILY_STREAK_BREAK = 44 * HOUR;   // إذا تأخر أكثر من هذا ينقطع التتابع
const dailyAmount = streak => 20 + 10 * Math.min(streak, 7);   // 30 ... 90
const MAX_TEMP_AHEAD = 30 * DAY;        // أقصى تمديد للغرض المؤقت

// ---------- الخانات (غرض واحد مجهّز بكل خانة) ----------
const SLOTS = ['color', 'title', 'dice', 'frame', 'aura'];

// ---------- الكتالوج ----------
// kind: perm = دائم (يُشترى مرة وحدة) | temp = مؤقت (مدة dur، وإعادة الشراء تمدّد)
// fx: 'x2' = مضاعف العملات (لا يتراكم). v = قيمة للعرض (اللقب = الإيموجي). الشكل نفسه يُرسم بالواجهة حسب id
const CATALOG = [
  // ألوان الأسماء (دائمة)
  { id: 'c_gold', slot: 'color', kind: 'perm', price: 150, ic: '🟡', name: 'اسم ذهبي', desc: 'اسمك يظهر بالذهبي لكل اللاعبين' },
  { id: 'c_mint', slot: 'color', kind: 'perm', price: 150, ic: '🟢', name: 'اسم نعناعي', desc: 'لون أخضر مائل للأزرق' },
  { id: 'c_pink', slot: 'color', kind: 'perm', price: 150, ic: '🌸', name: 'اسم وردي', desc: 'لون وردي هادئ' },
  { id: 'c_rainbow', slot: 'color', kind: 'perm', price: 500, ic: '🌈', name: 'اسم قوس قزح', desc: 'اسم متحرك بكل الألوان' },
  // ألقاب (دائمة)
  { id: 't_star', slot: 'title', kind: 'perm', price: 200, ic: '⭐', v: '⭐', name: 'لقب النجمة', desc: 'نجمة قبل اسمك' },
  { id: 't_fire', slot: 'title', kind: 'perm', price: 250, ic: '🔥', v: '🔥', name: 'لقب النار', desc: 'شعلة قبل اسمك' },
  { id: 't_snake', slot: 'title', kind: 'perm', price: 250, ic: '🐍', v: '🐍', name: 'لقب الحية', desc: 'حية قبل اسمك' },
  { id: 't_dice', slot: 'title', kind: 'perm', price: 250, ic: '🎲', v: '🎲', name: 'لقب النرد', desc: 'نردة قبل اسمك' },
  { id: 't_crown', slot: 'title', kind: 'perm', price: 600, ic: '👑', v: '👑', name: 'لقب التاج', desc: 'تاج قبل اسمك' },
  // مظاهر النرد (دائمة): تظهر على نردك لما يجي دورك
  { id: 'd_gold', slot: 'dice', kind: 'perm', price: 350, ic: '🟨', name: 'نرد ذهبي', desc: 'نردك يلمع بالذهب' },
  { id: 'd_ruby', slot: 'dice', kind: 'perm', price: 350, ic: '🟥', name: 'نرد ياقوتي', desc: 'أحمر ياقوتي ونقاط بيضاء' },
  { id: 'd_neon', slot: 'dice', kind: 'perm', price: 450, ic: '🟦', name: 'نرد نيون', desc: 'داكن بنقاط نيون مضيئة' },
  // إطار (دائم)
  { id: 'f_gold', slot: 'frame', kind: 'perm', price: 500, ic: '🖼️', name: 'إطار ذهبي', desc: 'إطار ذهبي حول اسمك باللعب' },

  // ---- مؤقتة ----
  { id: 'b_x2_1h', slot: null, kind: 'temp', dur: 1 * HOUR, fx: 'x2', price: 70, ic: '⚡', name: 'مضاعف العملات ساعة', desc: 'جوائز اللعب ×2 لمدة ساعة (لا يتراكم)' },
  { id: 'b_x2_24h', slot: null, kind: 'temp', dur: 24 * HOUR, fx: 'x2', price: 220, ic: '🚀', name: 'مضاعف العملات يوم', desc: 'جوائز اللعب ×2 لمدة 24 ساعة (لا يتراكم)' },
  { id: 'a_glow', slot: 'aura', kind: 'temp', dur: 24 * HOUR, price: 100, ic: '✨', name: 'توهج الاسم', desc: 'هالة مضيئة حول اسمك لمدة 24 ساعة' },
  { id: 'f_fire', slot: 'frame', kind: 'temp', dur: 3 * DAY, price: 150, ic: '🔥', name: 'إطار ناري', desc: 'إطار ناري متحرك لمدة 3 أيام' },
  { id: 't_vip', slot: 'title', kind: 'temp', dur: 7 * DAY, price: 200, ic: '💎', v: '💎', name: 'لقب VIP', desc: 'ماسة قبل اسمك لمدة 7 أيام' },
  { id: 'd_ice', slot: 'dice', kind: 'temp', dur: 24 * HOUR, price: 120, ic: '🧊', name: 'نرد ثلجي', desc: 'نرد جليدي لمدة 24 ساعة' },
];
const BY_ID = Object.create(null);
CATALOG.forEach(it => { BY_ID[it.id] = it; });
// نسخة للعميل (بدون أي شيء حساس): نفس الحقول
const PUBLIC_CATALOG = CATALOG.map(it => ({ id: it.id, slot: it.slot, kind: it.kind, price: it.price, ic: it.ic, v: it.v || null, name: it.name, desc: it.desc, dur: it.dur || 0 }));

// ---------- بيانات اللاعب ----------
function ensure(u) {
  if (!u.eco || typeof u.eco !== 'object') u.eco = {};
  const e = u.eco;
  if (!Number.isFinite(e.coins)) e.coins = START_COINS;      // لاعبو قبل التحديث ياخذون الهدية أيضاً
  if (!Array.isArray(e.owned)) e.owned = [];
  if (!e.temp || typeof e.temp !== 'object') e.temp = {};
  if (!e.eq || typeof e.eq !== 'object') e.eq = {};
  if (!Number.isFinite(e.dl)) e.dl = 0;          // آخر مكافأة يومية
  if (!Number.isFinite(e.ds)) e.ds = 0;          // التتابع
  if (typeof e.day !== 'string') e.day = '';
  if (!Number.isFinite(e.earned)) e.earned = 0;  // أرباح اليوم (لاعبين حقيقيين)
  if (!Number.isFinite(e.solo)) e.solo = 0;      // أرباح اليوم (ضد الجهاز)
  return e;
}
const dayKey = now => new Date(now).toISOString().slice(0, 10);
function rollDay(e, now) {
  const k = dayKey(now);
  if (e.day !== k) { e.day = k; e.earned = 0; e.solo = 0; }
}
function has(e, id, now) {
  const it = BY_ID[id];
  if (!it) return false;
  return it.kind === 'perm' ? e.owned.includes(id) : (e.temp[id] || 0) > now;
}
// حذف المؤقت المنتهي وفك تجهيز أي غرض ما عاد صالح
function prune(u, now) {
  const e = ensure(u);
  for (const id in e.temp) if (!BY_ID[id] || e.temp[id] <= now) delete e.temp[id];
  for (const s of Object.keys(e.eq)) {
    if (!SLOTS.includes(s) || !has(e, e.eq[s], now) || BY_ID[e.eq[s]].slot !== s) delete e.eq[s];
  }
  rollDay(e, now);
  return e;
}
function boostUntil(e, now) {
  let t = 0;
  CATALOG.forEach(it => { if (it.fx === 'x2' && (e.temp[it.id] || 0) > now) t = Math.max(t, e.temp[it.id]); });
  return t;
}

// الشكل الظاهر للاعبين الآخرين (معرّفات فقط)
function lookOf(u) {
  if (!u) return null;
  const e = prune(u, Date.now());
  const out = {};
  SLOTS.forEach(s => { if (e.eq[s]) out[s] = e.eq[s]; });
  return Object.keys(out).length ? out : null;
}

function dailyStatus(e, now) {
  const since = now - e.dl;
  const ready = !e.dl || since >= DAILY_COOLDOWN;
  const alive = e.dl && since <= DAILY_STREAK_BREAK;
  const nextStreak = alive ? e.ds + 1 : 1;
  return { ready, in: ready ? 0 : DAILY_COOLDOWN - since, streak: alive ? e.ds : 0, next: dailyAmount(nextStreak), nextStreak };
}

function walletView(u) {
  const now = Date.now(), e = prune(u, now);
  return {
    t: 'wallet', now, coins: e.coins, owned: e.owned.slice(), temp: Object.assign({}, e.temp), eq: Object.assign({}, e.eq),
    daily: dailyStatus(e, now),
    boost: boostUntil(e, now),
    cap: { earned: e.earned, cap: CAP_MULTI, solo: e.solo, soloCap: CAP_SOLO },
    cat: PUBLIC_CATALOG,
  };
}

// ---------- العمليات (ترجع { ok, msg } أو { err }) ----------
function buy(u, id) {
  const now = Date.now(), e = prune(u, now), it = BY_ID[id];
  if (!it) return { err: 'هذا الغرض غير موجود' };
  if (it.kind === 'perm') {
    if (e.owned.includes(id)) return { err: 'تملكه بالفعل' };
  } else if ((Math.max(now, e.temp[id] || 0) + it.dur) - now > MAX_TEMP_AHEAD) {
    return { err: 'وصلت الحد الأقصى للتمديد (30 يوم)' };
  }
  if (e.coins < it.price) return { err: 'رصيدك غير كافٍ (ينقصك ' + (it.price - e.coins) + ' 🪙)' };
  e.coins -= it.price;
  let msg;
  if (it.kind === 'perm') { e.owned.push(id); msg = 'اشتريت ' + it.name + ' ✅'; }
  else { e.temp[id] = Math.max(now, e.temp[id] || 0) + it.dur; msg = 'تم تفعيل ' + it.name + ' ✅'; }
  if (it.slot && !e.eq[it.slot]) e.eq[it.slot] = id;   // إذا الخانة فاضية جهّزه تلقائياً
  return { ok: true, msg };
}
function equip(u, slot, id) {
  const now = Date.now(), e = prune(u, now);
  if (!SLOTS.includes(slot)) return { err: 'خانة غير صحيحة' };
  if (id == null) { delete e.eq[slot]; return { ok: true, msg: 'تم إلغاء التجهيز' }; }
  const it = BY_ID[id];
  if (!it || it.slot !== slot) return { err: 'هذا الغرض لا يناسب الخانة' };
  if (!has(e, id, now)) return { err: it.kind === 'temp' ? 'انتهت مدة هذا الغرض' : 'ما تملك هذا الغرض' };
  e.eq[slot] = id;
  return { ok: true, msg: 'تم تجهيز ' + it.name };
}
function claimDaily(u) {
  const now = Date.now(), e = prune(u, now), d = dailyStatus(e, now);
  if (!d.ready) return { err: 'المكافأة القادمة بعد ' + Math.ceil(d.in / 60000) + ' دقيقة' };
  e.coins += d.next; e.dl = now; e.ds = d.nextStreak;
  return { ok: true, msg: '🎁 استلمت ' + d.next + ' 🪙 (اليوم ' + Math.min(e.ds, 7) + ' من التتابع)' };
}

// ---------- جوائز نهاية اللعبة ----------
function winnersOf(room) {
  const w = new Set(), g = room.game || 'snakes';
  if (g === 'mafia' && room.mf) room.players.forEach((p, i) => { if ((room.mf.winner === 'mafia') === (p.role === 'mafia')) w.add(i); });
  else if (g === 'mheibes' && room.mh) room.players.forEach((p, i) => { if (i % 2 === room.mh.winner) w.add(i); });
  else if (room.winner >= 0) w.add(room.winner);
  return w;
}
// تُستدعى مرة وحدة لكل لعبة منتهية. userOf(token) ترجع حساب اللاعب أو undefined (الأجهزة).
// ترجع قائمة { u, win, gain, mult, total, capped } لكل لاعب حقيقي استلم شيئاً.
function settle(room, userOf) {
  const out = [];
  if (room.rewarded) return out;
  room.rewarded = true;
  if (room.endReason !== 'win') return out;                     // انسحاب الكل ما عدا واحد: لا جوائز
  if (Date.now() - (room.startedAt || 0) < MIN_GAME_MS) return out;
  const humans = room.players.filter(p => !p.bot);
  const solo = humans.length < 2;
  const wins = winnersOf(room), R = REWARDS[room.game || 'snakes'] || REWARDS.snakes;
  const now = Date.now();
  room.players.forEach((p, i) => {
    if (p.bot || p.left) return;
    const u = userOf(p.token);
    if (!u) return;
    const e = prune(u, now);
    const win = wins.has(i);
    let base = win ? R.win : R.lose;
    if (solo) base = Math.round(base * SOLO_FACTOR);
    const cap = solo ? CAP_SOLO : CAP_MULTI, used = solo ? e.solo : e.earned;
    const gain = Math.max(0, Math.min(base, cap - used));
    if (solo) e.solo += gain; else e.earned += gain;
    const mult = boostUntil(e, now) > now ? 2 : 1;
    const total = gain * mult;
    e.coins += total;
    out.push({ u, win, gain, mult, total, capped: gain < base });
  });
  return out;
}

module.exports = { CATALOG, SLOTS, ensure, prune, lookOf, walletView, buy, equip, claimDaily, settle, winnersOf };
