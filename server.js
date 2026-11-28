// سيرفر كعدة بلي (Ka'da Play) - Node.js + ws
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const sb = require('./snakes_battle');
const economy = require('./economy');
let ludo = null;
try { ludo = require('./ludo'); } catch (e) { console.error('ludo.js غير موجود، لعبة لودو معطلة:', e.message); }
let mafia = null;
try { mafia = require('./mafia'); } catch (e) { console.error('mafia.js غير موجود، لعبة المافيا معطلة:', e.message); }

const PORT = process.env.PORT || 3000;
const SNAKES = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };
const LADDERS = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };
const COLORS = ['#ff4d6d', '#2ec4b6', '#ffb703', '#4895ef', '#b388ff', '#ff8fab', '#8ac926', '#ff924c', '#4cc9f0', '#c9a227'];
let mheibes = null;
try { mheibes = require('./mheibes'); } catch (e) { console.error('mheibes.js غير موجود، لعبة المحيبس معطلة:', e.message); }
const MAFIA_BOT_NAMES = ['حيدر', 'زينب', 'كرار', 'مريم', 'حسن', 'نور', 'عمر', 'سارة', 'علي'];
const minPlayers = room => (room.game === 'mafia' ? mafia.MIN : room.game === 'mheibes' ? mheibes.MIN : 2);
const EMOJIS = ['😂', '😡', '👏', '😭', '🔥', '👍', '😎', '🙈'];
const TURN_MS = parseInt(process.env.TURN_MS) || 25000;
const BOT_MS = parseInt(process.env.BOT_MS) || 1400;
const DC_GRACE = parseInt(process.env.DC_GRACE_MS) || 40000; // مهلة انتظار اللاعب المنقطع قبل اعتباره منسحباً

const rooms = new Map();

// ---------- الحسابات والأصدقاء ----------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const users = Object.create(null); // token -> { id, name, friends:[id], requests:[id] } (بدون prototype: توكن مثل __proto__ ما يلوّث Object.prototype)
const byId = new Map();      // id -> user
const online = new Map();    // id -> Set(ws)

// ---------- التخزين الدائم ----------
// إذا ضبطت UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN تُحفظ الحسابات والأصدقاء بقاعدة Upstash (تبقى بعد كل تحديث).
// بدونهما تُحفظ بملف محلي، وهذا الملف يُمسح على Render المجاني عند كل نشر أو إعادة تشغيل.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = 'kadaplay:data';
const OLD_REDIS_KEY = 'snakes-ladders:data'; // المفتاح القديم: يُقرأ مرة واحدة لنقل الحسابات
const useRedis = !!(REDIS_URL && REDIS_TOKEN);
// Supabase (له الأولوية على Upstash): ضبط SUPABASE_URL و SUPABASE_SERVICE_KEY (مفتاح service_role / secret، للسيرفر فقط).
// الجدول: kadaplay_data (انظر supabase.sql)
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ROW = 'main';
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

