// سيرفر لعبة الحية والدرج - Node.js + ws
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const SNAKES = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };
const LADDERS = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };
const COLORS = ['#ff4d6d', '#2ec4b6', '#ffb703', '#4895ef', '#b388ff', '#ff8fab'];
const EMOJIS = ['😂', '😡', '👏', '😭', '🔥', '👍', '😎', '🙈'];
const TURN_MS = 25000;

const rooms = new Map();

// ---------- الحسابات والأصدقاء ----------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const users = {};            // token -> { id, name, friends:[id], requests:[id] }
const byId = new Map();      // id -> user
const online = new Map();    // id -> Set(ws)

try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  Object.assign(users, d.users || {});
} catch (e) {}
for (const t in users) byId.set(users[t].id, users[t]);

let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ users }), err => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
  }, 800);
}
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
    notifyFriends(u);
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
    socks.forEach(w => send(w, { t: 'invite', code: room.code, max: room.max, from: { id: u.id, name: u.name } }));
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendRoom(room) {
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
      players: room.players.map(q => ({ name: q.name, color: q.color, pos: q.pos, online: !!q.ws || !!q.bot })),
    });
  });
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
  ws.room = room;
  ws.player = player;
  room.emptySince = null;
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
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  if (room.state === 'lobby') {
    if (!room.players[room.host] || !room.players[room.host].ws) {
      const i = room.players.findIndex(p => p.ws);
      room.host = i >= 0 ? i : 0;
    }
  } else if (room.state === 'play' && room.players[room.turn] === player) {
    nextTurn(room);
  }
  sendRoom(room);
}

function armTimer(room) {
  clearTimeout(room.timer);
  if (room.state !== 'play') return;
  const cur = room.players[room.turn];
  room.timer = setTimeout(() => doRoll(room), cur && cur.bot ? 1400 : TURN_MS);
}

function nextTurn(room) {
  if (!room.players.some(p => p.ws)) { clearTimeout(room.timer); return; }
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (room.turn + k) % n;
    if (room.players[j].ws || room.players[j].bot) { room.turn = j; armTimer(room); return; }
  }
  clearTimeout(room.timer);
}

function doRoll(room) {
  if (room.state !== 'play') return;
  const i = room.turn;
  const p = room.players[i];
  if (!p) return;
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
    clearTimeout(room.timer);
  } else if (dice === 6) {
    armTimer(room); // رمية إضافية
  } else {
    nextTurn(room);
  }
  sendRoom(room);
}

wss.on('connection', ws => {
  ws.room = null; ws.player = null; ws.user = null; ws.lastChat = 0;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const token = typeof m.token === 'string' && m.token.length >= 8 && m.token.length <= 64 ? m.token : null;
    if (handleSocial(ws, m, token)) return;

    if (m.t === 'create') {
      if (!token) return;
      if (ws.room) detach(ws);
      const max = m.max === 6 ? 6 : 4;
      const room = { code: makeCode(), max, players: [], state: 'lobby', host: 0, turn: 0, winner: -1, timer: null, emptySince: null };
      const player = { token, name: ws.user ? ws.user.name : cleanName(m.name), color: COLORS[0], pos: 0, ws: null };
      room.players.push(player);
      rooms.set(room.code, room);
      const nb = Math.max(0, Math.min(max - 1, parseInt(m.bots) || 0));
      if (nb > 0) {
        room.solo = true;
        for (let k = 0; k < nb; k++) {
          room.players.push({ token: 'bot' + k, name: '🤖 الجهاز' + (nb > 1 ? ' ' + (k + 1) : ''), color: pickColor(room), pos: 0, ws: null, bot: true });
        }
        room.state = 'play';
        armTimer(room);
      }
      attach(ws, room, player);
      sendRoom(room);
    } else if (m.t === 'join') {
      if (!token) return;
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: 'الغرفة غير موجودة', fatal: true });
      if (ws.room && ws.room !== room) detach(ws);
      let player = room.players.find(p => p.token === token);
      if (player) {
        attach(ws, room, player);
      } else {
        if (room.state !== 'lobby') return send(ws, { t: 'err', msg: 'اللعبة بدأت بالفعل', fatal: true });
        if (room.players.length >= room.max) return send(ws, { t: 'err', msg: 'الغرفة ممتلئة', fatal: true });
        player = { token, name: ws.user ? ws.user.name : cleanName(m.name), color: pickColor(room), pos: 0, ws: null };
        room.players.push(player);
        attach(ws, room, player);
      }
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
        // بعد بدء اللعبة: نحذف اللاعب نهائياً لتجنب بقاء مقعد فارغ
        const wasTurn = room.players[room.turn] === player;
        const idx = room.players.indexOf(player);
        player.ws = null; ws.room = null; ws.player = null;
        room.players.splice(idx, 1);
        if (room.players.length === 0) { rooms.delete(room.code); clearTimeout(room.timer); return; }
        if (idx < room.turn) room.turn--;
        if (room.turn >= room.players.length) room.turn = 0;
        if (room.winner > idx) room.winner--;
        else if (room.winner === idx) room.winner = -1;
        if (room.host >= room.players.length) room.host = 0;
        if (room.state === 'play') {
          if (room.players.length < 2) { room.state = 'done'; room.winner = 0; clearTimeout(room.timer); }
          else if (wasTurn) { room.turn = (room.turn + room.players.length - 1) % room.players.length; nextTurn(room); }
        }
        sendRoom(room);
      } else {
        detach(ws);
      }
    } else if (m.t === 'start') {
      const room = ws.room;
      if (!room || room.state !== 'lobby' || room.players[room.host] !== ws.player) return;
      if (room.players.length < 2) return send(ws, { t: 'err', msg: 'تحتاج لاعبين اثنين على الأقل' });
      room.state = 'play';
      room.turn = 0;
      room.winner = -1;
      room.players.forEach(p => (p.pos = 0));
      armTimer(room);
      sendRoom(room);
    } else if (m.t === 'roll') {
      const room = ws.room;
      if (!room || room.state !== 'play' || room.players[room.turn] !== ws.player) return;
      doRoll(room);
    } else if (m.t === 'again') {
      const room = ws.room;
      if (!room || room.state !== 'done' || room.players[room.host] !== ws.player) return;
      if (room.solo) {
        room.players.forEach(p => (p.pos = 0));
        room.state = 'play'; room.turn = 0; room.winner = -1;
        armTimer(room);
        sendRoom(room);
        return;
      }
      room.state = 'lobby';
      room.winner = -1;
      room.players = room.players.filter(p => p.ws);
      room.players.forEach(p => (p.pos = 0));
      room.host = 0;
      sendRoom(room);
    } else if (m.t === 'chat') {
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - ws.lastChat < 400) return;
      ws.lastChat = now;
      const i = room.players.indexOf(ws.player);
      if (m.emoji) {
        if (!EMOJIS.includes(m.emoji)) return;
        broadcast(room, { t: 'chat', i, text: m.emoji, emoji: true });
      } else {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) return;
        broadcast(room, { t: 'chat', i, text, emoji: false });
      }
    }
  });
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

server.listen(PORT, () => console.log('Snakes & Ladders server on port ' + PORT));
