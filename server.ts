import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createViteServer } from 'vite';
import dgram from 'dgram';
import os from 'os';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';

const UDP_DISCOVERY_PORT = 50000;
const UDP_BROADCAST_ADDR = '255.255.255.255';

function ensurePwaPngIcons() {
  const publicDir = path.resolve(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  function createSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    function crc32(buf: Buffer): number {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) {
          c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
        }
      }
      return (c ^ 0xffffffff) >>> 0;
    }

    function makeChunk(type: string, data: Buffer): Buffer {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeBuf = Buffer.from(type, 'ascii');
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
      return Buffer.concat([len, typeBuf, data, crcBuf]);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rowSize = width * 3 + 1;
    const raw = Buffer.alloc(rowSize * height);
    const pad = Math.floor(width * 0.22);
    const innerPad = Math.floor(width * 0.30);

    for (let y = 0; y < height; y++) {
      const rowOffset = y * rowSize;
      raw[rowOffset] = 0;
      for (let x = 0; x < width; x++) {
        const pxOffset = rowOffset + 1 + x * 3;
        const inOuterBox = x >= pad && x < width - pad && y >= pad && y < height - pad;
        const inInnerBox = x >= innerPad && x < width - innerPad && y >= innerPad && y < height - innerPad;
        if (inOuterBox && !inInnerBox) {
          raw[pxOffset] = 34;
          raw[pxOffset + 1] = 211;
          raw[pxOffset + 2] = 238;
        } else if (inInnerBox && y < height / 2) {
          raw[pxOffset] = 16;
          raw[pxOffset + 1] = 185;
          raw[pxOffset + 2] = 129;
        } else {
          raw[pxOffset] = r;
          raw[pxOffset + 1] = g;
          raw[pxOffset + 2] = b;
        }
      }
    }

    const idat = zlib.deflateSync(raw);
    const iend = Buffer.alloc(0);

    return Buffer.concat([
      signature,
      makeChunk('IHDR', ihdr),
      makeChunk('IDAT', idat),
      makeChunk('IEND', iend),
    ]);
  }

  const icons = [
    { name: 'pwa-192x192.png', size: 192 },
    { name: 'pwa-512x512.png', size: 512 },
    { name: 'pwa-maskable-512x512.png', size: 512 },
    { name: 'apple-touch-icon.png', size: 180 },
  ];

  for (const icon of icons) {
    const filePath = path.join(publicDir, icon.name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, createSolidPng(icon.size, icon.size, 6, 14, 30));
    }
  }
}

ensurePwaPngIcons();

interface PeerNode {
  id: string;
  callsign: string;
  ipAddress: string;
  udpPort: number;
  pingMs: number;
  role: 'MASTER' | 'CLIENT';
  roomCode: string;
  freqMhz: string;
  isTalking: boolean;
  pairedViaBarcode: boolean;
  lastSeen: number;
}

interface VoiceLogItem {
  id: string;
  senderId: string;
  senderCallsign: string;
  senderIp?: string;
  senderRole: 'MASTER' | 'CLIENT';
  roomCode: string;
  freqMhz: string;
  type: 'VOICE' | 'TEXT' | 'SOS';
  text: string;
  audioDataUrl?: string;
  durationSec?: number;
  timestamp: number;
}

interface LiveAudioStreamChunk {
  id: string;
  senderId: string;
  senderCallsign: string;
  senderIp?: string;
  freqMhz: string;
  wavDataUrl: string;
  timestamp: number;
}

interface P2PSignalEnvelope {
  id: string;
  fromId: string;
  fromCallsign: string;
  toId: string;
  roomCode: string;
  signalType: 'OFFER' | 'ANSWER' | 'CANDIDATE';
  sdp?: unknown;
  candidate?: unknown;
  timestamp: number;
}

interface MasterRoomInfo {
  masterId: string;
  roomCode: string;
  freqMhz: string;
  channelName: string;
  ssid: string;
  password: string;
  masterCallsign: string;
  masterIp: string;
  udpPort: number;
  broadcastIp: string;
  updatedAt: number;
}

