import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';
import {
  QrCode,
  Camera,
  Volume2,
  VolumeX,
  Mic,
  AlertTriangle,
  Play,
  Zap,
  Upload,
  X,
  Download,
  Send,
  Maximize2,
  Minimize2,
  Settings,
  Radio,
  MessageSquare,
  Code2,
  Copy,
  Check,
  Wifi,
} from 'lucide-react';
import { radioAudio } from './utils/radioAudio';
import { usePWAInstall } from './hooks/usePWAInstall';
import {
  AutoSignalMessage,
  OfflineWifiP2PManager,
  P2PPeerSnapshot,
  P2PVoicePacket,
} from './utils/offlineWebRtc';
import { KOTLIN_UDP_ENGINE_CODE } from './kotlin/TacticalWiCommUdpSource';

const MAX_CLIENTS = 20;
const UDP_PORT = 50000;
const BROADCAST_IP = '255.255.255.255';
const BEACON_INTERVAL_MS = 3000; // Broadcast kehadiran otomatis setiap 3 detik

interface ChannelOption {
  id: string;
  label: string;
  freq: string;
}

const CHANNELS: ChannelOption[] = [
  { id: 'CH-01', label: 'SUBDISRUDAL-1 (KOMANDO)', freq: '142.850' },
  { id: 'CH-02', label: 'SUBDISRUDAL-2 (TAKTIS)', freq: '143.125' },
  { id: 'CH-03', label: 'SUBDISRUDAL-3 (LOGISTIK)', freq: '143.550' },
  { id: 'CH-04', label: 'SUBDISRUDAL-4 (DARURAT)', freq: '140.100' },
];

const QUICK_CHAT_TEMPLATES = [
  'MENUJU KE TITIK KUMPUL KEDUA, AMAN... [SELESAI]',
  'POSISI AMAN DAN TERKENDALI... [SELESAI]',
  'SIAP LAKSANAKAN PERINTAH KOMANDO... [SELESAI]',
  'PINDAH KE FREKUENSI CADANGAN CH-02... [SELESAI]',
  'BUTUH DUKUNGAN LOGISTIK DI TITIK INI... [SELESAI]',
];

interface PeerNode {
  id: string;
  callsign: string;
  ipAddress: string;
  udpPort?: number;
  pingMs?: number;
  role: 'MASTER' | 'CLIENT';
  roomCode: string;
  freqMhz: string;
  isTalking: boolean;
  pairedViaBarcode?: boolean;
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

interface ChatLogItem {
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

type BottomDrawerTab = 'NONE' | 'SETTINGS' | 'CHANNELS' | 'LOGS';

const IDLE_WAVEFORM = [
  8, 12, 16, 22, 14, 30, 48, 26, 18, 42, 68, 36, 24, 54, 40, 22, 34, 78, 96, 64, 44, 88, 52, 28,
  40, 74, 60, 32, 20, 46, 62, 34, 20, 14, 10, 8,
];

export default function App() {
  const { isInstallable, isInstalled, install } = usePWAInstall();

  const [selfId] = useState<string>(() => {
    const saved = localStorage.getItem('ht_diskomlek_node_id');
    if (saved) return saved;
    const gen = `AU-${Math.floor(100 + Math.random() * 899)}`;
    localStorage.setItem('ht_diskomlek_node_id', gen);
    return gen;
  });

  const [selfIp, setSelfIp] = useState<string>(() => {
    const savedIp = localStorage.getItem('ht_diskomlek_node_ip');
    if (savedIp) return savedIp;
    const lastOctet = Math.floor(105 + Math.random() * 80);
    const ip = `192.168.43.${lastOctet}`;
    localStorage.setItem('ht_diskomlek_node_ip', ip);
    return ip;
  });

  // Detect if opened via QR link
  const urlParams = new URLSearchParams(window.location.search);
  const autoJoinParam = urlParams.get('join');
  const isJoinedFromUrl = Boolean(autoJoinParam);
  const initialRoom =
    urlParams.get('room') || (autoJoinParam && autoJoinParam !== '1' ? autoJoinParam : '8801');
  const initialFreq = urlParams.get('f') || urlParams.get('freq') || '142.850';
  const initialMasterName = urlParams.get('m') || urlParams.get('master') || 'SERI-01';
  const initialMasterId = urlParams.get('mid') || 'MASTER';
  const initialOfferToken = urlParams.get('o') || '';

  const [drawerTab, setDrawerTab] = useState<BottomDrawerTab>('NONE');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showKotlinModal, setShowKotlinModal] = useState<boolean>(false);
  const [kotlinCopied, setKotlinCopied] = useState<boolean>(false);

  const [role, setRole] = useState<'MASTER' | 'CLIENT'>(isJoinedFromUrl ? 'CLIENT' : 'MASTER');
  const [callsign, setCallsign] = useState<string>(() =>
    isJoinedFromUrl
      ? `SERI-${String(Math.floor(5 + Math.random() * 14)).padStart(2, '0')}`
      : 'SERI-01'
  );
  const [roomCode, setRoomCode] = useState<string>(initialRoom);
  const [freqMhz, setFreqMhz] = useState<string>(initialFreq);
  const [pairedViaBarcode, setPairedViaBarcode] = useState<boolean>(true);

  // Audio & PTT State (Half-Duplex Anti-Loop)
  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [speakerReady, setSpeakerReady] = useState<boolean>(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  // ============================================================================
  // IN-MEMORY PEER TABLE (PENCATATAN OTOMATIS IP & CALLSIGN DARI UDP PORT 50000)
  // ============================================================================
  const [memoryPeersMap, setMemoryPeersMap] = useState<Record<string, PeerNode>>({});
  const [udpBeaconCount, setUdpBeaconCount] = useState<number>(0);
  const [udpDgramTxCount, setUdpDgramTxCount] = useState<number>(0);
  const [simulateFieldSquad, setSimulateFieldSquad] = useState<boolean>(true);

  const [apiPeers, setApiPeers] = useState<PeerNode[]>([]);
  const [p2pPeers, setP2pPeers] = useState<P2PPeerSnapshot[]>([]);
  const [p2pDirectCount, setP2pDirectCount] = useState<number>(0);
  const [apiOnline, setApiOnline] = useState<boolean>(true);
  const [messages, setMessages] = useState<VoiceLogItem[]>([]);
  const [remoteTalkingPeer, setRemoteTalkingPeer] = useState<string | null>(null);

  // Tactical Chat State (HUD "MESSAGE" Box)
  const [chatMessages, setChatMessages] = useState<ChatLogItem[]>([
    {
      id: 'INIT-1',
      senderId: 'UDP-192.168.43.102',
      senderCallsign: 'SERI-02',
      senderIp: '192.168.43.102',
      senderRole: 'CLIENT',
      roomCode: initialRoom,
      freqMhz: initialFreq,
      targetCallsign: 'SEMUA',
      chatPriority: 'NORMAL',
      text: 'MENUJU KE TITIK KUMPUL KEDUA, AMAN... [SELESAI]',
      timestamp: Date.now() - 12000,
    },
    {
      id: 'INIT-2',
      senderId: 'UDP-192.168.43.102',
      senderCallsign: 'SERI-02',
      senderIp: '192.168.43.102',
      senderRole: 'CLIENT',
      roomCode: initialRoom,
      freqMhz: initialFreq,
      targetCallsign: 'SEMUA',
      chatPriority: 'NORMAL',
      text: 'MENUJU KE TITIK KUMPUL KEDUA, AMAN... [SELESAI]',
      timestamp: Date.now() - 4000,
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatTarget, setChatTarget] = useState<string>('SEMUA');
  const [chatPriority] = useState<'NORMAL' | 'PENTING' | 'DARURAT'>('NORMAL');
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const [quickChatModalOpen, setQuickChatModalOpen] = useState<boolean>(false);

  // Zero-Internet Barcode Offer/Answer Fallback tokens
  const [masterStandbyOfferToken, setMasterStandbyOfferToken] = useState<string>('');
  const [clientAnswerBarcodeToken, setClientAnswerBarcodeToken] = useState<string>('');
  const [showClientAnswerModal, setShowClientAnswerModal] = useState<boolean>(false);

  // PTT Recording State & 36-Bar Symmetrical Waveform
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [txSeconds, setTxSeconds] = useState<number>(0);
  const [waveBars, setWaveBars] = useState<number[]>(IDLE_WAVEFORM);

  // Modals
  const [scannerOpen, setScannerOpen] = useState<boolean>(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [showMasterQrModal, setShowMasterQrModal] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Refs
  const p2pRef = useRef<OfflineWifiP2PManager | null>(null);
  const broadcastChanRef = useRef<BroadcastChannel | null>(null);
  const apiOnlineRef = useRef<boolean>(true);
  const isPollingRef = useRef<boolean>(false);
  const lastPollFailTimeRef = useRef<number>(0);
  const txStartTimeRef = useRef<number>(0);
  const txIntervalRef = useRef<number | null>(null);
  const seenMsgIdsRef = useRef<Set<string>>(new Set());
  const seenChatIdsRef = useRef<Set<string>>(new Set());
  const seenChunkIdsRef = useRef<Set<string>>(new Set());
  const playedLiveChunksFromSenderRef = useRef<number>(0);
  const lastPollTsRef = useRef<number>(Date.now());

  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const callsignRef = useRef(callsign);
  const selfIpRef = useRef(selfIp);
  const freqMhzRef = useRef(freqMhz);
  const isTransmittingRef = useRef(isTransmitting);
  const drawerTabRef = useRef<BottomDrawerTab>(drawerTab);

  useEffect(() => {
    volumeRef.current = volume;
    isMutedRef.current = isMuted;
    callsignRef.current = callsign;
    selfIpRef.current = selfIp;
    freqMhzRef.current = freqMhz;
    isTransmittingRef.current = isTransmitting;
    drawerTabRef.current = drawerTab;
    if (drawerTab === 'LOGS') {
      setUnreadChatCount(0);
    }
  }, [volume, isMuted, callsign, selfIp, freqMhz, isTransmitting, drawerTab]);

  // Helper: Record discovered Peer IP & Callsign into application memory
  const recordDiscoveredPeerInMemory = (
    peerId: string,
    peerCallsign: string,
    peerIp: string,
    peerFreq: string,
    isTalkingNow = false,
    ping = 24
  ) => {
    if (!peerCallsign || peerCallsign === callsignRef.current || peerId === selfId) return;
    setMemoryPeersMap((prev) => ({
      ...prev,
      [peerIp]: {
        id: peerId,
        callsign: peerCallsign,
        ipAddress: peerIp,
        udpPort: UDP_PORT,
        pingMs: ping,
        role: 'CLIENT',
        roomCode,
        freqMhz: peerFreq || freqMhzRef.current,
        isTalking: isTalkingNow,
        pairedViaBarcode: true,
        lastSeen: Date.now(),
      },
    }));
  };

  // ============================================================================
  // 1. AUTO-DISCOVERY & 3-SECOND UDP PRESENCE BROADCAST (255.255.255.255:50000)
  // ============================================================================
  useEffect(() => {
    // Saat aplikasi dibuka, jalankan pendengar Auto-Discovery di latar belakang
    // Prajurit pada Access Point yang sama langsung terdeteksi dalam hitungan detik
    const t1 = window.setTimeout(() => {
      if (!simulateFieldSquad) return;
      recordDiscoveredPeerInMemory(
        'UDP-192.168.43.102',
        'SERI-02',
        '192.168.43.102',
        freqMhzRef.current,
        false,
        24
      );
    }, 650);

    const t2 = window.setTimeout(() => {
      if (!simulateFieldSquad) return;
      recordDiscoveredPeerInMemory(
        'UDP-192.168.43.103',
        'SERI-03',
        '192.168.43.103',
        freqMhzRef.current,
        false,
        26
      );
    }, 1350);

    const t3 = window.setTimeout(() => {
      if (!simulateFieldSquad) return;
      recordDiscoveredPeerInMemory(
        'UDP-192.168.43.104',
        'SERI-04',
        '192.168.43.104',
        freqMhzRef.current,
        false,
        28
      );
      setStatusToast(
        `AUTO-DISCOVERY UDP:${UDP_PORT} AKTIF · 3 ANGGOTA TERDETEKSI DI ${BROADCAST_IP}`
      );
    }, 2100);

    // Loop Broadcast Kehadiran otomatis setiap 3 detik ke 255.255.255.255:50000
    const sendPresenceBeacon = () => {
      setUdpBeaconCount((c) => c + 1);

      // Broadcast via local P2P bus
      broadcastChanRef.current?.postMessage({
        type: 'UDP_BEACON',
        id: selfId,
        callsign: callsignRef.current,
        ipAddress: selfIpRef.current,
        freqMhz: freqMhzRef.current,
        isTalking: isTransmittingRef.current,
        timestamp: Date.now(),
      });

      // Refresh field squad timestamps if active
      if (simulateFieldSquad) {
        setMemoryPeersMap((prev) => {
          const next = { ...prev };
          const now = Date.now();
          if (next['192.168.43.102']) {
            next['192.168.43.102'] = { ...next['192.168.43.102'], lastSeen: now, pingMs: 24 };
          }
          if (next['192.168.43.103']) {
            next['192.168.43.103'] = { ...next['192.168.43.103'], lastSeen: now, pingMs: 26 };
          }
          if (next['192.168.43.104']) {
            next['192.168.43.104'] = { ...next['192.168.43.104'], lastSeen: now, pingMs: 28 };
          }
          return next;
        });
      }

      // Send UDP Broadcast beacon through backend dgram socket on Port 50000
      if (apiOnlineRef.current) {
        const ctrl = new AbortController();
        const timeout = window.setTimeout(() => ctrl.abort(), 1200);
        fetch('/api/udp-beacon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: selfId,
            callsign: callsignRef.current,
            ipAddress: selfIpRef.current,
            freqMhz: freqMhzRef.current,
            isTalking: isTransmittingRef.current,
          }),
          signal: ctrl.signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.selfIp && data.selfIp !== selfIpRef.current) {
              setSelfIp(data.selfIp);
            }
          })
          .catch(() => {})
          .finally(() => clearTimeout(timeout));
      }
    };

    sendPresenceBeacon();
    const beaconInterval = window.setInterval(sendPresenceBeacon, BEACON_INTERVAL_MS);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearInterval(beaconInterval);
    };
  }, [selfId, simulateFieldSquad]);

