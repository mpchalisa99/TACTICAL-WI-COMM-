import React, { useState } from 'react';
import {
  Download,
  Smartphone,
  Terminal,
  FileCode,
  CheckCircle2,
  X,
  Shield,
  Wifi,
  Copy,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { MasterHotspotConfig } from '../types/tactical';

interface AndroidApkModalProps {
  isOpen: boolean;
  onClose: () => void;
  masterConfig: MasterHotspotConfig;
}

export const AndroidApkModal: React.FC<AndroidApkModalProps> = ({
  isOpen,
  onClose,
  masterConfig,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [activeSubTab, setActiveSubTab] = useState<'PWA_APK' | 'KOTLIN_SRC' | 'TERMUX_HOST'>('PWA_APK');
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const kotlinUdpMulticastSource = `// ============================================================================
// DISKOMLEKAU TACTICAL HT OFFLINE - ANDROID NATIVE ENGINE (KOTLIN)
// Arsitektur: Wi-Fi Hotspot LocalOnly / Tethering + UDP Multicast (Zero-Server)
// ============================================================================
package id.mil.tni_au.diskomlek.tacticalht

import android.content.Context
import android.media.*
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.ConnectivityManager
import android.net.NetworkRequest
import android.os.Build
import kotlinx.coroutines.*
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket

class TacticalHtMulticastEngine(private val context: Context) {
    companion object {
        // Alamat Multicast LAN Lokal (Bekerja di Hotspot Android Tanpa Internet)
        const val MULTICAST_GROUP_IP = "239.255.43.1"
        const val AUDIO_PORT = 50004
        const val SAMPLE_RATE = 8000 // 8kHz Tactical Voice Narrowband
    }

    private var isTransmitting = false
    private var isListening = false
    private var multicastLock: WifiManager.MulticastLock? = null

    // 1. KONEKSI OTOMATIS CLIENT KE HOTSPOT MASTER HASIL SCAN BARCODE QR
    fun connectToMasterHotspotFromQr(ssid: String, pass: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val specifier = WifiNetworkSpecifier.Builder()
                .setSsid(ssid)
                .setWpa2Passphrase(pass)
                .build()

            val request = NetworkRequest.Builder()
                .addTransportType( android.net.NetworkCapabilities.TRANSPORT_WIFI )
                .removeCapability( android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET ) // TANPA INTERNET!
                .setNetworkSpecifier(specifier)
                .build()

            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.requestNetwork(request, object : ConnectivityManager.NetworkCallback() {})
        }
    }

    // 2. PENERIMA SUARA RADIO (RX) VIA UDP MULTICAST DI HOTSPOT LOKAL
    fun startRxReceiver(scope: CoroutineScope) {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("DiskomlekTacticalLock").apply {
            setReferenceCounted(true)
            acquire()
        }

        isListening = true
        scope.launch(Dispatchers.IO) {
            val socket = MulticastSocket(AUDIO_PORT)
            val group = InetAddress.getByName(MULTICAST_GROUP_IP)
            socket.joinGroup(group)

            val minBuf = AudioTrack.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val player = AudioTrack(
                AudioManager.STREAM_MUSIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf,
                AudioTrack.MODE_STREAM
            )
            player.play()

            val buf = ByteArray(640)
            while (isListening) {
                val packet = DatagramPacket(buf, buf.size)
                socket.receive(packet)
                if (!isTransmitting) {
                    player.write(packet.data, 0, packet.length)
                }
            }
        }
    }

    // 3. PEMANCAR SUARA PUSH-TO-TALK (TX) SAAT TOMBOL PTT DITEKAN
    fun startTxPushToTalk(scope: CoroutineScope) {
        isTransmitting = true
        scope.launch(Dispatchers.IO) {
            val socket = MulticastSocket()
            val group = InetAddress.getByName(MULTICAST_GROUP_IP)
            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf
            )
            val buffer = ByteArray(640)
            recorder.startRecording()

            while (isTransmitting) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) {
                    val packet = DatagramPacket(buffer, read, group, AUDIO_PORT)
                    socket.send(packet)
                }
            }
            recorder.stop()
            recorder.release()
            socket.close()
        }
    }

    fun stopTxPushToTalk() {
        isTransmitting = false
    }
}`;

  const termuxHostScript = `#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# SKRIP POSKO MASTER HT DISKOMLEKAU (JALANKAN DI HP ANDROID MASTER)
# Prasyarat: Hidupkan Hotspot Wi-Fi HP Master (Tanpa Kuota / Mode Offline)
# ============================================================================
echo "=== MEMULAI SERVER POSKO HT OFFLINE DISKOMLEKAU ==="
echo "SSID Hotspot : ${masterConfig.ssid}"
echo "Frekuensi    : ${masterConfig.freqMhz} MHz (${masterConfig.channel})"
echo "IP Gateway   : 192.168.43.1:3000"
echo "Buka di HP Client dengan Scan QR Barcode Master!"
npx tsx server.ts`;

  const downloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedNotice(label);
    setTimeout(() => setCopiedNotice(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-[#0F172A] border border-slate-800 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0B111E]">
          <div className="flex items-center gap-3">
            <Smartphone className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <h2 className="text-base font-bold text-slate-100">
                Instalasi APK Offline & Modul Jaring Hotspot Android
              </h2>
              <p className="text-xs text-slate-400">
                Pasang aplikasi HT ke layar utama HP Android atau unduh modul Native UDP Multicast
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sub-navigation */}
        <div className="grid grid-cols-3 gap-2 p-3 bg-[#0B111E]/60 border-b border-slate-800">
          <button
            onClick={() => setActiveSubTab('PWA_APK')}
            className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeSubTab === 'PWA_APK'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Smartphone className="w-4 h-4 shrink-0" />
            <span>Instal Aplikasi (PWA Offline)</span>
          </button>
          <button
            onClick={() => setActiveSubTab('KOTLIN_SRC')}
            className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeSubTab === 'KOTLIN_SRC'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <FileCode className="w-4 h-4 shrink-0" />
            <span>Kode APK Native (UDP Multicast)</span>
          </button>
          <button
            onClick={() => setActiveSubTab('TERMUX_HOST')}
            className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeSubTab === 'TERMUX_HOST'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Terminal className="w-4 h-4 shrink-0" />
            <span>Server Lokal HP Master</span>
          </button>
        </div>

        <div className="p-6">
          {activeSubTab === 'PWA_APK' && (
            <div className="space-y-4">
              <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-bold text-slate-100">
                      DISKOMLEKAU Tactical HT Standalone (Offline-Ready)
                    </h3>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed max-w-xl">
                    Aplikasi ini sudah dilengkapi <strong>Service Worker Workbox Offline</strong>.
                    Setelah dipasang ke HP Android, seluruh antarmuka HT, synthesizer radio, dan
                    pemindai barcode kamera berjalan <strong>100% tanpa internet</strong>.
                  </p>
                </div>

                {isInstalled ? (
                  <div className="px-4 py-2.5 rounded-xl bg-emerald-950/80 border border-emerald-700/60 text-emerald-300 text-xs font-semibold flex items-center gap-2 shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Terpasang di Perangkat</span>
                  </div>
                ) : isInstallable ? (
                  <button
                    onClick={install}
                    className="min-h-[44px] px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2 shrink-0 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    <span>Pasang ke HP Android Sekarang</span>
                  </button>
                ) : (
                  <div className="px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-medium shrink-0">
                    {isIOS
                      ? 'Safari: Ketuk Bagikan → Tambah ke Layar Utama'
                      : 'Menu Chrome (⋮) → Tambahkan ke Layar Utama / Instal Aplikasi'}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-1.5">
                  <div className="text-xs font-mono text-amber-400">TAHAP 01</div>
                  <h4 className="text-sm font-semibold text-slate-100">Hidupkan Hotspot Master</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Satu personel mengaktifkan Wi-Fi Hotspot di HP Android tanpa perlu menyalakan
                    paket data seluler.
                  </p>
                </div>
                <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-1.5">
                  <div className="text-xs font-mono text-sky-400">TAHAP 02</div>
                  <h4 className="text-sm font-semibold text-slate-100">Scan Barcode Otomatis</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Anggota regu memindai Barcode Wi-Fi & Kanal HT di layar Master untuk otomatis
                    tersambung ke frekuensi yang sama.
                  </p>
                </div>
                <div className="bg-[#0B111E] border border-slate-800 rounded-xl p-4 space-y-1.5">
                  <div className="text-xs font-mono text-emerald-400">TAHAP 03</div>
                  <h4 className="text-sm font-semibold text-slate-100">Push-To-Talk (PTT)</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Tekan dan tahan tombol PTT besar untuk memancarkan suara jernih dengan filter
                    radio VHF & Roger Beep.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === 'KOTLIN_SRC' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    Modul Native Android Studio (`TacticalHtMulticastEngine.kt`)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Menggunakan <code className="font-mono text-amber-300">WifiNetworkSpecifier</code>{' '}
                    (tanpa internet) + <code className="font-mono text-emerald-300">MulticastSocket UDP 239.255.43.1:50004</code>{' '}
                    untuk pancaran suara langsung antar HP di Hotspot lokal.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleCopy(kotlinUdpMulticastSource, 'Kode Kotlin disalin')}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Salin</span>
                  </button>
                  <button
                    onClick={() =>
                      downloadFile('TacticalHtMulticastEngine.kt', kotlinUdpMulticastSource)
                    }
                    className="min-h-[40px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh .KT</span>
                  </button>
                </div>
              </div>

              {copiedNotice && (
                <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{copiedNotice}</span>
                </div>
              )}

              <pre className="p-4 rounded-xl bg-[#0B111E] border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-72 leading-relaxed">
                {kotlinUdpMulticastSource}
              </pre>
            </div>
          )}

          {activeSubTab === 'TERMUX_HOST' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <Wifi className="w-4 h-4 text-amber-400" />
                    Menjalankan Server Relay Langsung di HP Master (Termux Offline)
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Dengan skrip ini, HP Master yang menyalakan Hotspot menjadi pusat WebSocket
                    lokal di <code className="font-mono text-amber-300">https://192.168.43.1:3000</code>.
                  </p>
                </div>
                <button
                  onClick={() => downloadFile('start-master-ht.sh', termuxHostScript)}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh Skrip .SH</span>
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-[#0B111E] border border-slate-800 text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
                {termuxHostScript}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
