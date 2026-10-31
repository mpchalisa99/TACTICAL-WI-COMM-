// ============================================================================
// TRUE LOCAL WIFI HOTSPOT WEBRTC P2P ENGINE (ZERO-INTERNET + ANTI-LOOP)
// - Forces WebRTC onto 192.168.x.x Wi-Fi Hotspot IPv4 (strips Carrier IPv6 & Cellular rmnet)
//   so turning OFF Mobile Data on Master NEVER disconnects the Hotspot P2P link!
// - Strict Anti-Loop & Deduplication: Never relays packets back to sender, never keeps
//   duplicate DataChannels to the same peer, and drops self-originated packets immediately.
// ============================================================================

export interface P2PPeerSnapshot {
  id: string;
  callsign: string;
  role: 'MASTER' | 'CLIENT';
  roomCode: string;
  freqMhz: string;
  isTalking: boolean;
  lastSeen: number;
}

export interface P2PVoicePacket {
  id: string;
  type:
    | 'PEER_SYNC'
    | 'PTT_START'
    | 'PTT_STOP'
    | 'LIVE_WAV_CHUNK'
    | 'VOICE_META'
    | 'VOICE_CHUNK'
    | 'VOICE_END'
    | 'CHAT_MESSAGE'
    | 'TEXT_REPORT'
    | 'SOS_ALERT';
  senderId: string;
  senderCallsign: string;
  senderRole: 'MASTER' | 'CLIENT';
  freqMhz: string;
  isTalking?: boolean;
  peersSnapshot?: P2PPeerSnapshot[];
  text?: string;
  targetCallsign?: string;
  chatPriority?: 'NORMAL' | 'PENTING' | 'DARURAT';
  durationSec?: number;
  chunkIndex?: number;
  totalChunks?: number;
  chunkData?: string;
  timestamp: number;
  relayedByMaster?: boolean;
  alreadyStreamedLive?: boolean;
}

export interface AutoSignalMessage {
  id: string;
  fromId: string;
  fromCallsign: string;
  toId: string;
  roomCode: string;
  signalType: 'OFFER' | 'ANSWER' | 'CANDIDATE';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface PeerConnectionEntry {
  peerId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  callsign: string;
  role: 'MASTER' | 'CLIENT';
  pendingCandidates: RTCIceCandidateInit[];
  createdAt: number;
}

function hexFingerprintToBase64Url(hexColonStr: string): string {
  const bytes = hexColonStr
    .trim()
    .split(':')
    .map((h) => parseInt(h, 16) || 0);
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToHexFingerprint(b64Url: string): string {
  try {
    let b64 = b64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const bin = atob(b64);
    const hexParts: string[] = [];
    for (let i = 0; i < bin.length; i++) {
      hexParts.push(bin.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase());
    }
    return hexParts.join(':');
  } catch {
    return b64Url;
  }
}

function isPrivateLanIpv4(ip: string): boolean {
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.endsWith('.local')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function sanitizeSdpForHotspotLan(sdp: string): string {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);

  const candidateIps: string[] = [];
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      const parts = line.split(/\s+/);
      const ip = parts[4] || '';
      if (ip) candidateIps.push(ip);
    }
  }

  const has192Or172 = candidateIps.some(
    (ip) => ip.startsWith('192.168.') || ip.startsWith('172.')
  );

  const filteredCandidates: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const parts = line.split(/\s+/);
    const ip = parts[4] || '';
    if (!ip) continue;

    if (ip.includes(':')) continue;
    if (ip.startsWith('127.') || ip === '0.0.0.0' || ip.startsWith('100.')) continue;
    if (!isPrivateLanIpv4(ip)) continue;
    if (has192Or172 && ip.startsWith('10.')) continue;

    filteredCandidates.push(line);
  }

  if (filteredCandidates.length === 0) {
    return lines
      .filter((l) => {
        if (!l.startsWith('a=candidate:')) return true;
        const ip = l.split(/\s+/)[4] || '';
        return !ip.includes(':');
      })
      .join('\r\n');
  }

  const result: string[] = [];
  let candidatesInserted = false;
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      if (!candidatesInserted) {
        result.push(...filteredCandidates);
        candidatesInserted = true;
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\r\n');
}