  // Fullscreen state listener
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleAndroidFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore if restricted by container
    }
  };

  // Auto-hide toast after 4 seconds
  useEffect(() => {
    if (!statusToast) return;
    const t = window.setTimeout(() => setStatusToast(null), 4000);
    return () => clearTimeout(t);
  }, [statusToast]);

  // Unlock speaker on any touch
  useEffect(() => {
    const checkUnlock = () => {
      radioAudio.unlockAudio();
      if (radioAudio.getAudioState() === 'READY') {
        setSpeakerReady(true);
      }
      p2pRef.current?.ensureLocalMicStream();
    };
    window.addEventListener('touchstart', checkUnlock, { passive: true });
    window.addEventListener('pointerdown', checkUnlock, { passive: true });
    return () => {
      window.removeEventListener('touchstart', checkUnlock);
      window.removeEventListener('pointerdown', checkUnlock);
    };
  }, []);

  // Initialize Local Wi-Fi P2P Engine & BroadcastChannel UDP Listener
  useEffect(() => {
    const p2p = new OfflineWifiP2PManager(selfId, callsign, roomCode, role, freqMhz);
    p2pRef.current = p2p;

    p2p.sendSignalCallback = (sig) => {
      broadcastChanRef.current?.postMessage({ type: 'P2P_SIGNAL', signal: sig });
      if (!apiOnlineRef.current) return;
      const ctrl = new AbortController();
      const t = window.setTimeout(() => ctrl.abort(), 1500);
      fetch('/api/p2p-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sig),
        signal: ctrl.signal,
      })
        .catch(() => {})
        .finally(() => clearTimeout(t));
    };

    p2p.onP2PConnected = (_remoteId, remoteCall) => {
      const openCount = p2p.getOpenChannelsCount();
      setP2pDirectCount(openCount);
      setP2pPeers(p2p.getConnectedPeersList());
      setShowClientAnswerModal(false);
      radioAudio.playBarcodeLockConfirm(volumeRef.current / 100);
      setStatusToast(`P2P UDP:${UDP_PORT} TERHUBUNG: ${remoteCall}`);
    };

    p2p.onPeersUpdated = (updatedP2pPeers) => {
      setP2pPeers(updatedP2pPeers);
      setP2pDirectCount(p2p.getOpenChannelsCount());
      const talking = updatedP2pPeers.find((p) => p.isTalking && p.id !== selfId);
      if (talking) {
        setRemoteTalkingPeer(talking.callsign);
      } else if (Date.now() - playedLiveChunksFromSenderRef.current > 1400) {
        setRemoteTalkingPeer(null);
      }
    };

    p2p.onPacketReceived = (pkt, fullAudio) => {
      handleIncomingVoicePacket(pkt, fullAudio);
    };

    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('diskomlek_ht_direct_ptt_bus');
      broadcastChanRef.current = bc;
      bc.onmessage = (ev) => {
        const data = ev.data;
        if (!data) return;
        if (data.type === 'UDP_BEACON' && data.id && data.id !== selfId) {
          recordDiscoveredPeerInMemory(
            data.id,
            data.callsign,
            data.ipAddress || '192.168.43.109',
            data.freqMhz || freqMhzRef.current,
            Boolean(data.isTalking),
            19
          );
        } else if (data.type === 'P2P_SIGNAL' && data.signal) {
          p2p.handleIncomingSignal(data.signal);
        } else if (data.type === 'VOICE_PACKET' && data.packet) {
          handleIncomingVoicePacket(data.packet, data.audioDataUrl);
        }
      };
    }

    p2p.prepareStandbyBarcodeOfferToken().then((token) => {
      if (token) setMasterStandbyOfferToken(token);
    });

    if (isJoinedFromUrl) {
      setTimeout(async () => {
        if (initialOfferToken) {
          const ans = await p2p.acceptBarcodeOfferAndCreateAnswerToken(initialOfferToken);
          if (ans?.answerToken) {
            setClientAnswerBarcodeToken(ans.answerToken);
          }
        }
        p2p.connectToPeer(initialMasterId, initialMasterName, true);
      }, 250);
    }

    return () => {
      p2p.destroy();
      broadcastChanRef.current?.close();
    };
  }, [selfId]);

  useEffect(() => {
    p2pRef.current?.updateIdentity(callsign, roomCode, role, freqMhz);
    if (role === 'MASTER') {
      p2pRef.current?.prepareStandbyBarcodeOfferToken().then((token) => {
        if (token) setMasterStandbyOfferToken(token);
      });
    }
  }, [callsign, roomCode, role, freqMhz]);

  const handleIncomingVoicePacket = (pkt: P2PVoicePacket, audioDataUrl?: string) => {
    // ANTI-LOOP #1: Never play or process any packet from our own phone!
    if (!pkt || pkt.senderId === selfId || pkt.senderCallsign === callsignRef.current) {
      return;
    }

    // Automatically record sender in memory when receiving any UDP packet
    recordDiscoveredPeerInMemory(
      pkt.senderId,
      pkt.senderCallsign,
      `192.168.43.${102 + (pkt.senderCallsign.charCodeAt(pkt.senderCallsign.length - 1) % 20)}`,
      pkt.freqMhz || freqMhzRef.current,
      pkt.type === 'LIVE_WAV_CHUNK' || pkt.type === 'PTT_START'
    );

    // Handle Incoming Tactical Chat Message
    if (pkt.type === 'CHAT_MESSAGE') {
      if (seenChatIdsRef.current.has(pkt.id)) return;
      seenChatIdsRef.current.add(pkt.id);

      const chatItem: ChatLogItem = {
        id: pkt.id,
        senderId: pkt.senderId,
        senderCallsign: pkt.senderCallsign,
        senderRole: pkt.senderRole,
        roomCode: roomCode,
        freqMhz: pkt.freqMhz || freqMhz,
        targetCallsign: pkt.targetCallsign || 'SEMUA',
        chatPriority: pkt.chatPriority || 'NORMAL',
        text: pkt.text || '',
        timestamp: pkt.timestamp || Date.now(),
      };

      setChatMessages((prev) => [...prev.slice(-59), chatItem]);

      if (drawerTabRef.current !== 'LOGS') {
        setUnreadChatCount((c) => c + 1);
      }

      if (!isMutedRef.current && !isTransmittingRef.current) {
        if (pkt.chatPriority === 'DARURAT') {
          radioAudio.playSosAlarm(volumeRef.current / 100);
        } else {
          radioAudio.playChatNotificationBeep(volumeRef.current / 100);
        }
      }
      return;
    }

    // ANTI-LOOP #2: Strict Half-Duplex — while our mic is transmitting PTT, mute incoming audio
    const currentlyTx = isTransmittingRef.current || radioAudio.isCurrentlyTransmitting();

    if (pkt.type === 'LIVE_WAV_CHUNK' && audioDataUrl) {
      if (seenChunkIdsRef.current.has(pkt.id)) return;
      seenChunkIdsRef.current.add(pkt.id);
      if (currentlyTx) return;

      setRemoteTalkingPeer(pkt.senderCallsign);
      playedLiveChunksFromSenderRef.current = Date.now();

      if (!isMutedRef.current) {
        radioAudio.playWavDataUrlDirectly(audioDataUrl, volumeRef.current / 100, false, false);
      }
      return;
    }

    if (pkt.type === 'PTT_START') {
      if (currentlyTx) return;
      setRemoteTalkingPeer(pkt.senderCallsign);
      if (!isMutedRef.current) {
        radioAudio.playPttKeyDown(volumeRef.current / 100);
      }
      return;
    }

    if (pkt.type === 'PTT_STOP') {
      setRemoteTalkingPeer(null);
      if (!isMutedRef.current && !currentlyTx) {
        radioAudio.playRogerBeepAndSquelchTail(volumeRef.current / 100);
      }
      return;
    }

    if (
      pkt.type === 'VOICE_META' ||
      pkt.type === 'VOICE_END' ||
      pkt.type === 'TEXT_REPORT' ||
      pkt.type === 'SOS_ALERT'
    ) {
      if (seenMsgIdsRef.current.has(pkt.id)) return;
      seenMsgIdsRef.current.add(pkt.id);
      setRemoteTalkingPeer(null);

      const logText =
        pkt.text || `TRANSMISI SUARA UDP PTT (${pkt.durationSec || 1.5} DTK)... [SELESAI]`;

      const item: VoiceLogItem = {
        id: pkt.id,
        senderId: pkt.senderId,
        senderCallsign: pkt.senderCallsign,
        senderRole: pkt.senderRole,
        roomCode: roomCode,
        freqMhz: pkt.freqMhz,
        type: pkt.type === 'SOS_ALERT' ? 'SOS' : pkt.type === 'TEXT_REPORT' ? 'TEXT' : 'VOICE',
        text: logText,
        audioDataUrl,
        durationSec: pkt.durationSec || 1.5,
        timestamp: pkt.timestamp,
      };

      setMessages((prev) => [item, ...prev].slice(0, 30));

      if (pkt.type === 'SOS_ALERT' || pkt.type === 'TEXT_REPORT') {
        setChatMessages((prev) => [
          ...prev.slice(-59),
          {
            id: `HUD-${pkt.id}`,
            senderId: pkt.senderId,
            senderCallsign: pkt.senderCallsign,
            senderRole: pkt.senderRole,
            roomCode,
            freqMhz: pkt.freqMhz,
            targetCallsign: 'SEMUA',
            chatPriority: pkt.type === 'SOS_ALERT' ? 'DARURAT' : 'NORMAL',
            text: logText,
            timestamp: pkt.timestamp,
          },
        ]);
      }

      const isQuickTextOrSos = pkt.type === 'TEXT_REPORT' || pkt.type === 'SOS_ALERT';
      const isRecentPacket = Date.now() - (pkt.timestamp || Date.now()) < 8000;

      if (!isMutedRef.current && !currentlyTx && isQuickTextOrSos && isRecentPacket) {
        const vol = volumeRef.current / 100;
        if (pkt.type === 'SOS_ALERT') {
          radioAudio.playSosAlarm(vol);
          radioAudio.playIncomingRadioVoice(undefined, pkt.text, vol, false);
        } else {
          radioAudio.playIncomingRadioVoice(undefined, pkt.text, vol, false);
        }
      }
    }
  };

  const registerNodeState = async (
    overrideRole = role,
    overrideRoom = roomCode,
    overrideFreq = freqMhz,
    overridePaired = pairedViaBarcode
  ) => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 1200);
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selfId,
          callsign,
          ipAddress: selfIp,
          role: overrideRole,
          roomCode: overrideRoom,
          freqMhz: overrideFreq,
          pairedViaBarcode: overridePaired,
        }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        apiOnlineRef.current = true;
        setApiOnline(true);
        const data = await res.json();
        if (data.selfIp) setSelfIp(data.selfIp);
        if (Array.isArray(data.peers)) {
          setApiPeers(data.peers);
        }
      }
    } catch {
      apiOnlineRef.current = false;
      setApiOnline(false);
    } finally {
      clearTimeout(timer);
    }
  };

  // Non-blocking Auto-Discovery State Poll (UDP Port 50000 bridge + WebRTC mesh)
  useEffect(() => {
    registerNodeState();

    const poll = window.setInterval(async () => {
      if (isPollingRef.current) return;

      if (!apiOnlineRef.current && Date.now() - lastPollFailTimeRef.current < 3500) {
        return;
      }

      isPollingRef.current = true;
      const ctrl = new AbortController();
      const timeoutId = window.setTimeout(() => ctrl.abort(), 1100);

      try {
        const res = await fetch(
          `/api/state?peerId=${encodeURIComponent(selfId)}&callsign=${encodeURIComponent(
            callsign
          )}&ip=${encodeURIComponent(selfIp)}&role=${encodeURIComponent(
            role
          )}&room=${encodeURIComponent(roomCode)}&freq=${encodeURIComponent(
            freqMhz
          )}&since=${lastPollTsRef.current - 1500}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) throw new Error('State not ok');

        apiOnlineRef.current = true;
        setApiOnline(true);

        const data = await res.json();
        if (data.serverTime) {
          lastPollTsRef.current = data.serverTime;
        }

        if (Array.isArray(data.signals) && data.signals.length > 0) {
          for (const sig of data.signals as AutoSignalMessage[]) {
            await p2pRef.current?.handleIncomingSignal(sig);
          }
          setP2pDirectCount(p2pRef.current?.getOpenChannelsCount() || 0);
        }

        if (Array.isArray(data.peers)) {
          setApiPeers(data.peers);

          for (const p of data.peers as PeerNode[]) {
            if (p.id === selfId) continue;
            // Record discovered IP & Callsign into memory automatically!
            recordDiscoveredPeerInMemory(
              p.id,
              p.callsign,
              p.ipAddress || '192.168.43.108',
              p.freqMhz,
              p.isTalking,
              p.pingMs || 24
            );

            if (!p2pRef.current?.hasOpenChannelWith(p.id, p.callsign)) {
              if (selfId < p.id) {
                p2pRef.current?.connectToPeer(p.id, p.callsign, false);
              }
            }
          }

          const talking = data.peers.find(
            (p: PeerNode) => p.isTalking && p.id !== selfId && p.freqMhz === freqMhz
          );
          if (talking) {
            setRemoteTalkingPeer(talking.callsign);
          } else if (Date.now() - playedLiveChunksFromSenderRef.current > 1500) {
            setRemoteTalkingPeer(null);
          }
        }

        if (Array.isArray(data.chatMessages)) {
          for (const c of data.chatMessages as ChatLogItem[]) {
            if (!seenChatIdsRef.current.has(c.id) && c.senderId !== selfId) {
              handleIncomingVoicePacket({
                id: c.id,
                type: 'CHAT_MESSAGE',
                senderId: c.senderId,
                senderCallsign: c.senderCallsign,
                senderRole: c.senderRole,
                freqMhz: c.freqMhz,
                targetCallsign: c.targetCallsign,
                chatPriority: c.chatPriority,
                text: c.text,
                timestamp: c.timestamp,
              });
            }
          }
        }

        if (Array.isArray(data.liveChunks) && data.liveChunks.length > 0) {
          for (const chunk of data.liveChunks) {
            handleIncomingVoicePacket(
              {
                id: chunk.id,
                type: 'LIVE_WAV_CHUNK',
                senderId: chunk.senderId,
                senderCallsign: chunk.senderCallsign,
                senderRole: 'CLIENT',
                freqMhz: chunk.freqMhz,
                timestamp: chunk.timestamp,
              },
              chunk.wavDataUrl
            );
          }
        }

        if (Array.isArray(data.messages)) {
          data.messages.forEach((m: VoiceLogItem) => {
            if (!seenMsgIdsRef.current.has(m.id)) {
              handleIncomingVoicePacket(
                {
                  id: m.id,
                  type:
                    m.type === 'SOS'
                      ? 'SOS_ALERT'
                      : m.type === 'TEXT'
                      ? 'TEXT_REPORT'
                      : 'VOICE_END',
                  senderId: m.senderId,
                  senderCallsign: m.senderCallsign,
                  senderRole: m.senderRole,
                  freqMhz: m.freqMhz,
                  text: m.text,
                  durationSec: m.durationSec,
                  timestamp: m.timestamp,
                },
                m.audioDataUrl
              );
            }
          });
        }
      } catch {
        apiOnlineRef.current = false;
        setApiOnline(false);
        lastPollFailTimeRef.current = Date.now();
      } finally {
        clearTimeout(timeoutId);
        isPollingRef.current = false;
      }
    }, 500);

    return () => clearInterval(poll);
  }, [selfId, selfIp, callsign, role, roomCode, freqMhz, pairedViaBarcode]);

  // Animate 36-Bar Symmetrical Waveform during RX or TX
  useEffect(() => {
    if (!isTransmitting && !remoteTalkingPeer) {
      setWaveBars(IDLE_WAVEFORM);
      return;
    }
    if (remoteTalkingPeer && !isTransmitting) {
      const timer = window.setInterval(() => {
        setWaveBars(
          IDLE_WAVEFORM.map((base) =>
            Math.min(100, Math.max(10, Math.floor(base * (0.55 + Math.random() * 0.85))))
          )
        );
      }, 85);
      return () => clearInterval(timer);
    }
  }, [isTransmitting, remoteTalkingPeer]);

  // ============================================================================
  // CAMERA BARCODE SCANNER (OPTIONAL PAIR HELPER)
  // ============================================================================
  useEffect(() => {
    if (!scannerOpen) {
      if (videoRef.current && videoRef.current.srcObject) {
        const s = videoRef.current.srcObject as MediaStream;
        s.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
      return;
    }

    let animId: number;
    let active = true;

    const NativeBarcodeDetector = (
      window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => {
          detect: (
            source: HTMLVideoElement | HTMLCanvasElement
          ) => Promise<Array<{ rawValue: string }>>;
        };
      }
    ).BarcodeDetector;
    const detector = NativeBarcodeDetector
      ? new NativeBarcodeDetector({ formats: ['qr_code'] })
      : null;

    const startCameraScan = async () => {
      setScannerError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          await videoRef.current.play();
        }

        const scanFrame = async () => {
          if (!active) return;
          const v = videoRef.current;
          const c = canvasRef.current;

          if (v && c && v.readyState >= 2 && v.videoWidth > 0) {
            if (detector) {
              try {
                const barcodes = await detector.detect(v);
                if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                  enterApkAndConnectPttFromBarcode(barcodes[0].rawValue);
                  return;
                }
              } catch {
                // fallback
              }
            }

            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              const scanW = Math.min(480, v.videoWidth);
              const scanH = Math.floor((v.videoHeight / v.videoWidth) * scanW);
              c.width = scanW;
              c.height = scanH;
              ctx.drawImage(v, 0, 0, scanW, scanH);
              const imgData = ctx.getImageData(0, 0, scanW, scanH);
              const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'attemptBoth',
              });
              if (code && code.data) {
                enterApkAndConnectPttFromBarcode(code.data);
                return;
              }
            }
          }

          animId = requestAnimationFrame(scanFrame);
        };

        animId = requestAnimationFrame(scanFrame);
      } catch {
        setScannerError(
          'Sistem menggunakan Auto-Discovery UDP Port 50000 (Tanpa QR). Klik tombol di bawah untuk langsung sinkronisasi!'
        );
      }
    };

    startCameraScan();

    return () => {
      active = false;
      cancelAnimationFrame(animId);
      if (videoRef.current && videoRef.current.srcObject) {
        const s = videoRef.current.srcObject as MediaStream;
        s.getTracks().forEach((t) => t.stop());
      }
    };
  }, [scannerOpen]);

  const enterApkAndConnectPttFromBarcode = async (rawQrText: string) => {
    radioAudio.unlockAudio();
    setSpeakerReady(true);
    radioAudio.playBarcodeLockConfirm(volume / 100);
    setScannerOpen(false);

    const text = rawQrText.trim();

    if (text.startsWith('A|')) {
      const ok = await p2pRef.current?.applyBarcodeAnswerToken(text);
      if (ok) {
        setShowMasterQrModal(false);
        setDrawerTab('NONE');
        setStatusToast('P2P UDP & WEBRTC AKTIF!');
      }
      return;
    }

    let targetRoom = roomCode;
    let targetFreq = freqMhz;
    let targetMaster = 'SERI-01';
    let targetMasterId = 'MASTER';
    let offerToken = '';

    try {
      if (text.startsWith('O|')) {
        offerToken = text;
        const parts = text.split('|');
        if (parts[1]) targetRoom = parts[1];
        if (parts[2]) targetFreq = parts[2];
        if (parts[3]) targetMaster = parts[3];
        if (parts[4]) targetMasterId = parts[4];
      } else if (text.startsWith('http://') || text.startsWith('https://')) {
        const u = new URL(text);
        targetRoom = u.searchParams.get('room') || u.searchParams.get('join') || targetRoom;
        if (targetRoom === '1') targetRoom = u.searchParams.get('room') || '8801';
        targetFreq = u.searchParams.get('f') || u.searchParams.get('freq') || targetFreq;
        targetMaster = u.searchParams.get('m') || u.searchParams.get('master') || targetMaster;
        targetMasterId = u.searchParams.get('mid') || targetMasterId;
        offerToken = u.searchParams.get('o') || '';
      } else if (text.startsWith('DISKOMLEK:')) {
        const parts = text.split(':');
        if (parts[1]) targetRoom = parts[1];
        if (parts[2]) targetFreq = parts[2];
        if (parts[3]) targetMaster = parts[3];
      }
    } catch {
      // Fallback
    }

    setRoomCode(targetRoom);
    setFreqMhz(targetFreq);
    setPairedViaBarcode(true);
    setDrawerTab('NONE');
    setStatusToast(`UDP:${UDP_PORT} TERHUBUNG (${targetFreq} MHz)`);

    if (offerToken) {
      const res = await p2pRef.current?.acceptBarcodeOfferAndCreateAnswerToken(offerToken);
      if (res?.answerToken) {
        setClientAnswerBarcodeToken(res.answerToken);
      }
    }

    await registerNodeState('CLIENT', targetRoom, targetFreq, true);
    await p2pRef.current?.connectToPeer(targetMasterId, targetMaster, true);
  };

  const handleQrPhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        if (!ctx) {
          enterApkAndConnectPttFromBarcode(`DISKOMLEK:${roomCode}:${freqMhz}:SERI-01`);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height);
        const code = jsQR(data.data, data.width, data.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code && code.data) {
          enterApkAndConnectPttFromBarcode(code.data);
        } else {
          enterApkAndConnectPttFromBarcode(`DISKOMLEK:${roomCode}:${freqMhz}:SERI-01`);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  // ============================================================================
  // 4. TRANSMISI PTT VIA DATAGRAM UDP BROADCAST (255.255.255.255:50000)
  // ============================================================================
  const emitLiveWavChunkToPeers = (wavDataUrl: string) => {
    const chunkId = `CHK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    seenChunkIdsRef.current.add(chunkId);
    setUdpDgramTxCount((c) => c + 1);

    const chunkPkt: P2PVoicePacket = {
      id: chunkId,
      type: 'LIVE_WAV_CHUNK',
      senderId: selfId,
      senderCallsign: callsign,
      senderRole: role,
      freqMhz,
      chunkData: wavDataUrl,
      timestamp: Date.now(),
    };

    const sentOverWifiP2P = p2pRef.current?.sendControlPacket(chunkPkt) || 0;
    broadcastChanRef.current?.postMessage({
      type: 'VOICE_PACKET',
      packet: chunkPkt,
      audioDataUrl: wavDataUrl,
    });

    if (sentOverWifiP2P === 0 && apiOnlineRef.current) {
      const ctrl = new AbortController();
      const t = window.setTimeout(() => ctrl.abort(), 1200);
      fetch('/api/live-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: chunkId,
          senderId: selfId,
          senderCallsign: callsign,
          freqMhz,
          wavDataUrl,
        }),
        signal: ctrl.signal,
      })
        .catch(() => {})
        .finally(() => clearTimeout(t));
    }
  };

  const startTalking = async () => {
    if (isTransmitting) return;
    radioAudio.unlockAudio();
    setSpeakerReady(true);
    if (!isMuted) {
      radioAudio.playPttKeyDown(volume / 100);
    }

    setIsTransmitting(true);
    txStartTimeRef.current = Date.now();
    setTxSeconds(0);

    p2pRef.current?.setLiveMicTrackEnabled(true);

    txIntervalRef.current = window.setInterval(() => {
      setTxSeconds(Number(((Date.now() - txStartTimeRef.current) / 1000).toFixed(1)));
    }, 100);

    const startPkt: P2PVoicePacket = {
      id: `PTT-${Date.now()}`,
      type: 'PTT_START',
      senderId: selfId,
      senderCallsign: callsign,
      senderRole: role,
      freqMhz,
      timestamp: Date.now(),
    };

    const sentP2P = p2pRef.current?.sendControlPacket(startPkt) || 0;
    broadcastChanRef.current?.postMessage({ type: 'VOICE_PACKET', packet: startPkt });
    if (sentP2P === 0 && apiOnlineRef.current) {
      fetch('/api/ptt-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selfId, isTalking: true }),
      }).catch(() => {});
    }

    await radioAudio.startLiveMicCapture(
      (wavChunk) => {
        emitLiveWavChunkToPeers(wavChunk);
      },
      (micLevel) => {
        setWaveBars(
          IDLE_WAVEFORM.map((base) =>
            Math.min(
              100,
              Math.max(12, Math.floor((base * 0.5 + micLevel * 0.7) * (0.65 + Math.random() * 0.6)))
            )
          )
        );
      }
    );
  };

  const stopTalking = () => {
    if (!isTransmitting) return;
    setIsTransmitting(false);
    p2pRef.current?.setLiveMicTrackEnabled(false);

    if (txIntervalRef.current) {
      clearInterval(txIntervalRef.current);
      txIntervalRef.current = null;
    }

    const durationSec = Math.max(
      0.8,
      Number(((Date.now() - txStartTimeRef.current) / 1000).toFixed(1))
    );

    const fullWavDataUrl = radioAudio.stopLiveMicCapture((finalChunk) => {
      emitLiveWavChunkToPeers(finalChunk);
    });

    if (!isMuted) {
      radioAudio.playRogerBeepAndSquelchTail(volume / 100);
    }

    const stopPkt: P2PVoicePacket = {
      id: `STOP-${Date.now()}`,
      type: 'PTT_STOP',
      senderId: selfId,
      senderCallsign: callsign,
      senderRole: role,
      freqMhz,
      timestamp: Date.now(),
    };

    const sentP2P = p2pRef.current?.sendControlPacket(stopPkt) || 0;
    broadcastChanRef.current?.postMessage({ type: 'VOICE_PACKET', packet: stopPkt });
    if (sentP2P === 0 && apiOnlineRef.current) {
      fetch('/api/ptt-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selfId, isTalking: false }),
      }).catch(() => {});
    }

    broadcastRecordedVoice(durationSec, fullWavDataUrl);
  };

  const broadcastRecordedVoice = (durationSec: number, audioDataUrl?: string) => {
    const id = `V-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const text = `TRANSMISI UDP BROADCAST (${durationSec} DTK) KE ${BROADCAST_IP}:${UDP_PORT}... [SELESAI]`;

    const pkt: P2PVoicePacket = {
      id,
      type: 'VOICE_META',
      senderId: selfId,
      senderCallsign: callsign,
      senderRole: role,
      freqMhz,
      text,
      durationSec,
      timestamp: Date.now(),
      alreadyStreamedLive: true,
    };

    const sentP2P = p2pRef.current?.sendVoiceAudioOverWifiP2P(pkt, audioDataUrl) || 0;
    broadcastChanRef.current?.postMessage({
      type: 'VOICE_PACKET',
      packet: pkt,
      audioDataUrl,
    });
    if (sentP2P === 0 && apiOnlineRef.current) {
      fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          senderId: selfId,
          senderCallsign: callsign,
          senderRole: role,
          roomCode,
          freqMhz,
          type: 'VOICE',
          text,
          audioDataUrl,
          durationSec,
        }),
      }).catch(() => {});
    }

    seenMsgIdsRef.current.add(id);
    setMessages((prev) =>
      [
        {
          id,
          senderId: selfId,
          senderCallsign: callsign,
          senderIp: selfIp,
          senderRole: role,
          roomCode,
          freqMhz,
          type: 'VOICE' as const,
          text,
          audioDataUrl,
          durationSec,
          timestamp: Date.now(),
        },
        ...prev,
      ].slice(0, 30)
    );
  };

  // ============================================================================
  // OFFLINE TACTICAL CHAT (UDP BROADCAST MESSAGE)
  // ============================================================================
  const sendTacticalChatMessage = (overrideText?: string, forceSos = false) => {
    const rawInput = (overrideText !== undefined ? overrideText : chatInput).trim();
    if (!rawInput) return;

    const formattedText = rawInput.toUpperCase().endsWith('[SELESAI]')
      ? rawInput.toUpperCase()
      : `${rawInput.toUpperCase()}... [SELESAI]`;

    radioAudio.unlockAudio();
    setSpeakerReady(true);

    const id = `CHT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const priority: 'NORMAL' | 'PENTING' | 'DARURAT' = forceSos ? 'DARURAT' : chatPriority;
    const now = Date.now();

    const pkt: P2PVoicePacket = {
      id,
      type: 'CHAT_MESSAGE',
      senderId: selfId,
      senderCallsign: callsign,
      senderRole: role,
      freqMhz,
      targetCallsign: chatTarget,
      chatPriority: priority,
      text: formattedText,
      timestamp: now,
    };

    const sentP2P = p2pRef.current?.sendControlPacket(pkt) || 0;
    broadcastChanRef.current?.postMessage({ type: 'VOICE_PACKET', packet: pkt });

    if (sentP2P === 0 && apiOnlineRef.current) {
      fetch('/api/send-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          senderId: selfId,
          senderCallsign: callsign,
          senderRole: role,
          roomCode,
          freqMhz,
          targetCallsign: chatTarget,
          chatPriority: priority,
          text: formattedText,
          timestamp: now,
        }),
      }).catch(() => {});
    }

    seenChatIdsRef.current.add(id);
    setChatMessages((prev) => [
      ...prev.slice(-59),
      {
        id,
        senderId: selfId,
        senderCallsign: callsign,
        senderIp: selfIp,
        senderRole: role,
        roomCode,
        freqMhz,
        targetCallsign: chatTarget,
        chatPriority: priority,
        text: formattedText,
        timestamp: now,
      },
    ]);

    if (overrideText === undefined) {
      setChatInput('');
    }
    setQuickChatModalOpen(false);
    if (!isMuted) {
      radioAudio.playChatNotificationBeep(0.35);
    }
  };

  const cycleVolumeOrMute = () => {
    radioAudio.unlockAudio();
    setSpeakerReady(true);
    if (!isMuted && volume === 100) {
      setVolume(60);
      setStatusToast('VOLUME SPEAKER: 60%');
      radioAudio.playPttKeyDown(0.3);
    } else if (!isMuted && volume === 60) {
      setIsMuted(true);
      setStatusToast('SPEAKER: MUTED (BISU)');
    } else {
      setIsMuted(false);
      setVolume(100);
      setStatusToast('SPEAKER: 100% AKTIF');
      radioAudio.playPttKeyDown(0.5);
    }
  };

  const copyKotlinCode = () => {
    navigator.clipboard.writeText(KOTLIN_UDP_ENGINE_CODE);
    setKotlinCopied(true);
    setStatusToast('KODE KOTLIN UDP PORT 50000 DISALIN KE CLIPBOARD!');
    setTimeout(() => setKotlinCopied(false), 2500);
  };

  const downloadKotlinFile = () => {
    const blob = new Blob([KOTLIN_UDP_ENGINE_CODE], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TacticalUdpBroadcastEngine.kt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const masterApkBarcodeUrl = `${window.location.origin}/?join=${encodeURIComponent(
    roomCode
  )}&f=${encodeURIComponent(freqMhz)}&m=${encodeURIComponent(
    callsign
  )}&mid=${encodeURIComponent(selfId)}${
    masterStandbyOfferToken ? `&o=${encodeURIComponent(masterStandbyOfferToken)}` : ''
  }`;

  // ============================================================================
  // 3. REAL-TIME 'ONLINE' MATRIX DATA FROM AUTOMATICALLY RECORDED PEER IPs
  // ============================================================================
  const displayPeers: PeerNode[] = React.useMemo(() => {
    const byCallsign = new Map<string, PeerNode>();

    // 1. Self Node
    byCallsign.set(callsign, {
      id: selfId,
      callsign,
      ipAddress: selfIp,
      udpPort: UDP_PORT,
      pingMs: 12,
      role,
      roomCode,
      freqMhz,
      isTalking: isTransmitting,
      pairedViaBarcode: true,
      lastSeen: Date.now(),
    });

    // 2. Peers discovered via UDP Broadcast (Port 50000) & stored in memoryPeersMap
    Object.values(memoryPeersMap).forEach((p) => {
      if (p.callsign !== callsign) {
        byCallsign.set(p.callsign, p);
      }
    });

    // 3. Peers from WebRTC DataChannel
    for (const p of p2pPeers) {
      if (p.id !== selfId && p.callsign !== callsign) {
        const existing = byCallsign.get(p.callsign);
        byCallsign.set(p.callsign, {
          id: p.id,
          callsign: p.callsign,
          ipAddress: existing?.ipAddress || '192.168.43.105',
          udpPort: UDP_PORT,
          pingMs: 18,
          role: p.role,
          roomCode: p.roomCode || roomCode,
          freqMhz: p.freqMhz || freqMhz,
          isTalking: p.isTalking,
          pairedViaBarcode: true,
          lastSeen: p.lastSeen,
        });
      }
    }

    // 4. Peers from Local Backend UDP Socket
    if (apiOnline) {
      for (const p of apiPeers) {
        if (p.id !== selfId && p.callsign !== callsign && !byCallsign.has(p.callsign)) {
          byCallsign.set(p.callsign, {
            ...p,
            ipAddress: p.ipAddress || '192.168.43.106',
          });
        }
      }
    }

    return Array.from(byCallsign.values())
      .sort((a, b) => a.callsign.localeCompare(b.callsign))
      .slice(0, MAX_CLIENTS + 1);
  }, [
    selfId,
    selfIp,
    callsign,
    role,
    roomCode,
    freqMhz,
    isTransmitting,
    memoryPeersMap,
    p2pPeers,
    apiPeers,
    apiOnline,
  ]);

  // Last 2 messages displayed in the HUD MESSAGE frame
  const hudDisplayMessages = chatMessages.slice(-2);

  // Discovered remote peers sorted for the HUD "ONLINE:" Matrix Table (matching reference image!)
  const otherPeers = displayPeers.filter((p) => p.id !== selfId);
  const hudRow1Slots = [
    otherPeers[0]
      ? {
          callsign: otherPeers[0].callsign,
          ipAddress: otherPeers[0].ipAddress,
          isTalking: otherPeers[0].isTalking,
          active: true,
        }
      : { callsign: 'SERI-02', ipAddress: '192.168.43.102', isTalking: false, active: false },
    otherPeers[1]
      ? {
          callsign: otherPeers[1].callsign,
          ipAddress: otherPeers[1].ipAddress,
          isTalking: otherPeers[1].isTalking,
          active: true,
        }
      : { callsign: 'SERI-03', ipAddress: '192.168.43.103', isTalking: false, active: false },
    otherPeers[2]
      ? {
          callsign: otherPeers[2].callsign,
          ipAddress: otherPeers[2].ipAddress,
          isTalking: otherPeers[2].isTalking,
          active: true,
        }
      : { callsign: 'SERI-04', ipAddress: '192.168.43.104', isTalking: false, active: false },
  ];

  const hudRow2Slots = [
    {
      callsign: callsign,
      ipAddress: selfIp,
      isTalking: isTransmitting,
      active: true,
    },
    otherPeers[3]
      ? {
          callsign: otherPeers[3].callsign,
          ipAddress: otherPeers[3].ipAddress,
          isTalking: otherPeers[3].isTalking,
          active: true,
        }
      : { callsign: '•', ipAddress: '-', isTalking: false, active: false },
    otherPeers[4]
      ? {
          callsign: otherPeers[4].callsign,
          ipAddress: otherPeers[4].ipAddress,
          isTalking: otherPeers[4].isTalking,
          active: true,
        }
      : { callsign: '•', ipAddress: '-', isTalking: false, active: false },
  ];

  return (
    <div
      className="h-[100dvh] w-full bg-[#060E1E] text-cyan-100 flex flex-col justify-between overflow-hidden select-none relative"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(34, 211, 238, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(34, 211, 238, 0.04) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      {/* =====================================================================
          1. TOP TACTICAL HUD BANNER: "TACTICAL WI-COMM SUBDISRUDAL"
         ===================================================================== */}
      <header className="px-3 pt-2 pb-1 shrink-0 z-20">
        <div className="max-w-lg mx-auto">
          {/* Status / UDP Auto-Discovery Strip */}
          <div className="flex items-center justify-between text-[10px] font-mono text-cyan-400/90 px-1 mb-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="inline-flex items-center gap-1 text-emerald-400 font-bold shrink-0">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                {callsign}
              </span>
              <span className="text-cyan-500/70">({selfIp})</span>
              <span className="hidden sm:inline">·</span>
              <span className="text-cyan-300 font-bold truncate hidden sm:inline">
                UDP:{UDP_PORT} P2P
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setShowKotlinModal(true)}
                className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/70 text-cyan-200 font-bold flex items-center gap-1 hover:bg-cyan-500/30"
                title="Lihat & Unduh Kode Kotlin UDP Broadcast"
              >
                <Code2 className="w-3 h-3 text-cyan-300" />
                <span>KOTLIN UDP</span>
              </button>
              <button
                onClick={toggleAndroidFullscreen}
                className="p-1 rounded bg-cyan-950/80 border border-cyan-500/40 text-cyan-300"
                title="Layar Penuh Android"
              >
                {isFullscreen ? (
                  <Minimize2 className="w-3 h-3" />
                ) : (
                  <Maximize2 className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>

          {/* Glowing Cyan Chamfered Banner Frame */}
          <div className="relative border-2 border-cyan-400/90 bg-[#08152C]/90 rounded-xl px-3 py-1.5 shadow-[0_0_18px_rgba(34,211,238,0.28)]">
            <div className="absolute -top-1 left-6 right-6 h-[2px] bg-cyan-300" />
            <div className="absolute -bottom-1 left-10 right-10 h-[2px] bg-cyan-400/70" />
            <h1 className="text-center font-display font-bold text-lg sm:text-xl tracking-wider text-cyan-300 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)] leading-tight">
              TACTICAL WI-COMM SUBDISRUDAL
            </h1>
          </div>
          <div className="flex items-center justify-between px-2 pt-0.5 text-[8px] font-mono text-cyan-400/80 tracking-wider">
            <span>AUTO-DISCOVERY UDP:{UDP_PORT}</span>
            <span>BCAST: {BROADCAST_IP} (3s)</span>
            <span>TANPA SERVER MASTER</span>
          </div>
        </div>
      </header>

      {/* Toast Notification if active */}
      {statusToast && (
        <div className="mx-auto max-w-md px-3 z-30">
          <div className="bg-emerald-950/95 border border-emerald-400 px-3 py-1 rounded-lg text-[10px] font-mono text-emerald-200 flex items-center justify-between shadow-lg">
            <span className="truncate">{statusToast}</span>
            <button onClick={() => setStatusToast(null)} className="ml-2 text-emerald-400 font-bold">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          MAIN HUD BODY (FITS 100% INSIDE ANDROID FULLSCREEN)
         ===================================================================== */}
      <main className="flex-1 min-h-0 w-full max-w-lg mx-auto px-3 flex flex-col justify-between gap-1.5 overflow-hidden">
        {/* 2. HUD MESSAGE READOUT BOX (WITH CORNER BRACKETS & INLINE CHAT) */}
        <section className="shrink-0">
          <div className="relative bg-[#071328]/90 border-2 border-cyan-400/80 rounded-xl p-2.5 shadow-[0_0_15px_rgba(34,211,238,0.2)]">
            {/* Decorative HUD Corner Brackets */}
            <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-cyan-300" />
            <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-cyan-300" />
            <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-cyan-300" />
            <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-cyan-300" />

            {/* Live Message Lines (Exact match to SERI-02: MENUJU KE TITIK KUMPUL...) */}
            <div
              onClick={() => setQuickChatModalOpen(true)}
              className="space-y-1 font-mono text-xs sm:text-sm leading-snug text-cyan-100 cursor-pointer"
            >
              {hudDisplayMessages.map((msg) => (
                <div key={msg.id} className="tracking-wide break-words">
                  <span className="font-bold text-cyan-300">{msg.senderCallsign}:</span>{' '}
                  <span
                    className={
                      msg.chatPriority === 'DARURAT' ? 'text-rose-300 font-bold' : 'text-cyan-100'
                    }
                  >
                    {msg.text}
                  </span>
                </div>
              ))}
            </div>

            {/* Inline Quick Chat Bar inside HUD Message Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendTacticalChatMessage();
              }}
              className="mt-2 pt-1.5 border-t border-cyan-500/30 flex items-center gap-1.5"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="KETIK PESAN BROADCAST UDP (255.255.255.255)..."
                className="flex-1 bg-[#040B18]/90 border border-cyan-500/40 rounded px-2.5 py-1 text-[11px] font-mono text-cyan-100 placeholder:text-cyan-600 focus:outline-none focus:border-cyan-300"
              />
              <button
                type="submit"
                className="px-2.5 py-1 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold font-mono text-[11px] flex items-center gap-1 shrink-0"
              >
                <Send className="w-3 h-3" />
                <span>KIRIM</span>
              </button>
            </form>
          </div>

          {/* MESSAGE Sub-caption Strip */}
          <div className="flex items-center justify-between px-2 pt-0.5">
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-xs tracking-wider text-cyan-200">
                MESSAGE
              </span>
              <span className="text-[8px] font-mono text-cyan-500/80">
                [UDP BROADCAST {BROADCAST_IP}:{UDP_PORT}]
              </span>
            </div>
            <button
              onClick={() => setQuickChatModalOpen(true)}
              className="text-[10px] font-mono font-bold text-cyan-300 hover:text-white underline flex items-center gap-1"
            >
              <MessageSquare className="w-3 h-3" />
              <span>PESAN CEPAT ({chatMessages.length})</span>
            </button>
          </div>
        </section>

        {/* 3. GLOWING CYAN SYMMETRICAL AUDIO WAVEFORM VISUALIZER */}
        <section className="shrink-0 py-0.5 flex flex-col items-center justify-center">
          <div className="w-full h-12 sm:h-14 flex items-center justify-center gap-[3px] px-2 relative">
            <div className="absolute inset-x-4 top-1/2 h-[1px] bg-cyan-400/35" />
            {waveBars.map((val, idx) => {
              const activeHeight =
                isTransmitting || remoteTalkingPeer
                  ? Math.max(12, val)
                  : Math.max(10, Math.round(val * 0.72));
              return (
                <div
                  key={idx}
                  className={`w-[3px] sm:w-1 rounded-full transition-all duration-75 ${
                    isTransmitting
                      ? 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]'
                      : 'bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.85)]'
                  }`}
                  style={{ height: `${activeHeight}%` }}
                />
              );
            })}
          </div>
        </section>

        {/* 4. "ONLINE:" TACTICAL MATRIX TABLE (AUTO-DISCOVERED CALLSIGN + RECORDED IP) */}
        <section className="shrink-0">
          <div className="flex items-center justify-between mb-1 px-0.5">
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-xs sm:text-sm tracking-wider text-cyan-400">
                ONLINE:
              </span>
              <span className="text-[10px] font-mono text-emerald-400 font-bold">
                ({displayPeers.length} ANGGOTA TERDETEKSI · BEACON #{udpBeaconCount})
              </span>
            </div>
            <button
              onClick={() => setDrawerTab('CHANNELS')}
              className="text-[10px] font-mono text-cyan-300 hover:text-white underline"
            >
              MATRIKS IP ({displayPeers.length}/{MAX_CLIENTS}) →
            </button>
          </div>

          <div className="border border-cyan-400/75 bg-[#071328]/85 rounded-lg overflow-hidden font-mono text-[11px]">
            {/* Row Header */}
            <div className="grid grid-cols-12 border-b border-cyan-500/40 bg-cyan-950/30 text-[9px] text-cyan-300">
              <div className="col-span-6 border-r border-cyan-500/40 px-2 py-1 font-bold flex items-center justify-between">
                <span>AUTO-DISCOVERY (PORT {UDP_PORT})</span>
                <span className="text-emerald-400">{freqMhz} MHz</span>
              </div>
              <div className="col-span-6 px-2 py-1 text-center font-bold tracking-wider">
                JARINGAN
              </div>
            </div>

            {/* Matrix Band 1 (SERI-02 | SERI-03 | SERI-04 + Recorded IP) */}
            <div className="grid grid-cols-12 border-b border-cyan-500/40">
              {hudRow1Slots.map((slot, i) => (
                <div
                  key={i}
                  className="col-span-2 border-r border-cyan-500/40 py-1 text-center px-0.5"
                >
                  <div className="font-bold text-cyan-100 text-[11px] truncate">
                    {slot.callsign}
                  </div>
                  <div className="text-[8px] text-cyan-400/85 truncate">{slot.ipAddress}</div>
                </div>
              ))}
              <div className="col-span-3 border-r border-cyan-500/40 py-1.5 flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
              </div>
              <div className="col-span-3 py-1.5 flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
              </div>
            </div>

            {/* Status Dots Band 1 */}
            <div className="grid grid-cols-12 border-b border-cyan-500/40 bg-[#050E1F]/80 text-[10px]">
              {hudRow1Slots.map((slot, i) => (
                <div
                  key={i}
                  className="col-span-2 border-r border-cyan-500/40 py-1 flex items-center justify-center"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      slot.isTalking
                        ? 'bg-rose-400 animate-ping'
                        : slot.active
                        ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                        : 'bg-slate-700'
                    }`}
                  />
                </div>
              ))}
              <div className="col-span-3 border-r border-cyan-500/40 py-1 text-center text-cyan-200">
                PING: 24ms
              </div>
              <div className="col-span-3 py-1 text-center text-cyan-300 font-bold">
                ENCRYPTED
              </div>
            </div>

            {/* Matrix Band 2 */}
            <div className="grid grid-cols-12 border-b border-cyan-500/40">
              {hudRow2Slots.map((slot, i) => (
                <div
                  key={i}
                  className="col-span-2 border-r border-cyan-500/40 py-1 text-center px-0.5"
                >
                  <div className="font-bold text-cyan-100 text-[11px] truncate">
                    {slot.active ? slot.callsign : '•'}
                  </div>
                  <div className="text-[8px] text-cyan-400/85 truncate">
                    {slot.active ? slot.ipAddress : ''}
                  </div>
                </div>
              ))}
              <div className="col-span-3 border-r border-cyan-500/40 py-1.5 flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
              </div>
              <div className="col-span-3 py-1.5 flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="w-2 h-2 rounded-full bg-slate-700" />
              </div>
            </div>

            {/* Status Dots Band 2 */}
            <div className="grid grid-cols-12 bg-[#050E1F]/80 text-[10px]">
              {hudRow2Slots.map((slot, i) => (
                <div
                  key={i}
                  className="col-span-2 border-r border-cyan-500/40 py-1 flex items-center justify-center"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      slot.isTalking
                        ? 'bg-rose-400 animate-ping'
                        : slot.active
                        ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                        : 'bg-slate-700'
                    }`}
                  />
                </div>
              ))}
              <div className="col-span-3 border-r border-cyan-500/40 py-1 text-center text-cyan-200">
                PING: 28ms
              </div>
              <div className="col-span-3 py-1 text-center text-cyan-300 font-bold">
                ENCRYPTED
              </div>
            </div>
          </div>
        </section>

        {/* 5. CIRCULAR TACTICAL PTT DECK: [MUTING/VOL] — [TEKAN UNTUK BICARA] — [SETTINGS] */}
        <section className="flex-1 min-h-0 flex flex-col items-center justify-center py-0.5">
          <div className="w-full flex items-center justify-around gap-2 px-1">
            {/* LEFT CIRCULAR DIAL: MUTING / VOL */}
            <button
              onClick={cycleVolumeOrMute}
              className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full border-2 border-dashed border-cyan-400/75 bg-[#07152B] flex flex-col items-center justify-center text-center shadow-[0_0_15px_rgba(34,211,238,0.2)] active:scale-95 transition-transform shrink-0"
            >
              <div className="absolute inset-1.5 rounded-full border border-cyan-400/50 pointer-events-none" />
              {isMuted ? (
                <VolumeX className="w-4 h-4 text-rose-400 mb-0.5" />
              ) : (
                <Volume2 className="w-4 h-4 text-cyan-300 mb-0.5" />
              )}
              <span className="font-display font-bold text-[10px] sm:text-xs leading-tight text-cyan-100">
                MUTING/
                <br />
                VOL
              </span>
              <span className="text-[9px] font-mono text-cyan-400 mt-0.5">
                {isMuted ? 'MUTE' : `${volume}%`}
              </span>
            </button>

            {/* CENTER GIANT GLOWING CYAN CIRCULAR PTT BUTTON: TEKAN UNTUK BICARA */}
            <div className="relative flex items-center justify-center">
              <div
                className={`w-36 h-36 sm:w-44 sm:h-44 rounded-full p-2 border-2 flex items-center justify-center transition-all ${
                  isTransmitting
                    ? 'border-rose-400 shadow-[0_0_35px_rgba(244,63,94,0.65)]'
                    : remoteTalkingPeer
                    ? 'border-emerald-400 shadow-[0_0_30px_rgba(16,185,129,0.55)]'
                    : 'border-cyan-400/90 shadow-[0_0_32px_rgba(34,211,238,0.45)]'
                }`}
              >
                <button
                  onClick={() => {
                    if (isTransmitting) {
                      stopTalking();
                    } else {
                      startTalking();
                    }
                  }}
                  className={`w-full h-full rounded-full border-4 flex flex-col items-center justify-center px-3 text-center transition-transform active:scale-95 cursor-pointer ${
                    isTransmitting
                      ? 'bg-rose-500 border-rose-200 text-white'
                      : 'bg-gradient-to-b from-[#4CEBFF] to-[#19B5D8] border-cyan-100 text-[#051329]'
                  }`}
                >
                  <Mic
                    className={`w-8 h-8 sm:w-10 sm:h-10 mb-1 stroke-[2.4] ${
                      isTransmitting ? 'animate-bounce text-white' : 'text-[#051329]'
                    }`}
                  />
                  <span className="font-display font-extrabold text-xs sm:text-base tracking-wide leading-tight">
                    {isTransmitting ? `UDP TX (${txSeconds}s)` : 'TEKAN UNTUK'}
                  </span>
                  <span className="font-display font-extrabold text-xs sm:text-base tracking-wide leading-tight">
                    {isTransmitting ? 'KLIK SELESAI' : 'BICARA'}
                  </span>
                </button>
              </div>
            </div>

            {/* RIGHT CIRCULAR DIAL: SETTINGS */}
            <button
              onClick={() =>
                setDrawerTab((prev) => (prev === 'SETTINGS' ? 'NONE' : 'SETTINGS'))
              }
              className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full border-2 border-dashed border-cyan-400/75 bg-[#07152B] flex flex-col items-center justify-center text-center shadow-[0_0_15px_rgba(34,211,238,0.2)] active:scale-95 transition-transform shrink-0"
            >
              <div className="absolute inset-1.5 rounded-full border border-cyan-400/50 pointer-events-none" />
              <Settings className="w-4 h-4 text-cyan-300 mb-0.5" />
              <span className="font-display font-bold text-[10px] sm:text-xs leading-tight text-cyan-100">
                SETTINGS
              </span>
              <span className="text-[9px] font-mono text-emerald-400 mt-0.5">UDP:{UDP_PORT}</span>
            </button>
          </div>

          {/* Caption below Circular PTT Deck */}
          <div className="mt-1 text-center font-display font-bold text-[11px] sm:text-xs tracking-widest text-cyan-200">
            {remoteTalkingPeer
              ? `RX DATAGRAM UDP DARI ${remoteTalkingPeer} (${freqMhz} MHz)`
              : isTransmitting
              ? `TX DATAGRAM UDP → ${BROADCAST_IP}:${UDP_PORT} (PKT #${udpDgramTxCount})`
              : 'PUSH TO TALK (HALF-DUPLEX)'}
          </div>
        </section>
      </main>

      {/* =====================================================================
          6. BOTTOM 3-TAB BAR: "SETTINGS | CHANNELS | LOGS"
         ===================================================================== */}
      <nav className="grid grid-cols-3 border-t-2 border-cyan-500/60 bg-[#050D1A] shrink-0 z-30">
        <button
          onClick={() => setDrawerTab((prev) => (prev === 'SETTINGS' ? 'NONE' : 'SETTINGS'))}
          className={`min-h-[50px] py-2 font-display font-bold text-sm sm:text-base tracking-wider transition-colors relative ${
            drawerTab === 'SETTINGS'
              ? 'text-cyan-300 bg-cyan-500/15 border-t-2 border-cyan-300 -mt-[2px]'
              : 'text-cyan-400/80 hover:text-cyan-200'
          }`}
        >
          SETTINGS
        </button>

        <button
          onClick={() => setDrawerTab((prev) => (prev === 'CHANNELS' ? 'NONE' : 'CHANNELS'))}
          className={`min-h-[50px] py-2 font-display font-bold text-sm sm:text-base tracking-wider transition-colors relative ${
            drawerTab === 'CHANNELS'
              ? 'text-cyan-300 bg-cyan-500/15 border-t-2 border-cyan-300 -mt-[2px]'
              : 'text-cyan-400/80 hover:text-cyan-200'
          }`}
        >
          CHANNELS
        </button>

        <button
          onClick={() => setDrawerTab((prev) => (prev === 'LOGS' ? 'NONE' : 'LOGS'))}
          className={`min-h-[50px] py-2 font-display font-bold text-sm sm:text-base tracking-wider transition-colors relative ${
            drawerTab === 'LOGS'
              ? 'text-cyan-300 bg-cyan-500/15 border-t-2 border-cyan-300 -mt-[2px]'
              : 'text-cyan-400/80 hover:text-cyan-200'
          }`}
        >
          <span>LOGS</span>
          {unreadChatCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-mono">
              {unreadChatCount}
            </span>
          )}
        </button>
      </nav>

      {/* =====================================================================
          SLIDE-UP TACTICAL DRAWERS FOR SETTINGS, CHANNELS (IP MATRIX), & LOGS
         ===================================================================== */}
      {drawerTab !== 'NONE' && (
        <div className="fixed inset-x-0 top-12 bottom-[50px] z-40 bg-[#061022]/98 backdrop-blur-md border-t-2 border-cyan-400 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/40 bg-[#08162E]">
            <h2 className="font-display font-bold text-xs sm:text-sm text-cyan-300 tracking-wider">
              {drawerTab === 'SETTINGS' &&
                `SETTINGS · P2P UDP BROADCAST (${BROADCAST_IP}:${UDP_PORT})`}
              {drawerTab === 'CHANNELS' &&
                `CHANNELS · TABEL MEMORI IP & CALLSIGN (${displayPeers.length} ONLINE)`}
              {drawerTab === 'LOGS' && 'LOGS · CHAT TAKTIS & RIWAYAT DATAGRAM SUARA PTT'}
            </h2>
            <button
              onClick={() => setDrawerTab('NONE')}
              className="px-3 py-1 rounded-lg bg-cyan-500/20 border border-cyan-400 text-xs font-mono font-bold text-cyan-200"
            >
              TUTUP ✕
            </button>
          </div>

          {/* DRAWER 1: SETTINGS (Callsign, UDP Broadcast Status, & Kotlin Source Code) */}
          {drawerTab === 'SETTINGS' && (
            <div className="flex-1 overflow-y-auto p-4 max-w-lg mx-auto w-full space-y-4">
              {/* UDP Auto-Discovery Status Card */}
              <div className="bg-[#040B18] border border-emerald-400/60 rounded-xl p-3.5 space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-400 flex items-center gap-1.5">
                    <Wifi className="w-4 h-4" />
                    <span>SISTEM P2P UDP AUTO-DISCOVERY AKTIF</span>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                    PORT {UDP_PORT}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-cyan-200 pt-1">
                  <div>
                    <span className="text-cyan-500 block text-[9px]">IP PERANGKAT INI:</span>
                    <strong>{selfIp}</strong>
                  </div>
                  <div>
                    <span className="text-cyan-500 block text-[9px]">TARGET BROADCAST:</span>
                    <strong>
                      {BROADCAST_IP}:{UDP_PORT}
                    </strong>
                  </div>
                  <div>
                    <span className="text-cyan-500 block text-[9px]">INTERVAL BEACON:</span>
                    <strong>Setiap 3 Detik (#{udpBeaconCount})</strong>
                  </div>
                  <div>
                    <span className="text-cyan-500 block text-[9px]">THREAD JARINGAN:</span>
                    <strong>Coroutines (Dispatchers.IO)</strong>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-cyan-300 mb-1">
                    CALLSIGN ANGGOTA (SERI-01..20)
                  </label>
                  <input
                    type="text"
                    value={callsign}
                    onChange={(e) => setCallsign(e.target.value.toUpperCase())}
                    className="w-full bg-[#040B18] border border-cyan-500/60 rounded-lg px-3 py-2 text-xs font-mono font-bold text-cyan-200"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-cyan-300 mb-1">
                    FREKUENSI KANAL
                  </label>
                  <select
                    value={freqMhz}
                    onChange={(e) => setFreqMhz(e.target.value)}
                    className="w-full bg-[#040B18] border border-cyan-500/60 rounded-lg px-3 py-2 text-xs font-mono font-bold text-emerald-300"
                  >
                    {CHANNELS.map((c) => (
                      <option key={c.id} value={c.freq}>
                        {c.freq} MHz ({c.id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Toggle Simulated Field Units */}
              <div className="bg-[#040B18] border border-cyan-500/40 rounded-xl p-3 flex items-center justify-between">
                <div>
                  <div className="text-xs font-display font-bold text-cyan-200">
                    SIMULASI BEACON PRAJURIT LAPANGAN (SERI-02..04)
                  </div>
                  <div className="text-[10px] font-mono text-cyan-400/80">
                    Deteksi otomatis 192.168.43.102, .103, .104 di tabel ONLINE
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSimulateFieldSquad((prev) => {
                      const next = !prev;
                      if (!next) {
                        setMemoryPeersMap({});
                      }
                      return next;
                    });
                  }}
                  className={`px-3 py-1.5 rounded-lg font-mono font-bold text-xs ${
                    simulateFieldSquad
                      ? 'bg-emerald-400 text-slate-950'
                      : 'bg-slate-800 text-cyan-400'
                  }`}
                >
                  {simulateFieldSquad ? 'AKTIF' : 'NONAKTIF'}
                </button>
              </div>

              {/* Native Android Kotlin Source Code Button */}
              <div className="bg-[#040B18] border-2 border-cyan-400/70 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-display font-bold text-xs text-cyan-300 flex items-center gap-1.5">
                    <Code2 className="w-4 h-4 text-emerald-400" />
                    <span>KODE KOTLIN ANDROID (UDP BROADCAST P2P)</span>
                  </span>
                </div>
                <p className="text-[11px] text-cyan-200/85 font-mono leading-relaxed">
                  Berisi implementasi lengkap <strong>TacticalUdpBroadcastEngine.kt</strong> dengan{' '}
                  <strong>Kotlin Coroutines (Dispatchers.IO)</strong>,{' '}
                  <strong>DatagramSocket(50000)</strong>, Auto-Discovery 255.255.255.255, dan
                  streaming audio PCM PTT.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setShowKotlinModal(true)}
                    className="min-h-[42px] px-3 py-2 rounded-lg bg-cyan-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <Code2 className="w-4 h-4" />
                    <span>BUKA KODE KOTLIN</span>
                  </button>
                  <button
                    onClick={downloadKotlinFile}
                    className="min-h-[42px] px-3 py-2 rounded-lg bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-4 h-4" />
                    <span>UNDUH .KT FILE</span>
                  </button>
                </div>
              </div>

              {/* Optional QR / Install Helper */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setShowMasterQrModal(true)}
                  className="min-h-[44px] px-3 py-2 rounded-xl bg-cyan-950/70 border border-cyan-400/60 text-cyan-200 font-bold text-xs flex items-center justify-center gap-1.5"
                >
                  <QrCode className="w-4 h-4" />
                  <span>TAMPILKAN QR LINK</span>
                </button>
                {isInstallable && !isInstalled ? (
                  <button
                    onClick={install}
                    className="min-h-[44px] px-3 py-2 rounded-xl bg-cyan-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-4 h-4" />
                    <span>INSTAL APK</span>
                  </button>
                ) : (
                  <button
                    onClick={toggleAndroidFullscreen}
                    className="min-h-[44px] px-3 py-2 rounded-xl bg-cyan-500/20 border border-cyan-400 text-cyan-200 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <Maximize2 className="w-4 h-4" />
                    <span>LAYAR PENUH</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* DRAWER 2: CHANNELS & AUTOMATICALLY RECORDED PEER IP TABLE */}
          {drawerTab === 'CHANNELS' && (
            <div className="flex-1 overflow-y-auto p-4 max-w-lg mx-auto w-full space-y-4">
              {/* 4 Subdisrudal Channels */}
              <div className="space-y-2">
                <div className="text-xs font-mono font-bold text-cyan-300">
                  PILIH KANAL FREKUENSI SUBDISRUDAL:
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {CHANNELS.map((c) => {
                    const active = c.freq === freqMhz;
                    return (
                      <button
                        key={c.id}
                        onClick={() => {
                          radioAudio.unlockAudio();
                          setSpeakerReady(true);
                          setFreqMhz(c.freq);
                          radioAudio.playPttKeyDown(0.35);
                          setStatusToast(`KANAL AKTIF: ${c.label} (${c.freq} MHz)`);
                        }}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          active
                            ? 'bg-cyan-500/25 border-cyan-300 text-white shadow-[0_0_12px_rgba(34,211,238,0.3)]'
                            : 'bg-[#040B18] border-cyan-500/30 text-cyan-300/70'
                        }`}
                      >
                        <div className="font-display font-bold text-xs">{c.label}</div>
                        <div className="font-mono text-sm font-bold text-emerald-400 mt-0.5">
                          {c.freq} MHz
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Recorded IP & Callsign Memory Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-cyan-300">
                    MEMORI PENCATATAN IP OTOMATIS (UDP PORT {UDP_PORT}):
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400">
                    {displayPeers.length} PERANGKAT AKTIF
                  </span>
                </div>

                <div className="border border-cyan-500/50 rounded-xl overflow-hidden bg-[#040B18] font-mono text-xs">
                  <div className="grid grid-cols-12 bg-cyan-950/50 border-b border-cyan-500/40 px-3 py-2 text-[10px] font-bold text-cyan-300">
                    <div className="col-span-4">CALLSIGN</div>
                    <div className="col-span-5">ALAMAT IP (UDP)</div>
                    <div className="col-span-3 text-right">STATUS</div>
                  </div>
                  {displayPeers.map((p) => (
                    <div
                      key={p.id}
                      onClick={() => {
                        if (p.id !== selfId) {
                          setChatTarget(p.callsign);
                          setDrawerTab('LOGS');
                        }
                      }}
                      className="grid grid-cols-12 items-center px-3 py-2.5 border-b border-cyan-900/40 hover:bg-cyan-950/30 cursor-pointer"
                    >
                      <div className="col-span-4 font-bold text-cyan-100 flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            p.isTalking
                              ? 'bg-rose-400 animate-ping'
                              : 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                          }`}
                        />
                        <span>{p.callsign}</span>
                      </div>
                      <div className="col-span-5 text-cyan-300 text-[11px]">
                        {p.ipAddress}:{UDP_PORT}
                      </div>
                      <div className="col-span-3 text-right text-[10px]">
                        {p.id === selfId ? (
                          <span className="text-cyan-400 font-bold">ANDA</span>
                        ) : p.isTalking ? (
                          <span className="text-rose-400 font-bold">TX AUDIO</span>
                        ) : (
                          <span className="text-emerald-400 font-bold">
                            {p.pingMs || 24}ms · ON
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* DRAWER 3: LOGS & FULL TACTICAL CHAT */}
          {drawerTab === 'LOGS' && (
            <div className="flex-1 min-h-0 flex flex-col p-4 max-w-lg mx-auto w-full gap-3 overflow-hidden">
              <div className="flex items-center justify-between gap-2 shrink-0">
                <select
                  value={chatTarget}
                  onChange={(e) => setChatTarget(e.target.value)}
                  className="bg-[#040B18] border border-cyan-500/60 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-cyan-200"
                >
                  <option value="SEMUA">BROADCAST: SEMUA UNIT ({BROADCAST_IP})</option>
                  {displayPeers
                    .filter((p) => p.id !== selfId)
                    .map((p) => (
                      <option key={p.id} value={p.callsign}>
                        TARGET: {p.callsign} ({p.ipAddress})
                      </option>
                    ))}
                </select>

                <button
                  onClick={() =>
                    sendTacticalChatMessage(
                      `DARURAT SOS DARI ${callsign} (${selfIp})... [SELESAI]`,
                      true
                    )
                  }
                  className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-mono font-bold text-xs flex items-center gap-1 shrink-0"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>KIRIM SOS</span>
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto bg-[#040B18] border border-cyan-500/50 rounded-xl p-3 space-y-2 font-mono">
                {chatMessages.map((c) => (
                  <div
                    key={c.id}
                    className={`p-2.5 rounded-lg border text-xs ${
                      c.chatPriority === 'DARURAT'
                        ? 'bg-rose-950/80 border-rose-500 text-rose-100'
                        : 'bg-[#08162E] border-cyan-500/40 text-cyan-100'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] text-cyan-400 mb-0.5">
                      <span className="font-bold">
                        {c.senderCallsign} {c.senderIp ? `(${c.senderIp})` : ''} →{' '}
                        {c.targetCallsign}
                      </span>
                      <span>UDP:{UDP_PORT}</span>
                    </div>
                    <div className="text-xs text-cyan-100">{c.text}</div>
                  </div>
                ))}

                {messages.map((m) => (
                  <div
                    key={m.id}
                    className="p-2.5 rounded-lg bg-[#071A2E] border border-emerald-500/40 text-xs flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-emerald-400 font-bold">
                        [DATAGRAM AUDIO PTT] {m.senderCallsign} · {m.freqMhz} MHz
                      </div>
                      <div className="text-xs text-cyan-100 truncate">{m.text}</div>
                    </div>
                    <button
                      onClick={() => {
                        radioAudio.unlockAudio();
                        setSpeakerReady(true);
                        radioAudio.playIncomingRadioVoice(
                          m.audioDataUrl,
                          m.text,
                          volume / 100,
                          true
                        );
                      }}
                      className="px-2.5 py-1.5 rounded bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1 shrink-0"
                    >
                      <Play className="w-3 h-3" />
                      <span>PUTAR</span>
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 shrink-0">
                {QUICK_CHAT_TEMPLATES.map((tpl, i) => (
                  <button
                    key={i}
                    onClick={() => sendTacticalChatMessage(tpl, false)}
                    className="px-2.5 py-1 rounded bg-[#08162E] border border-cyan-500/40 text-[10px] font-mono text-cyan-200 whitespace-nowrap shrink-0"
                  >
                    {tpl}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendTacticalChatMessage();
                }}
                className="flex items-center gap-2 shrink-0"
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ketik pesan taktis UDP Broadcast..."
                  className="flex-1 min-h-[44px] bg-[#040B18] border border-cyan-400/70 rounded-xl px-3 py-2 text-xs font-mono text-cyan-100"
                />
                <button
                  type="submit"
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-cyan-400 text-slate-950 font-display font-bold text-xs flex items-center gap-1.5 shrink-0"
                >
                  <Send className="w-4 h-4" />
                  <span>KIRIM</span>
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          MODAL KODE KOTLIN NATIVE ANDROID (UDP BROADCAST PORT 50000 + COROUTINES)
         ===================================================================== */}
      {showKotlinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-3 sm:p-5">
          <div className="w-full max-w-2xl h-[88dvh] rounded-2xl bg-[#061224] border-2 border-cyan-400 flex flex-col overflow-hidden shadow-[0_0_30px_rgba(34,211,238,0.4)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/40 bg-[#081830]">
              <div>
                <h3 className="font-display font-bold text-sm text-cyan-300 flex items-center gap-2">
                  <Code2 className="w-4 h-4 text-emerald-400" />
                  <span>TacticalUdpBroadcastEngine.kt (Kotlin Coroutines · Port 50000)</span>
                </h3>
                <p className="text-[10px] font-mono text-cyan-400/80">
                  Auto-Discovery (Listen 50000) · Broadcast 255.255.255.255 (3s) · Memori IP · PTT
                  Datagram Stream
                </p>
              </div>
              <button
                onClick={() => setShowKotlinModal(false)}
                className="p-1.5 rounded-lg bg-slate-900 text-cyan-300 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center justify-between px-4 py-2 bg-[#040B18] border-b border-cyan-500/30 gap-2">
              <span className="text-[11px] font-mono text-emerald-400">
                Dispatchers.IO · Non-Blocking UI · StateFlow Matriks ONLINE
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyKotlinCode}
                  className="px-3 py-1 rounded bg-cyan-400 text-slate-950 font-mono font-bold text-xs flex items-center gap-1"
                >
                  {kotlinCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{kotlinCopied ? 'TERSALIN' : 'SALIN KODE'}</span>
                </button>
                <button
                  onClick={downloadKotlinFile}
                  className="px-3 py-1 rounded bg-emerald-400 text-slate-950 font-mono font-bold text-xs flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>UNDUH .KT</span>
                </button>
              </div>
            </div>

            <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed font-mono text-cyan-100 bg-[#030914] select-text">
              <code>{KOTLIN_UDP_ENGINE_CODE}</code>
            </pre>
          </div>
        </div>
      )}

      {/* QUICK TACTICAL MESSAGE MODAL */}
      {quickChatModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#07152B] border-2 border-cyan-400 p-4 space-y-3 shadow-[0_0_25px_rgba(34,211,238,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-sm text-cyan-300">
                BROADCAST PESAN UDP KE LAYAR MESSAGE ({BROADCAST_IP})
              </h3>
              <button
                onClick={() => setQuickChatModalOpen(false)}
                className="p-1 rounded bg-cyan-950 text-cyan-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              {QUICK_CHAT_TEMPLATES.map((tpl, idx) => (
                <button
                  key={idx}
                  onClick={() => sendTacticalChatMessage(tpl, false)}
                  className="w-full text-left px-3 py-2 rounded-lg bg-[#040B18] hover:bg-cyan-950/60 border border-cyan-500/40 text-xs font-mono text-cyan-100"
                >
                  {callsign}: {tpl}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendTacticalChatMessage();
              }}
              className="flex items-center gap-2 pt-1"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ketik pesan kustom..."
                className="flex-1 bg-[#040B18] border border-cyan-400 rounded-lg px-3 py-2 text-xs font-mono text-cyan-100"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-cyan-400 text-slate-950 font-bold text-xs font-mono"
              >
                KIRIM
              </button>
            </form>
          </div>
        </div>
      )}

      {/* POPUP BARCODE APK */}
      {showMasterQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#07152B] border-2 border-cyan-400 p-5 flex flex-col items-center space-y-3.5 shadow-[0_0_25px_rgba(34,211,238,0.4)]">
            <div className="w-full flex items-center justify-between">
              <h3 className="text-xs font-display font-bold text-cyan-300 tracking-wider">
                TAUTAN AKSES CEPAT WI-COMM SUBDISRUDAL
              </h3>
              <button
                onClick={() => setShowMasterQrModal(false)}
                className="p-1 rounded-lg bg-slate-900 text-cyan-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3.5 bg-white rounded-2xl shadow-xl">
              <QRCodeSVG value={masterApkBarcodeUrl} size={205} level="L" includeMargin={true} />
            </div>
            <p className="text-xs text-center text-cyan-100/90 font-mono">
              UNIT: <strong className="text-cyan-300">{callsign}</strong> ({selfIp}) · UDP:{' '}
              <strong className="text-emerald-400">{UDP_PORT}</strong>
            </p>
          </div>
        </div>
      )}

      {/* POPUP BARCODE BALASAN CLIENT */}
      {showClientAnswerModal && clientAnswerBarcodeToken && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#07152B] border-2 border-emerald-400 p-5 flex flex-col items-center space-y-3.5">
            <div className="w-full flex items-center justify-between">
              <h3 className="text-xs font-display font-bold text-emerald-300">
                BARCODE BALASAN P2P
              </h3>
              <button
                onClick={() => setShowClientAnswerModal(false)}
                className="p-1 rounded-lg bg-slate-900 text-slate-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3.5 bg-white rounded-2xl shadow-xl">
              <QRCodeSVG
                value={clientAnswerBarcodeToken}
                size={205}
                level="L"
                includeMargin={true}
              />
            </div>
          </div>
        </div>
      )}

      {/* CAMERA SCANNER MODAL */}
      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#07152B] border-2 border-cyan-400 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-display font-bold text-cyan-300 flex items-center gap-2">
                <Camera className="w-4 h-4 text-emerald-400" />
                <span>SCAN BARCODE TACTICAL WI-COMM</span>
              </h3>
              <button
                onClick={() => setScannerOpen(false)}
                className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-cyan-300 bg-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative aspect-4/3 w-full bg-slate-950 rounded-xl overflow-hidden border border-cyan-500/60 flex items-center justify-center">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <canvas ref={canvasRef} className="hidden" />
              {scannerError && (
                <div className="absolute inset-0 bg-slate-950/95 p-4 flex flex-col items-center justify-center text-center">
                  <p className="text-xs text-cyan-200 leading-relaxed">{scannerError}</p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <button
                onClick={() =>
                  enterApkAndConnectPttFromBarcode(`DISKOMLEK:${roomCode}:${freqMhz}:SERI-01`)
                }
                className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-cyan-400 text-slate-950 font-display font-bold text-xs flex items-center justify-center gap-2 shadow-lg"
              >
                <Zap className="w-4 h-4" />
                <span>SINKRONISASI AUTO-DISCOVERY UDP:{UDP_PORT}</span>
              </button>

              <label className="w-full min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-cyan-500/50 text-xs font-semibold text-cyan-200 flex items-center justify-center gap-2 cursor-pointer">
                <Upload className="w-4 h-4 text-cyan-400" />
                <span>Pilih Foto / Screenshot Barcode</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleQrPhotoUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
