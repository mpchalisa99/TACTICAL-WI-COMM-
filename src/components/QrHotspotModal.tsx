import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';
import {
  Wifi,
  QrCode,
  Camera,
  ShieldCheck,
  CheckCircle2,
  Copy,
  Upload,
  Zap,
  X,
  Radio,
  Smartphone,
  RefreshCw,
} from 'lucide-react';
import { MasterHotspotConfig, QrPairingPayload, TACTICAL_CHANNELS } from '../types/tactical';
import { radioAudio } from '../utils/radioAudio';

interface QrHotspotModalProps {
  isOpen: boolean;
  initialTab: 'MASTER_QR' | 'CLIENT_SCAN';
  onClose: () => void;
  masterConfig: MasterHotspotConfig;
  localIps: string[];
  onSaveMasterConfig: (cfg: Partial<MasterHotspotConfig>) => void;
  onClientPairedByQr: (payload: QrPairingPayload) => void;
}

export const QrHotspotModal: React.FC<QrHotspotModalProps> = ({
  isOpen,
  initialTab,
  onClose,
  masterConfig,
  localIps,
  onSaveMasterConfig,
  onClientPairedByQr,
}) => {
  const [activeTab, setActiveTab] = useState<'MASTER_QR' | 'CLIENT_SCAN'>(initialTab);
  const [qrStep, setQrStep] = useState<'HT_PAIR' | 'WIFI_AUTO'>('HT_PAIR');

  // Form states for Master Hotspot Config
  const [ssid, setSsid] = useState(masterConfig.ssid);
  const [password, setPassword] = useState(masterConfig.password);
  const [masterIp, setMasterIp] = useState(masterConfig.masterIp || '192.168.43.1');
  const [selectedChannelCode, setSelectedChannelCode] = useState(masterConfig.channel);
  const [netCode, setNetCode] = useState(masterConfig.netCode);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Camera Scanner states for Client
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanSuccessMsg, setScanSuccessMsg] = useState<string | null>(null);
  const [manualQrInput, setManualQrInput] = useState('');

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  useEffect(() => {
    setSsid(masterConfig.ssid);
    setPassword(masterConfig.password);
    setMasterIp(masterConfig.masterIp || '192.168.43.1');
    setSelectedChannelCode(masterConfig.channel);
    setNetCode(masterConfig.netCode);
  }, [masterConfig]);

  const currentChannelObj =
    TACTICAL_CHANNELS.find((c) => c.code === selectedChannelCode) || TACTICAL_CHANNELS[0];

  // Build standard Android Wi-Fi Auto-Connect QR string (Zero Internet required)
  const wifiQrString = `WIFI:S:${ssid};T:WPA;P:${password};H:false;;`;

  // Build DISKOMLEKAU Tactical HT Pairing QR payload
  const pairingPayload: QrPairingPayload = {
    proto: 'DISKOMLEKAU-HT-V1',
    ssid,
    pass: password,
    ip: masterIp,
    port: masterConfig.port || 3000,
    ch: currentChannelObj.code,
    freq: currentChannelObj.freqMhz,
    net: netCode,
    enc: masterConfig.encryptionKey,
    master: masterConfig.masterCallsign,
    wsUrl: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws-tactical`,
  };

  const htPairingQrString = JSON.stringify(pairingPayload);

  // Handle Camera lifecycle when on CLIENT_SCAN tab
  useEffect(() => {
    if (!isOpen || activeTab !== 'CLIENT_SCAN') {
      stopCamera();
      return;
    }

    startCamera();
    return () => {
      stopCamera();
    };
  }, [isOpen, activeTab]);

  const startCamera = async () => {
    setCameraError(null);
    setScanSuccessMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        setCameraActive(true);
      }
    } catch {
      setCameraActive(false);
      setCameraError(
        'Kamera tidak dapat diakses di peramban ini. Gunakan tombol Unggah Foto Barcode atau Sambung Instan ke Master di bawah.'
      );
    }
  };

  const stopCamera = () => {
    setCameraActive(false);
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
  };

  // Continuous offline frame decoding via jsQR
  useEffect(() => {
    if (!cameraActive || activeTab !== 'CLIENT_SCAN' || !isOpen) return;

    let animId: number;
    const scanFrame = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code && code.data) {
            handleDecodedQrString(code.data);
            return;
          }
        }
      }
      animId = requestAnimationFrame(scanFrame);
    };

    animId = requestAnimationFrame(scanFrame);
    return () => cancelAnimationFrame(animId);
  }, [cameraActive, activeTab, isOpen]);

  const handleDecodedQrString = (rawString: string) => {
    try {
      // Case 1: DISKOMLEKAU JSON Barcode
      if (rawString.includes('DISKOMLEKAU-HT-V1')) {
        const parsed = JSON.parse(rawString) as QrPairingPayload;
        radioAudio.playBarcodeLockConfirm();
        setScanSuccessMsg(
          `TERKUNCI KE MASTER ${parsed.master} · ${parsed.freq} MHz (${parsed.ch}) · SSID: ${parsed.ssid}`
        );
        stopCamera();
        setTimeout(() => {
          onClientPairedByQr(parsed);
          onClose();
        }, 900);
        return;
      }

      // Case 2: Standard Android Wi-Fi QR (WIFI:S:SSID;T:WPA;P:PASS;;)
      if (rawString.startsWith('WIFI:')) {
        const ssidMatch = rawString.match(/S:([^;]+);/);
        const passMatch = rawString.match(/P:([^;]+);/);
        const extractedSsid = ssidMatch ? ssidMatch[1] : masterConfig.ssid;
        const extractedPass = passMatch ? passMatch[1] : masterConfig.password;

        const synthesized: QrPairingPayload = {
          ...pairingPayload,
          ssid: extractedSsid,
          pass: extractedPass,
        };
        radioAudio.playBarcodeLockConfirm();
        setScanSuccessMsg(
          `HOTSPOT WI-FI TERDETEKSI (${extractedSsid}) · MENYAMBUNGKAN KE KANAL ${synthesized.freq} MHz`
        );
        stopCamera();
        setTimeout(() => {
          onClientPairedByQr(synthesized);
          onClose();
        }, 900);
        return;
      }
    } catch {
      // Ignore invalid JSON
    }
  };

  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          handleDecodedQrString(code.data);
        } else {
          setCameraError('Barcode tidak terbaca pada gambar. Pastikan gambar QR terlihat jelas.');
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleApplyMasterSettings = () => {
    onSaveMasterConfig({
      ssid,
      password,
      masterIp,
      channel: currentChannelObj.code,
      freqMhz: currentChannelObj.freqMhz,
      netCode,
    });
    radioAudio.playBarcodeLockConfirm();
    setCopiedText('Konfigurasi Master Posko Diperbarui');
    setTimeout(() => setCopiedText(null), 2000);
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-[#0F172A] border border-slate-800 shadow-2xl overflow-hidden my-auto">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0B111E]">
          <div className="flex items-center gap-3">
            <QrCode className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <h2 className="text-base font-bold text-slate-100 tracking-wide">
                Pairing Jaring Hotspot & Barcode Offline
              </h2>
              <p className="text-xs text-slate-400">
                Koneksi langsung antar HP Android via Wi-Fi Tethering lokal tanpa kuota internet
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Tutup"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switch Tabs */}
        <div className="grid grid-cols-2 gap-2 p-3 bg-[#0B111E]/60 border-b border-slate-800">
          <button
            onClick={() => setActiveTab('MASTER_QR')}
            className={`min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'MASTER_QR'
                ? 'bg-amber-500 text-slate-950 shadow-sm'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Wifi className="w-4 h-4 shrink-0" />
            <span>1. HP Master (Buka Hotspot & QR)</span>
          </button>
          <button
            onClick={() => setActiveTab('CLIENT_SCAN')}
            className={`min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'CLIENT_SCAN'
                ? 'bg-emerald-500 text-slate-950 shadow-sm'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Camera className="w-4 h-4 shrink-0" />
            <span>2. HP Client (Scan Barcode Master)</span>
          </button>
        </div>

        {/* Body Content */}
        {activeTab === 'MASTER_QR' ? (
          <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: QR Code Display */}
            <div className="lg:col-span-5 flex flex-col items-center bg-[#0B111E] border border-slate-800 rounded-xl p-5">
              {/* Segmented Toggle for QR Type */}
              <div className="w-full grid grid-cols-2 gap-1 p-1 bg-slate-900 rounded-lg mb-4">
                <button
                  onClick={() => setQrStep('HT_PAIR')}
                  className={`py-2 px-2 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                    qrStep === 'HT_PAIR'
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  QR Kanal HT (Langkah 2)
                </button>
                <button
                  onClick={() => setQrStep('WIFI_AUTO')}
                  className={`py-2 px-2 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                    qrStep === 'WIFI_AUTO'
                      ? 'bg-sky-400 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  QR Wi-Fi Hotspot (Langkah 1)
                </button>
              </div>

              {/* Crisp SVG QR Code on White High-Contrast Pad for Reliable Field Scanning */}
              <div className="p-4 bg-white rounded-xl shadow-md">
                <QRCodeSVG
                  value={qrStep === 'HT_PAIR' ? htPairingQrString : wifiQrString}
                  size={200}
                  level="M"
                  includeMargin={false}
                />
              </div>

              <div className="mt-4 text-center">
                <p className="text-xs font-semibold text-slate-200">
                  {qrStep === 'HT_PAIR'
                    ? 'Barcode Sinkronisasi Frekuensi & Jaring HT'
                    : 'Barcode Koneksi Otomatis Wi-Fi Hotspot Android'}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {qrStep === 'HT_PAIR'
                    ? 'Scan dari tab "HP Client" di aplikasi ini untuk langsung masuk ke frekuensi Master.'
                    : 'Scan dengan Kamera bawaan HP Client untuk otomatis tersambung ke Wi-Fi Hotspot Master.'}
                </p>
              </div>

              <div className="w-full mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 font-mono">
                <span>SSID: {ssid}</span>
                <span>·</span>
                <span className="text-amber-400 font-semibold">{currentChannelObj.freqMhz} MHz</span>
              </div>
            </div>

            {/* Right Column: Master Hotspot Settings & Field Instructions */}
            <div className="lg:col-span-7 space-y-4">
              <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">
                    Parameter Hotspot Posko Master (Tanpa Internet)
                  </h3>
                  <span className="text-xs font-mono text-amber-400">
                    IP: {masterIp}:{masterConfig.port}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Nama Hotspot Wi-Fi (SSID HP Master)
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={ssid}
                        onChange={(e) => setSsid(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={() => copyToClipboard(ssid, 'SSID Tersalin')}
                        className="px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300"
                        title="Salin SSID"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Sandi Hotspot WPA2
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={() => copyToClipboard(password, 'Sandi Tersalin')}
                        className="px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300"
                        title="Salin Sandi"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Kanal & Frekuensi Operasi
                    </label>
                    <select
                      value={selectedChannelCode}
                      onChange={(e) => setSelectedChannelCode(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                    >
                      {TACTICAL_CHANNELS.map((ch) => (
                        <option key={ch.id} value={ch.code}>
                          {ch.freqMhz} MHz — {ch.code}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      IP Gateway Hotspot Master
                    </label>
                    <select
                      value={masterIp}
                      onChange={(e) => setMasterIp(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                    >
                      <option value="192.168.43.1">192.168.43.1 (Standar Hotspot Android)</option>
                      <option value="192.168.234.1">192.168.234.1 (Android 13+ Tethering)</option>
                      {localIps.map((ip) => (
                        <option key={ip} value={ip}>
                          {ip} (IP LAN Terdeteksi)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-between gap-3">
                  {copiedText ? (
                    <span className="text-xs text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      {copiedText}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">
                      Enkripsi Jaring: {masterConfig.encryptionKey}
                    </span>
                  )}
                  <button
                    onClick={handleApplyMasterSettings}
                    className="min-h-[40px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs flex items-center gap-2 transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Perbarui Barcode Master
                  </button>
                </div>
              </div>

              {/* Prosedur Lapangan Tanpa Internet */}
              <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-2">
                <h4 className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-amber-400" />
                  SOP Mengubah HP Android Jadi Master HT (0% Internet)
                </h4>
                <ol className="text-xs text-slate-300 space-y-1.5 list-decimal list-inside leading-relaxed">
                  <li>
                    Matikan Data Seluler di HP Master, lalu nyalakan{' '}
                    <strong className="text-amber-300">Hotspot Pribadi / Tethering Wi-Fi</strong>{' '}
                    dengan SSID <code className="font-mono text-slate-100">{ssid}</code>.
                  </li>
                  <li>
                    Anggota regu (Client) melakukan scan <strong>QR Wi-Fi Hotspot</strong> agar HP
                    mereka langsung tersambung ke Wi-Fi Master tanpa mengetik password.
                  </li>
                  <li>
                    Anggota regu membuka aplikasi HT ini lalu scan{' '}
                    <strong>QR Kanal HT</strong> untuk mengunci frekuensi{' '}
                    <code className="font-mono text-emerald-400">{currentChannelObj.freqMhz} MHz</code>{' '}
                    dan mulai berkomunikasi Push-To-Talk (PTT).
                  </li>
                </ol>
              </div>
            </div>
          </div>
        ) : (
          /* TAB 2: CLIENT BARCODE SCANNER */
          <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Live Camera Viewfinder */}
            <div className="lg:col-span-6 flex flex-col items-center bg-[#0B111E] border border-slate-800 rounded-xl p-4">
              <div className="relative w-full aspect-4/3 bg-slate-950 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  muted
                  playsInline
                />
                <canvas ref={canvasRef} className="hidden" />

                {/* Optical Target Reticle Overlay */}
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-8">
                  <div className="w-48 h-48 border-2 border-emerald-400/80 rounded-2xl relative">
                    <div className="absolute inset-x-2 top-1/2 h-0.5 bg-emerald-400/60" />
                  </div>
                </div>

                {!cameraActive && !scanSuccessMsg && (
                  <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-6 text-center">
                    <Camera className="w-8 h-8 text-slate-400 mb-2" />
                    <p className="text-xs text-slate-300 max-w-xs">
                      {cameraError || 'Mengaktifkan kamera pemindai barcode optik offline...'}
                    </p>
                    <button
                      onClick={startCamera}
                      className="mt-3 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
                    >
                      Coba Buka Kamera Lagi
                    </button>
                  </div>
                )}

                {scanSuccessMsg && (
                  <div className="absolute inset-0 bg-emerald-950/95 flex flex-col items-center justify-center p-6 text-center">
                    <CheckCircle2 className="w-12 h-12 text-emerald-400 mb-3" />
                    <p className="text-sm font-bold text-emerald-200">BARCODE MASTER TERVERIFIKASI</p>
                    <p className="text-xs font-mono text-emerald-300 mt-1">{scanSuccessMsg}</p>
                  </div>
                )}
              </div>

              <div className="w-full mt-3 flex items-center justify-between gap-2">
                <label className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-2 cursor-pointer transition-colors">
                  <Upload className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>Unggah Foto QR</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileUpload}
                    className="hidden"
                  />
                </label>

                <button
                  onClick={() => handleDecodedQrString(htPairingQrString)}
                  className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition-colors"
                >
                  <Zap className="w-4 h-4 shrink-0" />
                  <span>Simulasi Scan Master</span>
                </button>
              </div>
            </div>

            {/* Right Column: Instant Pairing Details & Manual Code Fallback */}
            <div className="lg:col-span-6 space-y-4">
              <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <ShieldCheck className="w-5 h-5 shrink-0" />
                  <h3 className="text-sm font-semibold text-slate-100">
                    Koneksi Otomatis Client ke Master
                  </h3>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Arahkan kamera HP Client ke layar QR HP Master. Sistem pemindai bekerja{' '}
                  <strong>100% secara lokal di perangkat (offline)</strong> tanpa mengirim gambar ke
                  internet.
                </p>

                <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-1.5 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Target Posko Master:</span>
                    <span className="text-slate-200">{masterConfig.masterCallsign}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Hotspot SSID:</span>
                    <span className="text-amber-400">{masterConfig.ssid}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Frekuensi Tujuan:</span>
                    <span className="text-emerald-400">
                      {masterConfig.freqMhz} MHz ({masterConfig.channel})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Sandi Jaring:</span>
                    <span className="text-sky-400">{masterConfig.netCode}</span>
                  </div>
                </div>

                {/* Manual Paste Barcode Payload if needed */}
                <div className="pt-2">
                  <label className="block text-xs text-slate-400 mb-1">
                    Atau Tempel String Barcode / Kode Sandi Master:
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualQrInput}
                      onChange={(e) => setManualQrInput(e.target.value)}
                      placeholder="Tempel payload barcode atau ketik SANDI-CAKRA-26"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      onClick={() => {
                        if (manualQrInput.trim().startsWith('{')) {
                          handleDecodedQrString(manualQrInput.trim());
                        } else {
                          handleDecodedQrString(htPairingQrString);
                        }
                      }}
                      className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-400 whitespace-nowrap"
                    >
                      Konek
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Radio className="w-5 h-5 text-amber-400 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-slate-200">
                      Uji Koneksi Cepat di Perangkat Ini
                    </p>
                    <p className="text-xs text-slate-400">
                      Klik &ldquo;Simulasi Scan Master&rdquo; untuk langsung mengunci frekuensi Posko.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
