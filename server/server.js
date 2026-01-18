const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('WonRemote signaling server is running. Use /api/list or /socket.io');
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// ====== Google Sheet (LIST) ======
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1K0RHJpPcqMRWUNvTikrQn5quFCqrSqc-XLhTga6fP-c';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'LIST';

const creds = require('./service_account.json');
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

const CACHE_TTL_MS = 5 * 60 * 1000;

let listCache = {
  loadedAt: 0,
  list: [],
  byId: new Map()
};

function norm(v) {
  return String(v ?? '').trim();
}

function normBiz(v) {
  return norm(v).replace(/[^0-9]/g, '');
}

function buildPassword(biz) {
  const n = normBiz(biz);
  return n.slice(-5);
}

function rowToListItem(row) {
  const raw = Array.isArray(row?._rawData) ? row._rawData : [];
  const obj = typeof row?.toObject === 'function' ? row.toObject() : {};

  const get = (idx, key) => norm(obj?.[key]) || norm(raw[idx]);

  const groupName = get(0, '그룹');
  const desktopName = get(1, 'DESKTOP - NAME');
  const businessId = get(2, '사업자등록번호');
  const deviceName = get(3, '장비명');
  const allowRemoteRaw = get(4, '접속여부');
  const installedAt = get(5, '설치일');
  const os = get(6, 'OS');
  const memo = get(7, '메모');

  const allowRemote = allowRemoteRaw.toUpperCase() === 'YES' ? 'YES' : 'NO';

  return {
    id: desktopName,
    desktopName,
    businessId,
    deviceName,
    allowRemote,
    groupName,
    installedAt,
    os,
    memo
  };
}

async function loadListCached() {
  const now = Date.now();
  if (listCache.list.length && (now - listCache.loadedAt) < CACHE_TTL_MS) {
    return listCache;
  }

  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[SHEET_NAME];
  if (!sheet) throw new Error(`시트 탭 "${SHEET_NAME}" 을 찾지 못했습니다.`);

  const rows = await sheet.getRows();
  const list = [];
  const byId = new Map();

  for (const row of rows) {
    const item = rowToListItem(row);
    if (!item.id || !item.businessId) continue;
    list.push(item);
    byId.set(item.id, item);
  }

  listCache = { loadedAt: now, list, byId };
  return listCache;
}

