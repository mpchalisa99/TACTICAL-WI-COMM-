export interface TacticalChannelPreset {
  id: string;
  code: string;
  name: string;
  freqMhz: string;
  bandwidth: string;
  squelchLevel: number;
  description: string;
}

export interface TacticalPeerInfo {
  id: string;
  callsign: string;
  role: 'MASTER' | 'CLIENT';
  unit: string;
  channel: string;
  freqMhz: string;
  battery: number;
  lat?: number;
  lng?: number;
  isTalking: boolean;
  joinedAt: number;
  lastSeen: number;
}

export interface TacticalMessage {
  id: string;
  senderId: string;
  senderCallsign: string;
  senderRole: 'MASTER' | 'CLIENT';
  channel: string;
  freqMhz: string;
  type: 'VOICE_PTT' | 'BREVET_TEXT' | 'SOS_ALERT' | 'COORDS_PIN';
  text?: string;
  audioDataUrl?: string;
  durationSec?: number;
  lat?: number;
  lng?: number;
  timestamp: number;
}

export interface MasterHotspotConfig {
  ssid: string;
  password: string;
  security: 'WPA' | 'nopass';
  masterIp: string;
  port: number;
  channel: string;
  freqMhz: string;
  netCode: string;
  encryptionKey: string;
  masterCallsign: string;
  updatedAt: number;
}

export interface QrPairingPayload {
  proto: 'DISKOMLEKAU-HT-V1';
  ssid: string;
  pass: string;
  ip: string;
  port: number;
  ch: string;
  freq: string;
  net: string;
  enc: string;
  master: string;
  wsUrl: string;
}

export const TACTICAL_CHANNELS: TacticalChannelPreset[] = [
  {
    id: 'CH-01',
    code: 'CH-01 KOMANDO UTAMA',
    name: 'Jaring Komando Posko',
    freqMhz: '142.850',
    bandwidth: '12.5 kHz VHF',
    squelchLevel: 3,
    description: 'Frekuensi utama komando taktis & koordinasi induk Diskomlekau.',
  },
  {
    id: 'CH-02',
    code: 'CH-02 TAKTIS REGU A',
    name: 'Patroli & Pengamanan',
    freqMhz: '143.125',
    bandwidth: '12.5 kHz VHF',
    squelchLevel: 4,
    description: 'Kanal komunikasi taktis pergerakan regu lapangan & perimeter.',
  },
  {
    id: 'CH-03',
    code: 'CH-03 LOGISTIK & HAR',
    name: 'Dukungan Pemeliharaan Alkom',
    freqMhz: '143.550',
    bandwidth: '25.0 kHz VHF',
    squelchLevel: 2,
    description: 'Koordinasi teknisi elektronika, radar, dan perbekalan lapangan.',
  },
  {
    id: 'CH-04',
    code: 'CH-04 SAR & MEDEVAC',
    name: 'Siaga Darurat & Evakuasi',
    freqMhz: '140.100',
    bandwidth: '25.0 kHz VHF',
    squelchLevel: 1,
    description: 'Jaring prioritas darurat medis, cuaca ekstrem, dan penyelamatan.',
  },
];