interface ChatMessageItem {
  id: string;
  senderId: string;
  senderCallsign: string;
  senderIp?: string;
  senderRole: 'MASTER' | 'CLIENT';
  roomCode: string;
  freqMhz: string;
  targetCallsign: string;
  chatPriority: 'NORMAL' | 'PENTING' | 'DARURAT';
  text: string;
  timestamp: number;
}

const peers = new Map<string, PeerNode>();
const peerIpAssignmentMap = new Map<string, string>();
let nextAssignedOctet = 101;

const messages: VoiceLogItem[] = [];
const chatMessages: ChatMessageItem[] = [];
const liveChunks: LiveAudioStreamChunk[] = [];
const signalQueue: P2PSignalEnvelope[] = [];
const MAX_MESSAGES = 35;
const MAX_CHAT_MESSAGES = 60;
const MAX_CLIENTS = 20;

let udpPacketsSent = 0;
let udpPacketsReceived = 0;

function getLocalLanIps(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  if (ips.length === 0) ips.push('192.168.43.1');
  return ips;
}

function assignOrResolvePeerIp(peerId: string, rawIp?: string): string {
  if (rawIp && /^192\.168\.\d+\.\d+$/.test(rawIp)) {
    peerIpAssignmentMap.set(peerId, rawIp);
    return rawIp;
  }
  if (peerIpAssignmentMap.has(peerId)) {
    return peerIpAssignmentMap.get(peerId)!;
  }
  const assigned = `192.168.43.${nextAssignedOctet}`;
  nextAssignedOctet = nextAssignedOctet >= 199 ? 101 : nextAssignedOctet + 1;
  peerIpAssignmentMap.set(peerId, assigned);
  return assigned;
}

let activeMaster: MasterRoomInfo = {
  masterId: 'P2P-UDP-BROADCAST',
  roomCode: '8801',
  freqMhz: '142.850',
  channelName: 'SUBDISRUDAL P2P UDP:50000',
  ssid: 'AP-SUBDISRUDAL',
  password: '',
  masterCallsign: 'SERI-01',
  masterIp: getLocalLanIps()[0] || '192.168.43.101',
  udpPort: UDP_DISCOVERY_PORT,
  broadcastIp: UDP_BROADCAST_ADDR,
  updatedAt: Date.now(),
};

function cleanStaleData() {
  const now = Date.now();
  peers.forEach((p, id) => {
    if (now - p.lastSeen > 45000) {
      peers.delete(id);
    }
  });
  while (signalQueue.length > 0 && now - signalQueue[0].timestamp > 25000) {
    signalQueue.shift();
  }
  while (liveChunks.length > 0 && now - liveChunks[0].timestamp > 12000) {
    liveChunks.shift();
  }
}

function getPublicPeers() {
  cleanStaleData();
  const all = Array.from(peers.values()).sort((a, b) => a.callsign.localeCompare(b.callsign));
  return all.slice(0, MAX_CLIENTS + 1);
}

// ============================================================================
// REAL UDP BROADCAST SOCKET ENGINE ON PORT 50000 (255.255.255.255:50000)
// ============================================================================
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let udpReady = false;

udpSocket.on('error', (err) => {
  console.warn(`UDP Port ${UDP_DISCOVERY_PORT} notice:`, err.message);
});

udpSocket.on('message', (msg, rinfo) => {
  udpPacketsReceived++;
  try {
    if (msg.length < 2) return;
    const pktType = msg[0];
    const senderIp = rinfo.address || '192.168.43.102';

    // 0x01 = PKT_BEACON ("CALLSIGN|FREQ_MHZ|NODE_ID")
    if (pktType === 0x01) {
      const payload = msg.subarray(1).toString('utf8');
      const [callsign, freq, nodeId] = payload.split('|');
      if (callsign) {
        const id = nodeId || `UDP-${senderIp}`;
        const resolvedIp = assignOrResolvePeerIp(id, senderIp);
        const existing = peers.get(id);
        peers.set(id, {
          id,
          callsign: callsign.trim(),
          ipAddress: resolvedIp,
          udpPort: rinfo.port || UDP_DISCOVERY_PORT,
          pingMs: existing ? Math.min(42, Math.max(14, Date.now() - existing.lastSeen > 5000 ? 28 : 22)) : 24,
          role: 'CLIENT',
          roomCode: '8801',
          freqMhz: (freq || '142.850').trim(),
          isTalking: existing?.isTalking || false,
          pairedViaBarcode: true,
          lastSeen: Date.now(),
        });
      }
    }
  } catch {
    // Ignore malformed UDP datagram
  }
});