app.get('/api/list', async (req, res) => {
  try {
    const cache = await loadListCached();
    res.json({ success: true, data: cache.list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 호환용: 기존 /api/customers 요청도 LIST로 응답
app.get('/api/customers', async (req, res) => {
  try {
    const cache = await loadListCached();
    res.json({ success: true, data: cache.list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth', async (req, res) => {
  try {
    const { id, password } = req.body || {};
    if (!id || !password) {
      return res.status(400).json({ success: false, error: 'id/password required' });
    }

    const cache = await loadListCached();
    const hit = cache.byId.get(norm(id));
    if (!hit) return res.status(401).json({ success: false, error: 'invalid' });

    const expected = buildPassword(hit.businessId);
    if (String(password) !== expected) {
      return res.status(401).json({ success: false, error: 'invalid' });
    }

    res.json({ success: true, data: hit });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

let onlineById = new Map();
let socketToId = new Map();
let lastSeenById = new Map();

async function emitDeviceList(target) {
  const cache = await loadListCached();
  const devices = cache.list.map((base) => {
    const online = onlineById.get(base.id);
    const lastSeen = online?.lastSeen || lastSeenById.get(base.id) || '';
    const status = base.allowRemote === 'NO' ? 'BLOCKED' : (online ? 'ONLINE' : 'OFFLINE');

    return {
      ...base,
      name: base.deviceName || base.desktopName || base.id,
      status,
      socketId: online?.socketId || '',
      ipAddress: online?.ipAddress,
      width: online?.width,
      height: online?.height,
      displays: online?.displays,
      activeDisplayId: online?.activeDisplayId,
      lastSeen
    };
  });

  if (target) target.emit('device_list_update', devices);
  else io.emit('device_list_update', devices);
}

async function canRemoteBySocket(targetSocketId) {
  const deviceId = socketToId.get(targetSocketId);
  if (!deviceId) return false;
  const cache = await loadListCached();
  const base = cache.byId.get(deviceId);
  return !!base && base.allowRemote === 'YES';
}

io.on('connection', (socket) => {
  console.log('접속됨:', socket.id);
  emitDeviceList(socket).catch((e) => console.error(e));

  socket.on('register_device', async (deviceInfo) => {
    const deviceId = norm(deviceInfo?.id);
    if (!deviceId) return;

    let cache;
    try {
      cache = await loadListCached();
    } catch (e) {
      console.error(e);
      return;
    }

    const hit = cache.byId.get(deviceId);
    if (!hit) {
      console.warn('등록 실패: LIST에 없는 ID', deviceId);
      return;
    }

    let realIp = socket.handshake.address || '';
    if (realIp.startsWith('::ffff:')) realIp = realIp.substr(7);

    const now = new Date().toLocaleTimeString();
    const next = {
      ...hit,
      socketId: socket.id,
      ipAddress: realIp,
      width: deviceInfo?.width,
      height: deviceInfo?.height,
      displays: deviceInfo?.displays,
      activeDisplayId: deviceInfo?.activeDisplayId,
      lastSeen: now
    };

    onlineById.set(deviceId, next);
    socketToId.set(socket.id, deviceId);
    lastSeenById.set(deviceId, now);

    emitDeviceList().catch((e) => console.error(e));
  });

  socket.on('update_device_display', (d) => {
    const deviceId = socketToId.get(socket.id);
    if (!deviceId) return;
    const current = onlineById.get(deviceId);
    if (!current) return;

    onlineById.set(deviceId, {
      ...current,
      width: d.width,
      height: d.height,
      displays: Array.isArray(d?.displays) ? d.displays : current.displays,
      activeDisplayId: (typeof d?.activeDisplayId === 'number') ? d.activeDisplayId : current.activeDisplayId
    });
    emitDeviceList().catch((e) => console.error(e));
  });

  socket.on('agent_displays', (d) => {
    const deviceId = socketToId.get(socket.id);
    if (!deviceId) return;
    const current = onlineById.get(deviceId);
    if (!current) return;

    const displays = Array.isArray(d?.displays) ? d.displays : [];
    const activeDisplayId = d?.activeDisplayId || null;

    onlineById.set(deviceId, { ...current, displays, activeDisplayId });
    emitDeviceList().catch((e) => console.error(e));
  });

  socket.on('request_connection', async (deviceId) => {
    const id = norm(deviceId);
    const cache = await loadListCached();
    const base = cache.byId.get(id);
    if (!base || base.allowRemote !== 'YES') return;
    const online = onlineById.get(id);
    if (!online?.socketId) return;
    io.to(online.socketId).emit('start_remote_session', { adminId: socket.id });
  });

  socket.on('offer', (data) => {
    if (!data?.targetSocketId) return;
    io.to(data.targetSocketId).emit('offer', { ...data, fromSocketId: socket.id });
  });
  socket.on('answer', (data) => {
    if (!data?.targetSocketId) return;
    io.to(data.targetSocketId).emit('answer', { ...data, fromSocketId: socket.id });
  });
  socket.on('ice_candidate', (data) => {
    if (!data?.targetSocketId) return;
    io.to(data.targetSocketId).emit('ice_candidate', { ...data, fromSocketId: socket.id });
  });

  socket.on('remote_control', async (data) => {
    if (!data?.targetSocketId) return;
    const canRemote = await canRemoteBySocket(data.targetSocketId);
    if (!canRemote) return;
    const payload = { ...data, fromSocketId: socket.id };
    io.to(data.targetSocketId).emit('remote_control', payload);
  });

  socket.on('set_input_lock', async (data) => {
    if (!data?.targetSocketId) return;
    const canRemote = await canRemoteBySocket(data.targetSocketId);
    if (!canRemote) return;
    io.to(data.targetSocketId).emit('set_input_lock', { enabled: !!data.enabled });
  });

  socket.on('file_transfer_chunk', async (data) => {
    if (!data?.targetSocketId) return;
    const canRemote = await canRemoteBySocket(data.targetSocketId);
    if (!canRemote) return;
    io.to(data.targetSocketId).emit('file_transfer_chunk', data);
  });

  socket.on('clipboard_set', async (data) => {
    if (!data?.targetSocketId) return;
    const canRemote = await canRemoteBySocket(data.targetSocketId);
    if (!canRemote) return;
    io.to(data.targetSocketId).emit('clipboard_set', { text: data.text, fromAdmin: socket.id });
  });

  socket.on('clipboard_get', async (data) => {
    if (!data?.targetSocketId) return;
    const canRemote = await canRemoteBySocket(data.targetSocketId);
    if (!canRemote) return;
    io.to(data.targetSocketId).emit('clipboard_get', { fromAdmin: socket.id });
  });

  socket.on('clipboard_text', (data) => {
    if (!data?.adminSocketId) return;
    io.to(data.adminSocketId).emit('clipboard_text', data);
  });

  socket.on('ping_device', (data) => {
    if (!data?.targetSocketId) return;
    io.to(data.targetSocketId).emit('ping_request', { t: data.t ?? Date.now(), fromAdmin: socket.id });
  });

  socket.on('pong_device', (data) => {
    if (!data?.adminSocketId) return;
    io.to(data.adminSocketId).emit('pong_device', data);
  });

  socket.on('disconnect', () => {
    console.log('끊김:', socket.id);
    const deviceId = socketToId.get(socket.id);
    if (deviceId) {
      const now = new Date().toLocaleTimeString();
      lastSeenById.set(deviceId, now);
      onlineById.delete(deviceId);
      socketToId.delete(socket.id);
    }
    emitDeviceList().catch((e) => console.error(e));
  });
});

server.listen(PORT, () => console.log(`✅ WonRemote server running on :${PORT}`));