function isAllowedTrickleCandidate(candidateStr?: string): boolean {
  if (!candidateStr) return false;
  const parts = candidateStr.split(/\s+/);
  const ip = parts[4] || '';
  if (!ip) return true;
  if (ip.includes(':')) return false;
  if (ip.startsWith('127.') || ip === '0.0.0.0' || ip.startsWith('100.')) return false;
  return isPrivateLanIpv4(ip);
}

export class OfflineWifiP2PManager {
  private peers = new Map<string, PeerConnectionEntry>();
  private p2pPeerStates = new Map<string, P2PPeerSnapshot>();
  private incomingAudioBuffers = new Map<
    string,
    { chunks: string[]; total: number; meta: P2PVoicePacket }
  >();
  private seenIncomingPacketIds = new Set<string>();
  private seenRelayPacketIds = new Set<string>();

  private selfId: string;
  private selfCallsign: string;
  private selfRole: 'MASTER' | 'CLIENT' = 'MASTER';
  private roomCode: string;
  private freqMhz = '142.850';
  private isPttActive = false;
  private ipUnlocked = false;
  private heartbeatInterval: number | null = null;

  private standbyBarcodeEntry: PeerConnectionEntry | null = null;
  private standbyOfferToken: string = '';

  public onP2PConnected?: (remotePeerId: string, remoteCallsign: string) => void;
  public onPeersUpdated?: (peers: P2PPeerSnapshot[]) => void;
  public onPacketReceived?: (packet: P2PVoicePacket, fullAudioDataUrl?: string) => void;
  public sendSignalCallback?: (signal: Omit<AutoSignalMessage, 'id'>) => void;

  constructor(
    selfId: string,
    selfCallsign: string,
    roomCode: string,
    role: 'MASTER' | 'CLIENT' = 'MASTER',
    freqMhz = '142.850'
  ) {
    this.selfId = selfId;
    this.selfCallsign = selfCallsign;
    this.roomCode = roomCode;
    this.selfRole = role;
    this.freqMhz = freqMhz;

    this.heartbeatInterval = window.setInterval(() => {
      this.broadcastPeerSyncHeartbeat();
      this.pruneStaleP2PPeers();
    }, 1000);
  }

  public updateIdentity(
    callsign: string,
    roomCode: string,
    role: 'MASTER' | 'CLIENT' = this.selfRole,
    freqMhz: string = this.freqMhz
  ) {
    this.selfCallsign = callsign;
    this.roomCode = roomCode;
    this.selfRole = role;
    this.freqMhz = freqMhz;
  }

  public async ensureLocalMicStream(): Promise<boolean> {
    if (this.ipUnlocked) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;

    try {
      const unlockPromise = navigator.mediaDevices
        .getUserMedia({ audio: true, video: false })
        .then((stream) => {
          stream.getTracks().forEach((t) => t.stop());
          this.ipUnlocked = true;
          return true;
        })
        .catch(() => false);

      const timeoutPromise = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 450)
      );