function broadcastUdpDatagram(pktType: number, payloadStr: string) {
  if (!udpReady) return;
  try {
    const body = Buffer.from(payloadStr, 'utf8');
    const packet = Buffer.alloc(1 + body.length);
    packet[0] = pktType;
    body.copy(packet, 1);

    // Send to local loop & broadcast addresses on UDP Port 50000
    udpSocket.send(packet, 0, packet.length, UDP_DISCOVERY_PORT, '127.0.0.1', () => {
      udpPacketsSent++;
    });
    udpSocket.send(packet, 0, packet.length, UDP_DISCOVERY_PORT, UDP_BROADCAST_ADDR, () => {
      udpPacketsSent++;
    });
  } catch {
    // Ignore if container blocks raw 255.255.255.255
  }
}

try {
  udpSocket.bind(UDP_DISCOVERY_PORT, '0.0.0.0', () => {
    try {
      udpSocket.setBroadcast(true);
      udpReady = true;
      console.log(
        `[TACTICAL WI-COMM] UDP Auto-Discovery Listener active on 0.0.0.0:${UDP_DISCOVERY_PORT} (Broadcast ${UDP_BROADCAST_ADDR})`
      );
    } catch {
      udpReady = true;
    }
  });
} catch {
  // Fallback if port is already bound
}