async function redisCmd(args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function supabaseReq(method, query, body, extra) {
  const headers = Object.assign({ apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY; // المفاتيح الجديدة sb_secret_ تكفي بـ apikey
  const r = await fetch(SUPABASE_URL + '/rest/v1/kadaplay_data' + query, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('supabase http ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return method === 'GET' ? r.json() : null;
}
async function supabaseGet() {
  const rows = await supabaseReq('GET', '?select=value&key=eq.' + SUPABASE_ROW);
  return rows && rows[0] ? rows[0].value : null;
}
function supabaseSet(obj) {
  return supabaseReq('POST', '?on_conflict=key', { key: SUPABASE_ROW, value: obj, updated_at: new Date().toISOString() },
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}
function loadFromFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return null; }
}
async function loadData() {
  let d = null;
  if (useSupabase) {
    for (let i = 0; i < 5; i++) {
      try { d = await supabaseGet(); break; }
      catch (e) {
        console.error('Supabase load failed:', e.message);
        // لا نبدأ بحسابات فارغة حتى لا نمسح البيانات المحفوظة
        if (i === 4) { console.error('Giving up, exiting so the host restarts us'); process.exit(1); }
        await sleepMs(1500);
      }
    }
    if (!d) { // أول تشغيل: انقل الحسابات القديمة من Upstash أو الملف إن وُجدت
      if (useRedis) { try { const v = await redisCmd(['GET', REDIS_KEY]); d = v ? JSON.parse(v) : null; if (d) console.log('Migrating accounts from Upstash to Supabase'); } catch (e) {} }
      if (!d) d = loadFromFile();
      if (d && d.users && Object.keys(d.users).length) { try { await supabaseSet(d); } catch (e) { console.error('Migration save failed:', e.message); } }
    }
  } else if (useRedis) {
    for (let i = 0; i < 5; i++) {
      try {
        let v = await redisCmd(['GET', REDIS_KEY]);
        if (!v) { v = await redisCmd(['GET', OLD_REDIS_KEY]); if (v) console.log('Migrating accounts from old Redis key'); }
        d = v ? JSON.parse(v) : null; break;
      }
      catch (e) {
        console.error('Redis load failed:', e.message);
        // لا نبدأ بحسابات فارغة حتى لا نمسح البيانات المحفوظة
        if (i === 4) { console.error('Giving up, exiting so the host restarts us'); process.exit(1); }
        await sleepMs(1500);
      }
    }
    if (!d) d = loadFromFile(); // أول تشغيل: انقل ما في الملف إن وُجد
  } else d = loadFromFile();
  Object.assign(users, (d && d.users) || {});
  for (const t in users) byId.set(users[t].id, users[t]);
  console.log('Storage:', useSupabase ? 'Supabase' : useRedis ? 'Upstash Redis' : 'local file', '| users:', Object.keys(users).length);
}

let saveTimer = null, saving = false, pending = false, again = false;
function saveData() {
  pending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushData, 800);
}
async function flushData() {
  clearTimeout(saveTimer);
  if (saving) { again = true; return; }
  saving = true; pending = false; again = false;
  const payload = JSON.stringify({ users });
  try {
    if (useSupabase) await supabaseSet({ users });
    else if (useRedis) await redisCmd(['SET', REDIS_KEY, payload]);
    else {
      await fs.promises.writeFile(DATA_FILE + '.tmp', payload);
      await fs.promises.rename(DATA_FILE + '.tmp', DATA_FILE);
    }
  } catch (e) {
    console.error('Save failed:', e.message);
    pending = true;
    saveTimer = setTimeout(flushData, 5000);
  }
  saving = false;
  if (again) { again = false; saveData(); }
}
// عند إيقاف السيرفر (نشر جديد) نحفظ آخر تغييرات قبل الإغلاق
process.on('SIGTERM', async () => {
  clearTimeout(saveTimer);
  while (saving) await sleepMs(50);
  if (pending) await flushData();
  process.exit(0);
});

function newId() {
  for (;;) {
    const id = String(100000 + Math.floor(Math.random() * 900000));
    if (!byId.has(id)) return id;
  }
}
function isOnline(id) { const s = online.get(id); return !!s && s.size > 0; }
function socialFor(u) {
  const pub = id => byId.get(id);
  return {
    t: 'social',
    me: { id: u.id, name: u.name },
    friends: u.friends.map(pub).filter(Boolean).map(f => ({ id: f.id, name: f.name, online: isOnline(f.id) })),
    requests: u.requests.map(pub).filter(Boolean).map(f => ({ id: f.id, name: f.name })),
  };
}
function pushSocial(u) {
  const s = online.get(u.id);
  if (s) s.forEach(w => send(w, socialFor(u)));
}
// ---------- المحفظة والجوائز ----------
function pushWallet(u) {
  const s = online.get(u.id);
  if (s && s.size) { const v = economy.walletView(u); s.forEach(w => send(w, v)); }
}
// تُستدعى مرة وحدة عند انتهاء كل لعبة (من sendRoom)
function settleRoom(room) {
  const res = economy.settle(room, tok => users[tok]);
  if (!res.length) return;
  saveData();
  res.forEach(r => {
    pushWallet(r.u);
    const s = online.get(r.u.id);
    if (s) s.forEach(w => send(w, { t: 'reward', win: r.win, base: r.gain, mult: r.mult, total: r.total, capped: r.capped, coins: r.u.eco.coins }));
  });
}
function notifyFriends(u) {
  u.friends.forEach(id => { const f = byId.get(id); if (f) pushSocial(f); });
}
function goOffline(ws) {
  const u = ws.user;
  if (!u) return;
  ws.user = null;
  const s = online.get(u.id);
  if (s) { s.delete(ws); if (s.size === 0) online.delete(u.id); }
  if (!isOnline(u.id)) notifyFriends(u);
}
function makeFriends(a, b) {
  a.requests = a.requests.filter(x => x !== b.id);
  b.requests = b.requests.filter(x => x !== a.id);
  if (!a.friends.includes(b.id)) a.friends.push(b.id);
  if (!b.friends.includes(a.id)) b.friends.push(a.id);
  saveData();
  pushSocial(a); pushSocial(b);
}
function handleSocial(ws, m, token) {
  if (m.t === 'hello') {
    if (!token) return true;
    const nm = String(m.name || '').trim().slice(0, 14);
    let u = users[token];
    if (!u) {
      u = { id: newId(), name: nm || 'لاعب', friends: [], requests: [] };
      users[token] = u; byId.set(u.id, u); saveData();
    } else if (nm && nm !== u.name) { u.name = nm; saveData(); }
    if (ws.user !== u) {
      goOffline(ws);
      ws.user = u;
      if (!online.has(u.id)) online.set(u.id, new Set());
      online.get(u.id).add(ws);
    }
    pushSocial(u);
    pushWallet(u);
    notifyFriends(u);
    return true;
  }
  if (m.t === 'wallet_get' || m.t === 'shop_buy' || m.t === 'shop_equip' || m.t === 'daily_claim') {
    const u = ws.user;
    if (!u) return true;
    if (m.t === 'wallet_get') { pushWallet(u); return true; }
    const r = m.t === 'shop_buy' ? economy.buy(u, String(m.id || '').slice(0, 40))
      : m.t === 'shop_equip' ? economy.equip(u, String(m.slot || '').slice(0, 20), m.id == null ? null : String(m.id).slice(0, 40))
      : economy.claimDaily(u);
    if (r.err) send(ws, { t: 'err', msg: r.err }); else { saveData(); send(ws, { t: 'ok', msg: r.msg }); }
    pushWallet(u);
    return true;
  }
  if (!['friend_add', 'friend_accept', 'friend_decline', 'friend_remove', 'invite'].includes(m.t)) return false;
  const u = ws.user;
  if (!u) return true;
  const t = byId.get(String(m.id || '').trim());
  if (m.t === 'friend_add') {
    if (!t) return send(ws, { t: 'err', msg: 'ما لقيت لاعب بهذا الرقم' }), true;
    if (t === u) return send(ws, { t: 'err', msg: 'هذا رقمك أنت' }), true;
    if (u.friends.includes(t.id)) return send(ws, { t: 'err', msg: 'مضاف عندك بالفعل' }), true;
    if (u.friends.length >= 100) return send(ws, { t: 'err', msg: 'وصلت الحد الأقصى للأصدقاء' }), true;
    if (u.requests.includes(t.id)) { makeFriends(u, t); send(ws, { t: 'ok', msg: 'صرتم أصدقاء ✅' }); return true; }
    if (t.requests.includes(u.id)) return send(ws, { t: 'err', msg: 'أرسلت له طلب من قبل' }), true;
    if (t.requests.length >= 50) return send(ws, { t: 'err', msg: 'عنده طلبات كثيرة، جرّب لاحقاً' }), true;
    t.requests.push(u.id); saveData(); pushSocial(t);
    send(ws, { t: 'ok', msg: 'تم إرسال طلب الصداقة' });
  } else if (m.t === 'friend_accept') {
    if (t && u.requests.includes(t.id)) makeFriends(u, t);
  } else if (m.t === 'friend_decline') {
    if (t) { u.requests = u.requests.filter(x => x !== t.id); saveData(); pushSocial(u); }
  } else if (m.t === 'friend_remove') {
    if (t) {
      u.friends = u.friends.filter(x => x !== t.id);
      t.friends = t.friends.filter(x => x !== u.id);
      saveData(); pushSocial(u); pushSocial(t);
    }
  } else if (m.t === 'invite') {
    const room = ws.room;
    if (!room || room.state !== 'lobby' || !t || !u.friends.includes(t.id)) return true;
    if (room.players.length >= room.max) return send(ws, { t: 'err', msg: 'الغرفة ممتلئة' }), true;
    if (room.players.some(p => p.token && users[p.token] === t)) return send(ws, { t: 'err', msg: 'هو موجود بالغرفة' }), true;
    const socks = online.get(t.id);
    if (!socks || socks.size === 0) return send(ws, { t: 'err', msg: 'صديقك مو متصل الآن' }), true;
    const now = Date.now();
    if (now - (ws.lastInvite || 0) < 2000) return true;
    ws.lastInvite = now;
    socks.forEach(w => send(w, { t: 'invite', code: room.code, max: room.max, game: room.game || 'snakes', mode: room.mode || 'classic', from: { id: u.id, name: u.name } }));
    send(ws, { t: 'ok', msg: 'تم إرسال الدعوة' });
  }
  return true;
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(c)) return c;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else if (/^\/icon(-192|-512)?\.(png|svg)$/.test(req.url)) {
    fs.readFile(path.join(__dirname, 'public', req.url.slice(1)), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  } else if (req.url === '/dice.mp3' || req.url === '/music.mp3' || req.url === '/war.mp3') {
    fs.readFile(path.join(__dirname, 'public', req.url.slice(1)), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=604800' });
      res.end(data);
    });
  } else if (req.url === '/three.min.js') {
    fs.readFile(path.join(__dirname, 'public', 'three.min.js'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
      res.end(data);
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 }); // الافتراضي 100MB: JSON.parse عليه يجمّد السيرفر

// ---------- حماية من الإغراق والتخمين ----------
// نفترض بروكسي واحد (Render): آخر عنوان بـ x-forwarded-for هو اللي أضافه البروكسي، وأول عناوين الهيدر ممكن العميل يزوّرها.
const MSG_PER_SEC = 40, MAX_CONN_PER_IP = 20, JOIN_FAILS = 10, JOIN_WINDOW = 60000;
const ipConns = new Map(), joinFails = new Map();
function ipOf(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map(x => x.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : (req.socket && req.socket.remoteAddress) || '?';
}
function joinBlocked(ip) { const f = joinFails.get(ip); return !!f && f.n >= JOIN_FAILS && Date.now() < f.until; }
function joinFailed(ip) {
  const now = Date.now(); let f = joinFails.get(ip);
  if (!f || now > f.until) f = { n: 0, until: now + JOIN_WINDOW };
  f.n++; joinFails.set(ip, f);
}
setInterval(() => { const now = Date.now(); joinFails.forEach((f, k) => { if (now > f.until) joinFails.delete(k); }); }, 60000).unref();
process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendRoom(room) {
  const looks = room.players.map(q => (q.token && !q.bot ? economy.lookOf(users[q.token]) : null));
  room.players.forEach((p, i) => {
    send(p.ws, {
      t: 'room',
      you: i,
      code: room.code,
      max: room.max,
      state: room.state,
      host: room.host,
      turn: room.turn,
      winner: room.winner,
      pub: !!room.pub,
      game: room.game || 'snakes',
      mode: room.mode || 'classic',
      min: minPlayers(room),
      mf: room.game === 'mafia' && mafia ? mafia.view(room, i) : null,
      mh: room.game === 'mheibes' && mheibes ? mheibes.view(room, i) : null,
      acts: room.game === 'ludo' && room.mode === 'battle' && room.state === 'play'
        ? { snipe: ludo.snipeTargets(room, room.turn).map(t => ({ i: t.i, tok: t.tok })), trap: ludo.canTrap(room, room.turn) } : (room.game !== 'ludo' && room.mode === 'battle' && room.state === 'play'
        ? { snipe: sb.snipeTargets(room, room.turn).map(t => ({ i: t.i })), trap: sb.canTrap(room, room.turn) } : null),
      phase: room.phase || null,
      dice: room.dice || 0,
      legal: room.legal || [],
      legalBy: room.legalBy || {},
      pend: room.pend || [],
      rollsLeft: room.rollsLeft || 0,
      reason: room.endReason || null,
      startIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : null,
      players: room.players.map((q, qi) => ({ name: q.name, color: q.color, look: looks[qi], pos: q.pos, tokens: q.tokens || null, hp: q.hp == null ? null : q.hp, cls: q.cls == null ? null : q.cls, pick: q.pick == null ? null : q.pick, traps: qi === i ? (q.traps || []) : [], seat: q.seat == null ? null : q.seat, online: !!q.ws || !!q.bot })),
    });
  });
  if (room.state === 'done' && !room.rewarded) settleRoom(room);
}

function broadcast(room, msg) {
  room.players.forEach(p => send(p.ws, msg));
}

function pickColor(room) {
  const used = new Set(room.players.map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[0];
}

function cleanName(n) {
  n = String(n || '').trim().slice(0, 14);
  return n || 'لاعب';
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) { player.ws.room = null; player.ws.player = null; try { player.ws.close(); } catch (e) {} }
  player.ws = ws;
  clearTimeout(player.dcTimer); player.dcTimer = null;
  ws.room = room;
  ws.player = player;
  room.emptySince = null;
}

// إخراج لاعب نهائياً من لعبة جارية (انسحاب أو انقطاع طويل)
function removePlayerInGame(room, player, why) {
  const idx = room.players.indexOf(player);
  if (idx < 0) return;
  if (room.game === 'mafia' && room.state === 'play') {      // المافيا: يبقى مكانه (ميت) حتى ما تتغير الأرقام
    clearTimeout(player.dcTimer); player.dcTimer = null;
    if (player.ws) { player.ws.room = null; player.ws.player = null; player.ws = null; }
    mafia.leave(room, player, why);
    return;
  }
  if (room.game === 'mheibes' && room.state === 'play') {    // المحيبس: يبقى مكانه حتى ما تتغير الفرق
    clearTimeout(player.dcTimer); player.dcTimer = null;
    if (player.ws) { player.ws.room = null; player.ws.player = null; player.ws = null; }
    mheibes.leave(room, player, why);
    return;
  }
  clearTimeout(player.dcTimer); player.dcTimer = null;
  const wasPlaying = room.state === 'play';
  const wasTurn = wasPlaying && room.turn === idx;
  if (player.ws) { player.ws.room = null; player.ws.player = null; player.ws = null; }
  room.players.splice(idx, 1);
  if (room.players.length === 0 || room.players.every(p => p.bot)) {
    clearTimeout(room.timer); clearTimeout(room.startTimer); rooms.delete(room.code); return;
  }
  if (wasPlaying) broadcast(room, { t: 'sys', text: (why === 'dc' ? '🚪 ' + player.name + ' انقطع اتصاله وخرج من اللعبة' : '🚪 ' + player.name + ' انسحب من اللعبة') });
  if (idx < room.turn) room.turn--;
  if (room.turn >= room.players.length) room.turn = 0;
  if (idx < room.host) room.host--; else if (idx === room.host) room.host = 0;
  if (room.winner > idx) room.winner--; else if (room.winner === idx) room.winner = -1;
  if (wasPlaying) {
    const humans = room.players.filter(p => !p.bot);
    if (room.players.length < 2 || humans.length < 1) {
      room.state = 'done';
      room.winner = humans.length ? room.players.indexOf(humans[0]) : 0;
      room.endReason = 'left';
      clearTimeout(room.timer);
    } else if (wasTurn) {
      room.turn = (room.turn + room.players.length - 1) % room.players.length;
      nextTurn(room);
    }
  }
  sendRoom(room);
}

function detach(ws) {
  const room = ws.room, player = ws.player;
  ws.room = null; ws.player = null;
  if (!room || !player) return;
  player.ws = null;
  if (room.state === 'lobby') {
    room.players = room.players.filter(p => p !== player);
  }
  if (!room.players.some(p => p.ws)) {
    room.emptySince = Date.now();
    clearTimeout(room.timer);
  }
  if (room.players.length === 0) { clearTimeout(room.startTimer); rooms.delete(room.code); return; }
  if (room.state === 'lobby') {
    if (!room.players[room.host] || !room.players[room.host].ws) {
      const i = room.players.findIndex(p => p.ws);
      room.host = i >= 0 ? i : 0;
    }
  } else if (room.state === 'play') {
    if (!room.solo) {
      broadcast(room, { t: 'sys', text: '⚠️ ' + player.name + ' انقطع اتصاله، ننتظره ' + Math.round(DC_GRACE / 1000) + ' ثانية' });
      clearTimeout(player.dcTimer);
      player.dcTimer = setTimeout(() => {
        if (!player.ws && rooms.has(room.code) && room.players.includes(player)) removePlayerInGame(room, player, 'dc');
      }, DC_GRACE);
    }
    if (room.game !== 'mafia' && room.game !== 'mheibes' && room.players[room.turn] === player) nextTurn(room);
  }
  if (room.state === 'lobby') checkAutoStart(room);
  sendRoom(room);
}

const validCls = v => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : null);
function initGame(room) {
  room.rewarded = false; room.startedAt = Date.now();   // لحساب جوائز نهاية اللعبة
  if (room.game === 'ludo') ludo.init(room);
  else if (room.game === 'mafia') mafia.init(room);
  else if (room.game === 'mheibes') mheibes.init(room);
  else if (room.mode === 'battle') sb.init(room);
  else room.players.forEach(p => (p.pos = 0));
}
function startGame(room) {
  if (!rooms.has(room.code) || room.state !== 'lobby' || room.players.length < minPlayers(room)) return;
  clearTimeout(room.startTimer); room.startTimer = null; room.startAt = null;
  room.endReason = null;
  room.state = 'play';
  room.turn = 0;
  room.winner = -1;
  initGame(room);
  armTimer(room);
  sendRoom(room);
}
function scheduleStart(room, ms) {
  clearTimeout(room.startTimer);
  room.startAt = Date.now() + ms;
  room.startTimer = setTimeout(() => { room.startTimer = null; startGame(room); }, ms);
}
// غرف اللعب العشوائي تبدأ تلقائياً: 8 ثواني بعد وصول لاعبين، أو فوراً تقريباً إذا امتلأت
function checkAutoStart(room) {
  if (!room.pub || room.state !== 'lobby') return;
  const n = room.players.length;
  if (n < minPlayers(room)) { clearTimeout(room.startTimer); room.startTimer = null; room.startAt = null; return; }
  if (n >= room.max) { if (!room.startAt || room.startAt - Date.now() > 1500) scheduleStart(room, 1500); }
  else if (!room.startTimer) scheduleStart(room, room.game === 'mafia' ? 15000 : 8000);
}

function armTimer(room) {
  if (room.game === 'mafia' || room.game === 'mheibes') return;   // المافيا والمحيبس لها مؤقتاتها الخاصة (mafia.js)
  clearTimeout(room.timer);
  if (room.state !== 'play') return;
  const cur = room.players[room.turn];
  const botDelay = room.game === 'ludo' && room.phase === 'move' ? Math.round(BOT_MS * 0.7) : BOT_MS;
  room.timer = setTimeout(() => autoAct(room), cur && cur.bot ? botDelay : (room.mode === 'battle' ? 20000 : TURN_MS));
}
// حركة تلقائية: للجهاز، أو للاعب تأخّر عن وقته
function autoAct(room) {
  if (room.state !== 'play') return;
  if (room.game === 'ludo') {
    if (room.mode === 'battle') {                    // قدرات المعركة أولاً: فخ ثم قنص
      if (ludo.canTrap(room, room.turn)) { ludoTrap(room); return; }
      const tg = ludo.snipeTargets(room, room.turn);
      if (tg.length) { ludoShoot(room, tg[0].i, tg[0].tok); return; }
      if (room.phase === 'act') { nextTurn(room); sendRoom(room); return; }
    }
    if (room.legal && room.legal.length) {          // فيه حركة متاحة: العب أولاً
      const c = ludo.chooseBot(room, room.turn);
      if (c) ludoMove(room, c.tok, c.val); else { nextTurn(room); sendRoom(room); }
    } else if (room.rollsLeft > 0) ludoRoll(room);
    else { nextTurn(room); sendRoom(room); }
  } else if (room.mode === 'battle' && room.phase === 'act') sbAuto(room);
  else doRoll(room);
}

function nextTurn(room) {
  room.phase = 'roll'; room.sixes = 0; room.extra = false; room.legal = [];
  room.legalBy = {}; room.pend = []; room.rollsLeft = 1;
  if (!room.players.some(p => p.ws)) { clearTimeout(room.timer); return; }
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (room.turn + k) % n;
    if (room.players[j].ws || room.players[j].bot) { room.turn = j; if (room.mode === 'battle') (room.game === 'ludo' ? ludo : sb).resetTurn(room); armTimer(room); return; }
  }
  clearTimeout(room.timer);
}

// ---- لودو: الرميات المخزّنة ----
// عند رمي 6 ياخذ اللاعب رمية إضافية فوراً، ويكدر يلعب السته أو يرمي مرة ثانية (والستات تتخزّن).
// ثلاث ستات متتالية = يضيع الدور. الأكل والوصول للبيت يعطيان رمية إضافية أيضاً.
function ludoNoMoves(room) { return room.rollsLeft === 0 && !room.legal.length; }
// المعركة: إذا خلص الدور وعند اللاعب قدرة متاحة (قنص/فخ) ننتظره بدل ما ننهي الدور مباشرة
function ludoHasActs(room) {
  return room.mode === 'battle' && (ludo.canTrap(room, room.turn) || ludo.snipeTargets(room, room.turn).length > 0);
}
function ludoFinishTurn(room) {
  if (ludoHasActs(room)) { room.phase = 'act'; armTimer(room); sendRoom(room); return; }
  nextTurn(room); sendRoom(room);
}
function ludoAfterAction(room) {
  if (room.phase === 'act' && !ludoHasActs(room)) { nextTurn(room); sendRoom(room); return; }
  armTimer(room); sendRoom(room);
}
function ludoShoot(room, qi, qt) {
  if (room.state !== 'play' || room.game !== 'ludo' || room.mode !== 'battle') return;
  const r = ludo.doSnipe(room, room.turn, qi, qt);
  if (!r) return;
  broadcast(room, { t: 'lshot', i: room.turn, target: r.hit, captured: r.captured });
  ludoAfterAction(room);
}
function ludoTrap(room) {
  if (room.state !== 'play' || room.game !== 'ludo' || room.mode !== 'battle') return;
  if (!ludo.placeTrap(room, room.turn)) return;
  broadcast(room, { t: 'ltrapset', i: room.turn });
  ludoAfterAction(room);
}
function ludoAdvance(room) {
  const p = room.players[room.turn];
  if (room.rollsLeft === 0) {
    // لا رميات متبقية: إذا ما بقى إلا خيار واحد يُنفَّذ تلقائياً
    const pairs = [];
    for (const v in room.legalBy) room.legalBy[v].forEach(t => pairs.push([t, +v]));
    if (pairs.length === 1) { ludoMove(room, pairs[0][0], pairs[0][1]); return; }
  }
  room.phase = room.legal.length ? 'move' : 'roll';
  armTimer(room); sendRoom(room);
}
function ludoRoll(room) {
  if (room.state !== 'play' || room.game !== 'ludo' || !(room.rollsLeft > 0)) return;
  const i = room.turn, p = room.players[i];
  if (!p) return;
  const dice = 1 + Math.floor(Math.random() * 6);
  room.dice = dice;
  room.rollsLeft--;
  room.sixes = dice === 6 ? room.sixes + 1 : 0;
  if (room.sixes >= 3) {                       // ثلاث ستات متتالية: يضيع الدور
    room.pend = []; room.rollsLeft = 0;
    broadcast(room, { t: 'lroll', i, dice, legal: [], pass: true, why: 'six3' });
    nextTurn(room); sendRoom(room); return;
  }
  room.pend.push(dice);
  if (dice === 6) room.rollsLeft++;            // السته = رمية إضافية
  ludo.refreshLegal(room, p);
  const pass = ludoNoMoves(room);
  broadcast(room, { t: 'lroll', i, dice, legal: ludo.legalMoves(p, dice), pass, why: pass ? 'none' : null });
  if (pass) { ludoFinishTurn(room); return; }
  ludoAdvance(room);
}
function ludoMove(room, ti, val) {
  if (room.state !== 'play' || room.game !== 'ludo') return;
  const i = room.turn, p = room.players[i];
  if (!p || !room.legal || !room.legal.length) return;
  if (val == null || isNaN(val)) {
    val = room.pend.find(v => (room.legalBy[v] || []).includes(ti));
  }
  if (!room.pend.includes(val) || !(room.legalBy[val] || []).includes(ti)) return;
  room.pend.splice(room.pend.indexOf(val), 1);
  const battle = room.mode === 'battle';
  const r = battle ? ludo.applyMoveBattle(room, i, ti, val) : ludo.applyMove(room, i, ti, val);
  if (battle && !room.ts.moved.includes(ti)) room.ts.moved.push(ti);
  broadcast(room, { t: 'lmove', i, tok: ti, dice: val, from: r.from, to: r.to, captured: r.captured, hits: battle ? r.hits : undefined, trap: battle ? r.trap : undefined });
  if (ludo.hasWon(room, p)) {
    room.state = 'done'; room.winner = i; room.legal = []; room.legalBy = {}; room.pend = [];
    clearTimeout(room.timer); sendRoom(room); return;
  }
  if (battle) {
    if (r.rushKill && !room.ts.rush) { room.ts.rush = true; room.rollsLeft++; }   // المندفع: رمية إضافية بعد القتل (مرة بالدور)
    if (r.to === ludo.FINISH) room.rollsLeft++;
  } else if (r.captured.length > 0 || r.to === ludo.FINISH) room.rollsLeft++;     // رمية إضافية
  ludo.refreshLegal(room, p);
  if (ludoNoMoves(room)) { ludoFinishTurn(room); return; }
  ludoAdvance(room);
}

// ===== وضع المعركة لحية ودرج =====
function sbRoll(room) {
  const i = room.turn, dice = 1 + Math.floor(Math.random() * 6);
  const r = sb.move(room, i, dice, SNAKES, LADDERS);
  const extra = !!r.rush && r.to !== 100;       // السته ما تعطي رمية إضافية؛ فقط قتل المندفع
  broadcast(room, { t: 'move', i, dice, from: r.from, land: r.land, to: r.to, hits: r.hits, trap: r.trap, extra });
  if (r.to === 100) {
    room.state = 'done'; room.winner = i; room.endReason = 'win';
    clearTimeout(room.timer); sendRoom(room); return;
  }
  room.extra = extra;                           // قتل المندفع = رمية إضافية
  if (sb.hasActs(room, i)) { room.phase = 'act'; armTimer(room); } else sbEnd(room);
  sendRoom(room);
}
function sbEnd(room) {
  if (room.extra) { room.extra = false; room.phase = 'roll'; armTimer(room); }
  else nextTurn(room);
}
function sbAfterAct(room) {
  if (sb.hasActs(room, room.turn)) armTimer(room); else sbEnd(room);
  sendRoom(room);
}
function sbShoot(room, qi) {
  if (room.state !== 'play' || room.mode !== 'battle' || room.phase !== 'act') return;
  const h = sb.snipe(room, room.turn, qi);
  if (!h) return;
  broadcast(room, { t: 'sbhit', i: room.turn, hit: h });
  sbAfterAct(room);
}
function sbTrap(room) {
  if (room.state !== 'play' || room.mode !== 'battle' || room.phase !== 'act') return;
  if (!sb.placeTrap(room, room.turn)) return;
  broadcast(room, { t: 'ltrapset', i: room.turn });
  sbAfterAct(room);
}
function sbAuto(room) {
  if (sb.canTrap(room, room.turn)) return sbTrap(room);
  const tg = sb.snipeTargets(room, room.turn);
  if (tg.length) return sbShoot(room, tg[0].i);
  sbEnd(room); sendRoom(room);
}

function doRoll(room) {
  if (room.state !== 'play') return;
  const i = room.turn;
  const p = room.players[i];
  if (!p) return;
  if (room.mode === 'battle') { if (room.phase !== 'act') sbRoll(room); return; }
  const dice = 1 + Math.floor(Math.random() * 6);
  const from = p.pos;
  let land = from + dice;
  let to = land;
  if (land > 100) { land = from; to = from; }
  else if (SNAKES[land]) to = SNAKES[land];
  else if (LADDERS[land]) to = LADDERS[land];
  p.pos = to;
  broadcast(room, { t: 'move', i, dice, from, land, to });
  if (to === 100) {
    room.state = 'done';
    room.winner = i;
    room.endReason = 'win';
    clearTimeout(room.timer);
  } else {
    nextTurn(room);
  }
  sendRoom(room);
}

if (mheibes) mheibes.setApi({
  sendRoom, broadcast, send,
  destroy: room => { clearTimeout(room.timer); clearTimeout(room.startTimer); rooms.delete(room.code); },
});
if (mafia) mafia.setApi({
  sendRoom, broadcast, send,
  destroy: room => { clearTimeout(room.timer); clearTimeout(room.startTimer); rooms.delete(room.code); },
});

wss.on('connection', (ws, req) => {
  ws.room = null; ws.player = null; ws.user = null; ws.lastChat = 0;
  const ip = ws.ip = ipOf(req);
  const nConn = (ipConns.get(ip) || 0) + 1;
  if (nConn > MAX_CONN_PER_IP) { ws.close(1013, 'too many connections'); return; }
  ipConns.set(ip, nConn);
  ws.on('close', () => { const n = (ipConns.get(ip) || 1) - 1; if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n); });
  let rlT = Date.now(), rlN = 0;
  ws.on('message', raw => {
    const nw = Date.now();
    if (nw - rlT >= 1000) { rlT = nw; rlN = 0; }
    if (++rlN > MSG_PER_SEC) { if (rlN > MSG_PER_SEC * 5) ws.terminate(); return; }
    try { onMsg(raw); } catch (e) { console.error('message handler error:', e); }
  });
  const onMsg = raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const token = typeof m.token === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(m.token) ? m.token : null;
    if (handleSocial(ws, m, token)) return;

    if (m.t === 'create') {
      if (!token) return;
      if (ws.room) detach(ws);
      const game = m.game === 'ludo' && ludo ? 'ludo' : (m.game === 'mafia' && mafia ? 'mafia' : (m.game === 'mheibes' && mheibes ? 'mheibes' : 'snakes'));
      const max = game === 'ludo' ? 4 : (game === 'mafia' ? mafia.MAX : (game === 'mheibes' ? mheibes.MAX : (m.max === 6 ? 6 : 4)));
      const mode = (game === 'ludo' && (m.mode === 'quick' || m.mode === 'battle')) || (game === 'snakes' && m.mode === 'battle') ? m.mode : 'classic';
      const room = { code: makeCode(), max, game, mode, players: [], state: 'lobby', host: 0, turn: 0, winner: -1, timer: null, emptySince: null };
      const player = { token, name: ws.user ? ws.user.name : cleanName(m.name), color: COLORS[0], pos: 0, ws: null, pick: validCls(m.cls) };
      room.players.push(player);
      rooms.set(room.code, room);
      let nb = Math.max(0, Math.min(max - 1, parseInt(m.bots) || 0));
      if ((game === 'mafia' || game === 'mheibes') && nb > 0 && nb < minPlayers(room) - 1) nb = minPlayers(room) - 1;
      const botNames = game === 'mafia' || game === 'mheibes' ? MAFIA_BOT_NAMES.slice().sort(() => Math.random() - 0.5) : null;
      if (nb > 0) {
        room.solo = true;
        for (let k = 0; k < nb; k++) {
          room.players.push({ token: 'bot' + k, name: botNames ? '🤖 ' + botNames[k % botNames.length] : '🤖 الجهاز' + (nb > 1 ? ' ' + (k + 1) : ''), color: pickColor(room), pos: 0, ws: null, bot: true });
        }
        room.state = 'play';
        initGame(room);
        armTimer(room);
      }
      attach(ws, room, player);
      if (room.game === 'mheibes' && room.state === 'play') mheibes.resume(room);
      if (room.game === 'mafia' && room.state === 'play') mafia.resume(room);   // الآن صار اللاعب متصل: شغّل المؤقتات والأجهزة
      sendRoom(room);
    } else if (m.t === 'join') {
      if (!token) return;
      if (joinBlocked(ws.ip)) return send(ws, { t: 'err', msg: 'محاولات كثيرة، انتظر دقيقة وجرّب', fatal: true });
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { joinFailed(ws.ip); return send(ws, { t: 'err', msg: 'الغرفة غير موجودة', fatal: true }); }
      if (ws.room && ws.room !== room) detach(ws);
      let player = room.players.find(p => p.token === token);
      if (player && player.left) return send(ws, { t: 'err', msg: 'انسحبت من هذه اللعبة', fatal: true });
      if (player) {
        const wasOff = !player.ws;
        attach(ws, room, player);
        if (room.state === 'play') {
          if (wasOff && !room.solo) broadcast(room, { t: 'sys', text: '✅ ' + player.name + ' رجع للعبة' });
          if (room.game === 'mafia') mafia.resume(room);
          else if (room.game === 'mheibes') mheibes.resume(room);
          else {
            const cur = room.players[room.turn];
            if (!cur || (!cur.ws && !cur.bot)) nextTurn(room); else armTimer(room);
          }
        }
      } else {
        if (room.state !== 'lobby') return send(ws, { t: 'err', msg: 'اللعبة بدأت بالفعل أو خرجت منها', fatal: true });
        if (room.players.length >= room.max) return send(ws, { t: 'err', msg: 'الغرفة ممتلئة', fatal: true });
        player = { token, name: ws.user ? ws.user.name : cleanName(m.name), color: pickColor(room), pos: 0, ws: null };
        room.players.push(player);
        attach(ws, room, player);
      }
      checkAutoStart(room);
      sendRoom(room);
    } else if (m.t === 'random') {
      if (!token || !ws.user) return;
      if (ws.room) detach(ws);
      const rgame = m.game === 'ludo' && ludo ? 'ludo' : (m.game === 'mafia' && mafia ? 'mafia' : (m.game === 'mheibes' && mheibes ? 'mheibes' : 'snakes'));
      const rmode = (rgame === 'ludo' && (m.mode === 'quick' || m.mode === 'battle')) || (rgame === 'snakes' && m.mode === 'battle') ? m.mode : 'classic';
      let room = null;
      for (const r of rooms.values()) {
        if (r.pub && (r.game || 'snakes') === rgame && (r.mode || 'classic') === rmode && r.state === 'lobby' && r.players.length < r.max && !r.players.some(p => p.token === token)) { room = r; break; }
      }
      if (!room) {
        room = { code: makeCode(), max: rgame === 'mafia' ? mafia.MAX : rgame === 'mheibes' ? mheibes.MAX : 4, game: rgame, mode: rmode, pub: true, players: [], state: 'lobby', host: 0, turn: 0, winner: -1, timer: null, emptySince: null };
        rooms.set(room.code, room);
      }
      const player = { token, name: ws.user.name, color: pickColor(room), pos: 0, ws: null, pick: validCls(m.cls) };
      room.players.push(player);
      attach(ws, room, player);
      checkAutoStart(room);
      sendRoom(room);
    } else if (m.t === 'leave') {
      const room = ws.room, player = ws.player;
      if (room && room.solo) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
        ws.room = null; ws.player = null;
        return;
      }
      if (room && player && room.state !== 'lobby') {
        ws.room = null; ws.player = null; player.ws = null;
        removePlayerInGame(room, player, 'leave');
      } else {
        detach(ws);
      }
    } else if (m.t === 'start') {
      const room = ws.room;
      if (!room || room.state !== 'lobby' || room.players[room.host] !== ws.player) return;
      if (room.players.length < minPlayers(room)) return send(ws, { t: 'err', msg: room.game === 'mafia' ? 'المافيا تحتاج ' + mafia.MIN + ' لاعبين على الأقل' : room.game === 'mheibes' ? 'المحيبس يحتاج ' + mheibes.MIN + ' لاعبين على الأقل' : 'تحتاج لاعبين اثنين على الأقل' });
      startGame(room);
    } else if (m.t === 'pick') {
      const room = ws.room;
      if (!room || room.state !== 'lobby' || room.game === 'ludo' || room.game === 'mafia' || room.game === 'mheibes' || room.mode !== 'battle' || !room.players.includes(ws.player)) return;
      ws.player.pick = validCls(m.cls); sendRoom(room);
    } else if (m.t === 'sshoot') {
      const room = ws.room;
      if (!room || room.game === 'ludo' || room.players[room.turn] !== ws.player) return;
      sbShoot(room, parseInt(m.i));
    } else if (m.t === 'strap') {
      const room = ws.room;
      if (!room || room.game === 'ludo' || room.players[room.turn] !== ws.player) return;
      sbTrap(room);
    } else if (m.t === 'send') {
      const room = ws.room;
      if (!room || room.state !== 'play' || room.mode !== 'battle' || room.game === 'ludo' || room.phase !== 'act' || room.players[room.turn] !== ws.player) return;
      sbEnd(room); sendRoom(room);
    } else if (m.t === 'lroll') {
      const room = ws.room;
      if (!room || room.game !== 'ludo' || room.players[room.turn] !== ws.player) return;
      ludoRoll(room);
    } else if (m.t === 'lshoot') {
      const room = ws.room;
      if (!room || room.players[room.turn] !== ws.player) return;
      ludoShoot(room, parseInt(m.i), parseInt(m.tok));
    } else if (m.t === 'ltrap') {
      const room = ws.room;
      if (!room || room.players[room.turn] !== ws.player) return;
      ludoTrap(room);
    } else if (m.t === 'lend') {
      const room = ws.room;
      if (!room || room.state !== 'play' || room.mode !== 'battle' || room.phase !== 'act' || room.players[room.turn] !== ws.player) return;
      nextTurn(room); sendRoom(room);
    } else if (m.t === 'lmove') {
      const room = ws.room;
      if (!room || room.game !== 'ludo' || room.players[room.turn] !== ws.player) return;
      ludoMove(room, parseInt(m.tok), m.val == null ? undefined : parseInt(m.val));
    } else if (m.t === 'mact' || m.t === 'mvote' || m.t === 'mready') {
      const room = ws.room;
      if (!room || room.game !== 'mafia' || room.state !== 'play' || !ws.player) return;
      mafia.handle(room, ws.player, m);
    } else if (m.t === 'hhide' || m.t === 'hout' || m.t === 'hbat' || m.t === 'hfx' || m.t === 'hsug') {
      const room = ws.room;
      if (!room || room.game !== 'mheibes' || room.state !== 'play' || !ws.player) return;
      mheibes.handle(room, ws.player, m);
    } else if (m.t === 'roll') {
      const room = ws.room;
      if (!room || room.state !== 'play' || (room.game || 'snakes') !== 'snakes' || room.players[room.turn] !== ws.player) return;
      doRoll(room);
    } else if (m.t === 'again') {
      const room = ws.room;
      if (!room || room.state !== 'done' || !room.players.includes(ws.player)) return;
      room.endReason = null;
      if (room.game === 'mafia') mafia.reset(room);
      if (room.game === 'mheibes') mheibes.reset(room);
      if (room.solo) {
        room.state = 'play'; room.turn = 0; room.winner = -1;
        initGame(room);
        armTimer(room);
        sendRoom(room);
        return;
      }
      room.state = 'lobby';
      room.winner = -1;
      room.players = room.players.filter(p => p.ws);
      room.players.forEach(p => (p.pos = 0));
      room.host = 0;
      checkAutoStart(room);
      sendRoom(room);
    } else if (m.t === 'chat') {
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - ws.lastChat < 400) return;
      ws.lastChat = now;
      const i = room.players.indexOf(ws.player);
      let payload;
      if (m.phrase != null) {
        if (room.game !== 'mheibes' || !mheibes.PHRASES.includes(m.phrase)) return;
        payload = { t: 'chat', i, text: m.phrase, emoji: true, phrase: true };
      } else if (m.emoji) {
        if (!EMOJIS.includes(m.emoji)) return;
        payload = { t: 'chat', i, text: m.emoji, emoji: true };
      } else {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) return;
        payload = { t: 'chat', i, text, emoji: false };
      }
      if (room.game === 'mafia' && room.state === 'play') {
        const r = mafia.chatRoute(room, ws.player);
        if (!r) return;                               // بالليل غير المافيا ما يحجون
        payload.scope = r.scope;
        r.to.forEach(q => send(q.ws, payload));
      } else broadcast(room, payload);
    }
  };
  ws.on('close', () => { detach(ws); goOffline(ws); });
  ws.on('error', () => {});
});

// تنظيف الغرف الفارغة
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 10 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

loadData().then(() => server.listen(PORT, () => console.log('Ka\'da Play server on port ' + PORT)));