      return await Promise.race([unlockPromise, timeoutPromise]);
    } catch {
      return false;
    }
  }

  public setLiveMicTrackEnabled(enabled: boolean) {
    this.isPttActive = enabled;
    this.broadcastPeerSyncHeartbeat();
  }

  private waitIceGatheringComplete(pc: RTCPeerConnection, maxWaitMs = 650): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }, maxWaitMs);

      const onState = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', onState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  private closeEntry(entry?: PeerConnectionEntry) {
    if (!entry) return;
    try {
      if (entry.dc) {
        entry.dc.onmessage = null;
        entry.dc.onopen = null;
        entry.dc.onclose = null;
        entry.dc.close();
      }
      entry.pc.onicecandidate = null;
      entry.pc.ondatachannel = null;
      entry.pc.close();
    } catch {
      // ignore
    }
  }

  // Safely promotes a placeholder peerId ('MASTER' or 'BARCODE-...') to a real peerId,
  // closing any duplicate connection so there is NEVER more than 1 channel to the same phone!
  private assignRealPeerId(entry: PeerConnectionEntry, realPeerId: string, realCallsign?: string) {
    if (!realPeerId || realPeerId === this.selfId) return;
    if (realCallsign) entry.callsign = realCallsign;

    if (entry.peerId !== realPeerId) {
      this.peers.delete(entry.peerId);
      this.p2pPeerStates.delete(entry.peerId);
    }

    const existingOther = this.peers.get(realPeerId);
    if (existingOther && existingOther !== entry) {
      // If existingOther already has an open DataChannel and entry does not, close entry instead!
      if (
        existingOther.dc &&
        existingOther.dc.readyState === 'open' &&
        (!entry.dc || entry.dc.readyState !== 'open')
      ) {
        this.closeEntry(entry);
        return;
      }
      this.closeEntry(existingOther);
    }

    entry.peerId = realPeerId;
    this.peers.set(realPeerId, entry);
  }

  private createPeerConnectionInstance(
    remoteId: string,
    remoteCallsign: string,
    isInitiator: boolean
  ): PeerConnectionEntry {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const entry: PeerConnectionEntry = {
      peerId: remoteId,
      pc,
      dc: null,
      callsign: remoteCallsign || 'REKAN-HT',
      role: remoteCallsign.startsWith('MASTER') ? 'MASTER' : 'CLIENT',
      pendingCandidates: [],
      createdAt: Date.now(),
    };

    pc.onicecandidate = (ev) => {
      if (
        ev.candidate &&
        ev.candidate.candidate &&
        isAllowedTrickleCandidate(ev.candidate.candidate) &&
        this.sendSignalCallback &&
        !entry.peerId.startsWith('BARCODE-')
      ) {
        this.sendSignalCallback({
          fromId: this.selfId,
          fromCallsign: this.selfCallsign,
          toId: entry.peerId,
          roomCode: this.roomCode,
          signalType: 'CANDIDATE',
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('diskomlek-ht-wifi-p2p', { ordered: true });
      this.wireDataChannel(entry, dc);
    } else {
      pc.ondatachannel = (ev) => {
        this.wireDataChannel(entry, ev.channel);
      };
    }

    return entry;
  }

  private getOrCreatePeer(
    remoteId: string,
    remoteCallsign: string,
    isInitiator: boolean,
    forceReset = false
  ): PeerConnectionEntry {
    const existing = this.peers.get(remoteId);
    if (existing && !forceReset) {
      if (remoteCallsign) existing.callsign = remoteCallsign;
      return existing;
    }
    if (existing && forceReset) {
      this.closeEntry(existing);
      this.peers.delete(remoteId);
    }

    const entry = this.createPeerConnectionInstance(remoteId, remoteCallsign, isInitiator);
    this.peers.set(remoteId, entry);
    return entry;
  }

  private wireDataChannel(entry: PeerConnectionEntry, dc: RTCDataChannel) {
    entry.dc = dc;

    dc.onopen = () => {
      if (!entry.peerId.startsWith('BARCODE-')) {
        this.p2pPeerStates.set(entry.peerId, {
          id: entry.peerId,
          callsign: entry.callsign || 'REKAN-HT',
          role: entry.callsign.startsWith('MASTER') ? 'MASTER' : 'CLIENT',
          roomCode: this.roomCode,
          freqMhz: this.freqMhz,
          isTalking: false,
          lastSeen: Date.now(),
        });
      }
      this.emitPeersUpdated();
      this.broadcastPeerSyncHeartbeat();
      this.onP2PConnected?.(entry.peerId, entry.callsign || 'REKAN-HT');
    };

    dc.onclose = () => {
      this.emitPeersUpdated();
    };

    dc.onmessage = (ev) => {
      try {
        const pkt = JSON.parse(ev.data) as P2PVoicePacket;
        if (!pkt) return;

        // ANTI-LOOP RULE #1: Never process any packet that originated from our own phone!
        if (pkt.senderId === this.selfId || pkt.senderCallsign === this.selfCallsign) {
          return;
        }

        // Promote placeholder peerId ('BARCODE-...' or 'MASTER') & close any duplicate channel
        if (pkt.senderId && entry.peerId !== pkt.senderId) {
          this.assignRealPeerId(entry, pkt.senderId, pkt.senderCallsign);
        } else if (pkt.senderCallsign) {
          entry.callsign = pkt.senderCallsign;
        }
        if (pkt.senderRole) {
          entry.role = pkt.senderRole;
        }

        // Update live peer state from incoming packet
        this.p2pPeerStates.set(pkt.senderId, {
          id: pkt.senderId,
          callsign: pkt.senderCallsign || entry.callsign,
          role: pkt.senderRole || entry.role,
          roomCode: this.roomCode,
          freqMhz: pkt.freqMhz || this.freqMhz,
          isTalking:
            pkt.type === 'PTT_START' || pkt.type === 'LIVE_WAV_CHUNK'
              ? true
              : pkt.type === 'PTT_STOP' || pkt.type === 'VOICE_END'
              ? false
              : Boolean(pkt.isTalking),
          lastSeen: Date.now(),
        });

        if (pkt.type === 'PEER_SYNC') {
          if (Array.isArray(pkt.peersSnapshot)) {
            for (const snap of pkt.peersSnapshot) {
              if (snap.id && snap.id !== this.selfId && snap.callsign !== this.selfCallsign) {
                this.p2pPeerStates.set(snap.id, {
                  ...snap,
                  lastSeen: Date.now(),
                });
              }
            }
          }
          this.emitPeersUpdated();
          return;
        }

        // ANTI-LOOP RULE #2: Strict packet deduplication across all DataChannels
        const dedupKey = `${pkt.id}:${pkt.type}:${pkt.chunkIndex ?? ''}`;
        if (this.seenIncomingPacketIds.has(dedupKey)) {
          return;
        }
        this.seenIncomingPacketIds.add(dedupKey);
        if (this.seenIncomingPacketIds.size > 600) {
          const oldest = this.seenIncomingPacketIds.values().next().value;
          if (oldest) this.seenIncomingPacketIds.delete(oldest);
        }

        this.emitPeersUpdated();

        // ANTI-LOOP RULE #3: Master only relays Client packets to OTHER distinct Clients (never back to sender!)
        if (this.selfRole === 'MASTER' && !pkt.relayedByMaster) {
          this.relayPacketToOtherClients(pkt, entry);
        }

        if (pkt.type === 'LIVE_WAV_CHUNK') {
          this.onPacketReceived?.(pkt, pkt.chunkData);
        } else if (pkt.type === 'VOICE_META') {
          this.incomingAudioBuffers.set(pkt.id, {
            chunks: new Array(pkt.totalChunks || 1).fill(''),
            total: pkt.totalChunks || 1,
            meta: pkt,
          });
        } else if (pkt.type === 'VOICE_CHUNK' && typeof pkt.chunkIndex === 'number') {
          const buf = this.incomingAudioBuffers.get(pkt.id);
          if (buf) {
            buf.chunks[pkt.chunkIndex] = pkt.chunkData || '';
          }
        } else if (pkt.type === 'VOICE_END') {
          const buf = this.incomingAudioBuffers.get(pkt.id);
          if (buf) {
            const fullAudio = buf.chunks.join('');
            this.incomingAudioBuffers.delete(pkt.id);
            this.onPacketReceived?.(
              {
                ...buf.meta,
                type: 'VOICE_END',
                alreadyStreamedLive: pkt.alreadyStreamedLive ?? buf.meta.alreadyStreamedLive,
              },
              fullAudio
            );
          } else {
            this.onPacketReceived?.(pkt);
          }
        } else {
          this.onPacketReceived?.(pkt);
        }
      } catch {
        // ignore malformed packet
      }
    };
  }

  private relayPacketToOtherClients(pkt: P2PVoicePacket, sourceEntry: PeerConnectionEntry) {
    const relayKey = `${pkt.id}-${pkt.type}-${pkt.chunkIndex ?? ''}`;
    if (this.seenRelayPacketIds.has(relayKey)) return;
    this.seenRelayPacketIds.add(relayKey);
    if (this.seenRelayPacketIds.size > 400) {
      const first = this.seenRelayPacketIds.values().next().value;
      if (first) this.seenRelayPacketIds.delete(first);
    }

    const raw = JSON.stringify({ ...pkt, relayedByMaster: true });
    const sentTargets = new Set<string>();

    this.peers.forEach((peerEntry, peerId) => {
      // Never relay back to the source connection or to the sender's ID/callsign or unverified BARCODE standby
      if (
        peerEntry === sourceEntry ||
        peerId === sourceEntry.peerId ||
        peerId === pkt.senderId ||
        peerEntry.peerId === pkt.senderId ||
        peerEntry.callsign === pkt.senderCallsign ||
        peerId.startsWith('BARCODE-')
      ) {
        return;
      }
      if (sentTargets.has(peerEntry.peerId)) return;

      if (peerEntry.dc && peerEntry.dc.readyState === 'open') {
        try {
          peerEntry.dc.send(raw);
          sentTargets.add(peerEntry.peerId);
        } catch {
          // ignore
        }
      }
    });
  }

  private broadcastPeerSyncHeartbeat() {
    if (this.getOpenChannelsCount() === 0) return;

    const snapshot: P2PPeerSnapshot[] = [
      {
        id: this.selfId,
        callsign: this.selfCallsign,
        role: this.selfRole,
        roomCode: this.roomCode,
        freqMhz: this.freqMhz,
        isTalking: this.isPttActive,
        lastSeen: Date.now(),
      },
      ...this.getConnectedPeersList(),
    ];

    const syncPkt: P2PVoicePacket = {
      id: `SYNC-${Date.now()}`,
      type: 'PEER_SYNC',
      senderId: this.selfId,
      senderCallsign: this.selfCallsign,
      senderRole: this.selfRole,
      freqMhz: this.freqMhz,
      isTalking: this.isPttActive,
      peersSnapshot: snapshot,
      timestamp: Date.now(),
    };

    const raw = JSON.stringify(syncPkt);
    this.peers.forEach((entry) => {
      if (entry.dc && entry.dc.readyState === 'open') {
        try {
          entry.dc.send(raw);
        } catch {
          // ignore
        }
      }
    });
  }

  private pruneStaleP2PPeers() {
    const now = Date.now();
    let changed = false;
    this.p2pPeerStates.forEach((snap, id) => {
      if (id.startsWith('BARCODE-') || id === 'MASTER') {
        this.p2pPeerStates.delete(id);
        changed = true;
        return;
      }
      const entry = this.peers.get(id);
      const isDcOpen = Boolean(entry?.dc && entry.dc.readyState === 'open');
      if (isDcOpen) {
        snap.lastSeen = now;
      } else if (now - snap.lastSeen > 15000) {
        this.p2pPeerStates.delete(id);
        changed = true;
      }
    });
    if (changed) {
      this.emitPeersUpdated();
    }
  }

  private emitPeersUpdated() {
    this.onPeersUpdated?.(this.getConnectedPeersList());
  }

  public getConnectedPeersList(): P2PPeerSnapshot[] {
    const now = Date.now();
    const byId = new Map<string, P2PPeerSnapshot>();

    this.peers.forEach((entry, id) => {
      if (id.startsWith('BARCODE-')) return;
      if (entry.dc && entry.dc.readyState === 'open') {
        const existing = this.p2pPeerStates.get(id);
        byId.set(
          id,
          existing || {
            id,
            callsign: entry.callsign,
            role: entry.role,
            roomCode: this.roomCode,
            freqMhz: this.freqMhz,
            isTalking: false,
            lastSeen: now,
          }
        );
      }
    });

    this.p2pPeerStates.forEach((snap, id) => {
      if (id.startsWith('BARCODE-') || id === 'MASTER') return;
      if (!byId.has(id) && now - snap.lastSeen <= 15000) {
        byId.set(id, snap);
      }
    });

    return Array.from(byId.values());
  }

  public hasOpenChannelWith(remoteId: string, remoteCallsign?: string): boolean {
    const entry = this.peers.get(remoteId);
    if (entry?.dc && entry.dc.readyState === 'open') return true;
    if (remoteCallsign) {
      for (const e of this.peers.values()) {
        if (e.callsign === remoteCallsign && e.dc && e.dc.readyState === 'open') {
          return true;
        }
      }
    }
    return false;
  }

  public isConnectingWith(remoteId: string, remoteCallsign?: string): boolean {
    const checkEntry = (entry?: PeerConnectionEntry) => {
      if (!entry) return false;
      if (entry.dc && entry.dc.readyState === 'open') return true;
      const ageMs = Date.now() - entry.createdAt;
      return (
        ageMs < 5500 &&
        entry.pc.connectionState !== 'failed' &&
        entry.pc.connectionState !== 'closed'
      );
    };

    if (checkEntry(this.peers.get(remoteId))) return true;
    if (remoteCallsign) {
      for (const e of this.peers.values()) {
        if (e.callsign === remoteCallsign && checkEntry(e)) return true;
      }
    }
    return false;
  }

  public async connectToMasterAutomatically(
    targetMasterId = 'MASTER',
    masterCallsign = 'MASTER-01'
  ) {
    return this.connectToPeer(targetMasterId, masterCallsign, true);
  }

  public async connectToPeer(
    targetPeerId: string,
    targetCallsign: string,
    forceReset = false
  ) {
    if (!targetPeerId || targetPeerId === this.selfId) return;
    if (this.hasOpenChannelWith(targetPeerId, targetCallsign)) return;
    if (!forceReset && this.isConnectingWith(targetPeerId, targetCallsign)) return;

    try {
      const entry = this.getOrCreatePeer(targetPeerId, targetCallsign, true, true);

      await this.ensureLocalMicStream();

      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await this.waitIceGatheringComplete(entry.pc, 550);

      const rawSdp = entry.pc.localDescription?.sdp || offer.sdp || '';
      const hotspotOnlySdp: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: sanitizeSdpForHotspotLan(rawSdp),
      };

      this.sendSignalCallback?.({
        fromId: this.selfId,
        fromCallsign: this.selfCallsign,
        toId: targetPeerId,
        roomCode: this.roomCode,
        signalType: 'OFFER',
        sdp: hotspotOnlySdp,
      });
    } catch {
      // ignore
    }
  }

  public async handleIncomingSignal(sig: AutoSignalMessage) {
    try {
      if (!sig || sig.fromId === this.selfId) return;

      if (sig.signalType === 'OFFER' && sig.sdp) {
        if (this.hasOpenChannelWith(sig.fromId, sig.fromCallsign)) {
          return;
        }

        // Enforce 20-Client Hub Capacity on Master
        if (
          this.selfRole === 'MASTER' &&
          !this.peers.has(sig.fromId) &&
          this.getOpenChannelsCount() >= 20
        ) {
          return;
        }

        const existing = this.peers.get(sig.fromId);
        if (existing && existing.pc.signalingState !== 'stable') {
          const iShouldYield = this.selfRole === 'MASTER' || this.selfId > sig.fromId;
          if (!iShouldYield) {
            return;
          }
        }

        const entry = this.getOrCreatePeer(sig.fromId, sig.fromCallsign, false, true);

        await this.ensureLocalMicStream();

        const sanitizedOffer: RTCSessionDescriptionInit = {
          type: 'offer',
          sdp: sanitizeSdpForHotspotLan(sig.sdp.sdp || ''),
        };
        await entry.pc.setRemoteDescription(new RTCSessionDescription(sanitizedOffer));

        while (entry.pendingCandidates.length > 0) {
          const c = entry.pendingCandidates.shift()!;
          if (isAllowedTrickleCandidate(c.candidate)) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        }

        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        await this.waitIceGatheringComplete(entry.pc, 550);

        const rawAnswerSdp = entry.pc.localDescription?.sdp || answer.sdp || '';
        const hotspotOnlyAnswer: RTCSessionDescriptionInit = {
          type: 'answer',
          sdp: sanitizeSdpForHotspotLan(rawAnswerSdp),
        };

        this.sendSignalCallback?.({
          fromId: this.selfId,
          fromCallsign: this.selfCallsign,
          toId: sig.fromId,
          roomCode: this.roomCode,
          signalType: 'ANSWER',
          sdp: hotspotOnlyAnswer,
        });
      } else if (sig.signalType === 'ANSWER' && sig.sdp) {
        let entry = this.peers.get(sig.fromId);
        if (!entry && this.peers.has('MASTER')) {
          entry = this.peers.get('MASTER')!;
          this.assignRealPeerId(entry, sig.fromId, sig.fromCallsign);
        }

        if (entry && entry.pc.signalingState === 'have-local-offer') {
          entry.callsign = sig.fromCallsign || entry.callsign;
          const sanitizedAnswer: RTCSessionDescriptionInit = {
            type: 'answer',
            sdp: sanitizeSdpForHotspotLan(sig.sdp.sdp || ''),
          };
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sanitizedAnswer));
          while (entry.pendingCandidates.length > 0) {
            const c = entry.pendingCandidates.shift()!;
            if (isAllowedTrickleCandidate(c.candidate)) {
              await entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
          }
        }
      } else if (sig.signalType === 'CANDIDATE' && sig.candidate) {
        if (!isAllowedTrickleCandidate(sig.candidate.candidate)) return;

        const entry = this.peers.get(sig.fromId) || this.peers.get('MASTER');
        if (entry) {
          if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
          } else {
            entry.pendingCandidates.push(sig.candidate);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private packSdpToCompactToken(mode: 'O' | 'A', sdp: string): string {
    const cleanSdp = sanitizeSdpForHotspotLan(sdp);
    const ufrag = cleanSdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1]?.trim() || '';
    const pwd = cleanSdp.match(/a=ice-pwd:([^\r\n]+)/)?.[1]?.trim() || '';
    const fpHex = cleanSdp.match(/a=fingerprint:sha-256\s+([^\r\n]+)/i)?.[1]?.trim() || '';
    const fpB64 = hexFingerprintToBase64Url(fpHex);

    const cands: string[] = [];
    const lines = cleanSdp.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('a=candidate:')) {
        const parts = line.split(/\s+/);
        const proto = (parts[2] || '').toLowerCase();
        const ip = parts[4] || '';
        const port = parts[5] || '';
        if (proto === 'udp' && ip && port && !ip.includes(':')) {
          const item = `${ip}:${port}`;
          if (!cands.includes(item)) cands.push(item);
          if (cands.length >= 3) break;
        }
      }
    }

    return [
      mode,
      this.roomCode,
      this.freqMhz,
      this.selfCallsign,
      this.selfId,
      ufrag,
      pwd,
      fpB64,
      cands.join(','),
    ].join('|');
  }

  private unpackCompactTokenToSdp(token: string): {
    mode: 'O' | 'A';
    roomCode: string;
    freqMhz: string;
    callsign: string;
    peerId: string;
    sdp: RTCSessionDescriptionInit;
  } | null {
    try {
      const parts = token.trim().split('|');
      if (parts.length < 8) return null;
      const [modeRaw, roomCode, freqMhz, callsign, peerId, ufrag, pwd, fpB64, candStr] = parts;
      if (modeRaw !== 'O' && modeRaw !== 'A') return null;
      const fpHex = base64UrlToHexFingerprint(fpB64);
      const setupRole = modeRaw === 'O' ? 'actpass' : 'active';

      const candLines = (candStr || '')
        .split(',')
        .filter(Boolean)
        .map((c, idx) => {
          const [ip, port] = c.split(':');
          return `a=candidate:${idx + 1} 1 udp ${2122260223 - idx * 1000} ${ip} ${port} typ host generation 0`;
        });

      const sdpLines = [
        'v=0',
        `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        `a=ice-ufrag:${ufrag}`,
        `a=ice-pwd:${pwd}`,
        'a=ice-options:trickle',
        `a=fingerprint:sha-256 ${fpHex}`,
        `a=setup:${setupRole}`,
        'a=mid:0',
        'a=sctp-port:5000',
        'a=max-message-size:262144',
        ...candLines,
        'a=end-of-candidates',
        '',
      ];

      return {
        mode: modeRaw,
        roomCode,
        freqMhz,
        callsign,
        peerId,
        sdp: {
          type: modeRaw === 'O' ? 'offer' : 'answer',
          sdp: sdpLines.join('\r\n'),
        },
      };
    } catch {
      return null;
    }
  }

  public async prepareStandbyBarcodeOfferToken(): Promise<string> {
    try {
      await this.ensureLocalMicStream();
      if (
        this.standbyBarcodeEntry &&
        this.standbyOfferToken &&
        this.standbyBarcodeEntry.pc.signalingState === 'have-local-offer'
      ) {
        return this.standbyOfferToken;
      }

      const standbyId = `BARCODE-${Date.now()}`;
      const entry = this.createPeerConnectionInstance(standbyId, 'CLIENT-HT', true);
      this.standbyBarcodeEntry = entry;
      this.peers.set(standbyId, entry);

      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await this.waitIceGatheringComplete(entry.pc, 650);

      const rawSdp = entry.pc.localDescription?.sdp || offer.sdp || '';
      this.standbyOfferToken = this.packSdpToCompactToken('O', rawSdp);
      return this.standbyOfferToken;
    } catch {
      return '';
    }
  }

  public async acceptBarcodeOfferAndCreateAnswerToken(offerToken: string): Promise<{
    answerToken: string;
    masterId: string;
    masterCallsign: string;
    roomCode: string;
    freqMhz: string;
  } | null> {
    const parsed = this.unpackCompactTokenToSdp(offerToken);
    if (!parsed || parsed.mode !== 'O') return null;

    try {
      await this.ensureLocalMicStream();
      const entry = this.getOrCreatePeer(parsed.peerId, parsed.callsign, false, true);
      await entry.pc.setRemoteDescription(new RTCSessionDescription(parsed.sdp));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      await this.waitIceGatheringComplete(entry.pc, 650);

      const rawAnswerSdp = entry.pc.localDescription?.sdp || answer.sdp || '';
      const answerToken = this.packSdpToCompactToken('A', rawAnswerSdp);

      return {
        answerToken,
        masterId: parsed.peerId,
        masterCallsign: parsed.callsign,
        roomCode: parsed.roomCode,
        freqMhz: parsed.freqMhz,
      };
    } catch {
      return null;
    }
  }

  public async applyBarcodeAnswerToken(answerToken: string): Promise<boolean> {
    const parsed = this.unpackCompactTokenToSdp(answerToken);
    if (!parsed || parsed.mode !== 'A') return false;

    try {
      const entry =
        this.standbyBarcodeEntry ||
        Array.from(this.peers.values()).find(
          (e) => e.pc.signalingState === 'have-local-offer'
        );
      if (!entry) return false;

      this.assignRealPeerId(entry, parsed.peerId, parsed.callsign);

      await entry.pc.setRemoteDescription(new RTCSessionDescription(parsed.sdp));
      this.standbyBarcodeEntry = null;
      this.standbyOfferToken = '';

      setTimeout(() => {
        this.prepareStandbyBarcodeOfferToken();
      }, 400);

      return true;
    } catch {
      return false;
    }
  }

  // Sends packet once per distinct connected peer (never sends twice to duplicate entries)
  public sendControlPacket(pkt: P2PVoicePacket): number {
    let sentCount = 0;
    const raw = JSON.stringify(pkt);
    const sentTargets = new Set<string>();

    this.peers.forEach((entry, key) => {
      if (key.startsWith('BARCODE-')) return;
      if (entry.dc && entry.dc.readyState === 'open') {
        const targetKey = entry.peerId || entry.callsign || key;
        if (sentTargets.has(targetKey)) return;
        try {
          entry.dc.send(raw);
          sentTargets.add(targetKey);
          sentCount++;
        } catch {
          // ignore
        }
      }
    });
    return sentCount;
  }

  public sendVoiceAudioOverWifiP2P(meta: P2PVoicePacket, audioDataUrl?: string): number {
    let sentCount = 0;
    const CHUNK_SIZE = 12000;
    const sentTargets = new Set<string>();

    this.peers.forEach((entry, key) => {
      if (key.startsWith('BARCODE-')) return;
      if (!entry.dc || entry.dc.readyState !== 'open') return;
      const targetKey = entry.peerId || entry.callsign || key;
      if (sentTargets.has(targetKey)) return;

      try {
        if (!audioDataUrl) {
          entry.dc.send(JSON.stringify({ ...meta, type: 'VOICE_END' }));
          sentTargets.add(targetKey);
          sentCount++;
          return;
        }

        const totalChunks = Math.ceil(audioDataUrl.length / CHUNK_SIZE);
        entry.dc.send(
          JSON.stringify({
            ...meta,
            type: 'VOICE_META',
            totalChunks,
          })
        );

        for (let i = 0; i < totalChunks; i++) {
          const slice = audioDataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          entry.dc.send(
            JSON.stringify({
              id: meta.id,
              type: 'VOICE_CHUNK',
              senderId: meta.senderId,
              senderCallsign: meta.senderCallsign,
              senderRole: meta.senderRole,
              freqMhz: meta.freqMhz,
              chunkIndex: i,
              totalChunks,
              chunkData: slice,
              timestamp: meta.timestamp,
            })
          );
        }

        entry.dc.send(
          JSON.stringify({
            ...meta,
            type: 'VOICE_END',
          })
        );
        sentTargets.add(targetKey);
        sentCount++;
      } catch {
        // ignore
      }
    });

    return sentCount;
  }

  public getOpenChannelsCount(): number {
    const distinctOpen = new Set<string>();
    this.peers.forEach((entry, key) => {
      if (key.startsWith('BARCODE-')) return;
      if (entry.dc && entry.dc.readyState === 'open') {
        distinctOpen.add(entry.peerId || entry.callsign || key);
      }
    });
    return distinctOpen.size;
  }

  public destroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.peers.forEach((entry) => {
      this.closeEntry(entry);
    });
    this.peers.clear();
    this.p2pPeerStates.clear();
  }
}