// Broadcast presence of active nodes every 3 seconds over UDP 50000
setInterval(() => {
  cleanStaleData();
  peers.forEach((p) => {
    broadcastUdpDatagram(0x01, `${p.callsign}|${p.freqMhz}|${p.id}`);
  });
}, 3000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  const httpServer = createHttpServer(app);

  // Fast Auto-Discovery & UDP State Poll
  app.get('/api/state', (req, res) => {
    const peerId = String(req.query.peerId || '');
    const callsign = String(req.query.callsign || '');
    const role = String(req.query.role || 'CLIENT');
    const roomCode = String(req.query.room || '8801');
    const freqMhz = String(req.query.freq || '142.850');
    const clientIpParam = String(req.query.ip || '');
    const sinceTs = Number(req.query.since || 0);

    if (peerId) {
      const existing = peers.get(peerId);
      const resolvedIp = assignOrResolvePeerIp(peerId, clientIpParam || existing?.ipAddress);
      const updatedRole: 'MASTER' | 'CLIENT' =
        role === 'MASTER' ? 'MASTER' : 'CLIENT';
      const updatedPeer: PeerNode = {
        id: peerId,
        callsign: callsign || existing?.callsign || 'SERI-01',
        ipAddress: resolvedIp,
        udpPort: UDP_DISCOVERY_PORT,
        pingMs: existing?.pingMs || 24,
        role: updatedRole,
        roomCode: roomCode || existing?.roomCode || activeMaster.roomCode,
        freqMhz: freqMhz || existing?.freqMhz || activeMaster.freqMhz,
        isTalking: existing?.isTalking || false,
        pairedViaBarcode: true,
        lastSeen: Date.now(),
      };
      peers.set(peerId, updatedPeer);

      // Emit real UDP Broadcast beacon on Port 50000
      broadcastUdpDatagram(0x01, `${updatedPeer.callsign}|${updatedPeer.freqMhz}|${updatedPeer.id}`);
    }

    const mySignals: P2PSignalEnvelope[] = [];
    for (let i = signalQueue.length - 1; i >= 0; i--) {
      const sig = signalQueue[i];
      const isForMe = sig.toId === peerId || (sig.toId === 'ALL' && sig.fromId !== peerId);
      if (isForMe) {
        mySignals.unshift(sig);
        signalQueue.splice(i, 1);
      }
    }

    const recentLiveChunks = liveChunks.filter(
      (c) => c.senderId !== peerId && c.timestamp > (sinceTs || Date.now() - 4000)
    );

    res.json({
      activeMaster,
      udpDiscovery: {
        port: UDP_DISCOVERY_PORT,
        broadcastIp: UDP_BROADCAST_ADDR,
        packetsSent: udpPacketsSent,
        packetsReceived: udpPacketsReceived,
      },
      peers: getPublicPeers(),
      messages: messages.slice(0, 25),
      chatMessages: chatMessages.slice(0, 40),
      liveChunks: recentLiveChunks,
      signals: mySignals,
      serverTime: Date.now(),
    });
  });

  // Explicit UDP Broadcast Beacon Endpoint (Triggered every 3s by P2P Auto-Discovery loop)
  app.post('/api/udp-beacon', (req, res) => {
    const { id, callsign, freqMhz, ipAddress, isTalking } = req.body || {};
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }
    const existing = peers.get(id);
    const resolvedIp = assignOrResolvePeerIp(id, ipAddress || existing?.ipAddress);
    const peer: PeerNode = {
      id,
      callsign: callsign || existing?.callsign || 'SERI-01',
      ipAddress: resolvedIp,
      udpPort: UDP_DISCOVERY_PORT,
      pingMs: Math.floor(18 + Math.random() * 12),
      role: 'CLIENT',
      roomCode: '8801',
      freqMhz: freqMhz || existing?.freqMhz || '142.850',
      isTalking: Boolean(isTalking ?? existing?.isTalking),
      pairedViaBarcode: true,
      lastSeen: Date.now(),
    };
    peers.set(id, peer);

    // Emit UDP Broadcast Packet on Port 50000
    broadcastUdpDatagram(0x01, `${peer.callsign}|${peer.freqMhz}|${peer.id}`);

    res.json({
      ok: true,
      selfIp: resolvedIp,
      udpPort: UDP_DISCOVERY_PORT,
      broadcastIp: UDP_BROADCAST_ADDR,
      peers: getPublicPeers(),
    });
  });

  app.post('/api/join', (req, res) => {
    const { id, callsign, role, roomCode, freqMhz, ipAddress } = req.body || {};
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const existing = peers.get(id);
    const resolvedIp = assignOrResolvePeerIp(id, ipAddress || existing?.ipAddress);
    const peer: PeerNode = {
      id,
      callsign: callsign || existing?.callsign || 'SERI-01',
      ipAddress: resolvedIp,
      udpPort: UDP_DISCOVERY_PORT,
      pingMs: 24,
      role: role === 'MASTER' ? 'MASTER' : 'CLIENT',
      roomCode: roomCode || activeMaster.roomCode,
      freqMhz: freqMhz || activeMaster.freqMhz,
      isTalking: existing?.isTalking || false,
      pairedViaBarcode: true,
      lastSeen: Date.now(),
    };
    peers.set(id, peer);

    broadcastUdpDatagram(0x01, `${peer.callsign}|${peer.freqMhz}|${peer.id}`);

    res.json({
      ok: true,
      selfIp: resolvedIp,
      activeMaster,
      peers: getPublicPeers(),
      messages: messages.slice(0, 25),
    });
  });

  // Live Walkie-Talkie UDP Datagram Stream Chunk endpoint
  app.post('/api/live-chunk', (req, res) => {
    const { id, senderId, senderCallsign, freqMhz, wavDataUrl } = req.body || {};
    if (senderId && wavDataUrl) {
      let senderIp = '192.168.43.101';
      if (peers.has(senderId)) {
        const p = peers.get(senderId)!;
        p.isTalking = true;
        p.lastSeen = Date.now();
        senderIp = p.ipAddress;
      }
      broadcastUdpDatagram(0x02, `${senderCallsign || 'SERI-01'}|${freqMhz || '142.850'}|AUDIO_DGRAM`);
      liveChunks.push({
        id: id || `CHK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        senderId,
        senderCallsign: senderCallsign || 'SERI-01',
        senderIp,
        freqMhz: freqMhz || activeMaster.freqMhz,
        wavDataUrl,
        timestamp: Date.now(),
      });
      if (liveChunks.length > 30) liveChunks.shift();
    }
    res.json({ ok: true });
  });

  app.post('/api/p2p-signal', (req, res) => {
    const { fromId, fromCallsign, toId, roomCode, signalType, sdp, candidate } = req.body || {};
    if (!fromId || !signalType) {
      res.status(400).json({ error: 'Invalid signal' });
      return;
    }
    signalQueue.push({
      id: `SIG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromId,
      fromCallsign: fromCallsign || 'PEER',
      toId: toId || 'ALL',
      roomCode: roomCode || activeMaster.roomCode,
      signalType,
      sdp,
      candidate,
      timestamp: Date.now(),
    });
    res.json({ ok: true });
  });

  app.post('/api/ptt-state', (req, res) => {
    const { id, isTalking } = req.body || {};
    if (id && peers.has(id)) {
      const p = peers.get(id)!;
      p.isTalking = Boolean(isTalking);
      p.lastSeen = Date.now();
      broadcastUdpDatagram(isTalking ? 0x02 : 0x03, `${p.callsign}|${p.ipAddress}`);
    }
    res.json({ ok: true, peers: getPublicPeers() });
  });

  app.post('/api/send-message', (req, res) => {
    const { id, senderId, senderCallsign, senderRole, roomCode, freqMhz, type, text, audioDataUrl, durationSec } =
      req.body || {};

    let senderIp = '192.168.43.101';
    if (senderId && peers.has(senderId)) {
      const p = peers.get(senderId)!;
      p.isTalking = false;
      p.lastSeen = Date.now();
      senderIp = p.ipAddress;
    }

    const msgItem: VoiceLogItem = {
      id: id || `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      senderId: senderId || 'UNKNOWN',
      senderCallsign: senderCallsign || 'SERI-01',
      senderIp,
      senderRole: senderRole === 'MASTER' ? 'MASTER' : 'CLIENT',
      roomCode: roomCode || activeMaster.roomCode,
      freqMhz: freqMhz || activeMaster.freqMhz,
      type: type || 'VOICE',
      text: text || 'Pancaran Suara UDP PTT',
      audioDataUrl,
      durationSec: durationSec || 1.5,
      timestamp: Date.now(),
    };

    if (!messages.some((m) => m.id === msgItem.id)) {
      messages.unshift(msgItem);
      if (messages.length > MAX_MESSAGES) messages.pop();
    }

    res.json({ ok: true, message: msgItem });
  });

  app.post('/api/send-chat', (req, res) => {
    const {
      id,
      senderId,
      senderCallsign,
      senderRole,
      roomCode,
      freqMhz,
      targetCallsign,
      chatPriority,
      text,
      timestamp,
    } = req.body || {};

    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }

    const senderIp = senderId && peers.has(senderId) ? peers.get(senderId)!.ipAddress : '192.168.43.101';
    broadcastUdpDatagram(0x04, `${senderCallsign || 'SERI-01'}|${text}`);

    const chatItem: ChatMessageItem = {
      id: id || `CHT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      senderId: senderId || 'UNKNOWN',
      senderCallsign: senderCallsign || 'SERI-01',
      senderIp,
      senderRole: senderRole === 'MASTER' ? 'MASTER' : 'CLIENT',
      roomCode: roomCode || activeMaster.roomCode,
      freqMhz: freqMhz || activeMaster.freqMhz,
      targetCallsign: targetCallsign || 'SEMUA',
      chatPriority:
        chatPriority === 'DARURAT' || chatPriority === 'PENTING' ? chatPriority : 'NORMAL',
      text: String(text).slice(0, 400),
      timestamp: timestamp || Date.now(),
    };

    if (!chatMessages.some((c) => c.id === chatItem.id)) {
      chatMessages.push(chatItem);
      if (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
    }

    res.json({ ok: true, chat: chatItem });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`DISKOMLEKAU Tactical HT running on http://0.0.0.0:${PORT} (UDP Port ${UDP_DISCOVERY_PORT})`);
  });
}

startServer().catch((err) => {
  console.error('Server error:', err);
});
