// Complete Native Android Kotlin Source Code for TACTICAL WI-COMM SUBDISRUDAL
// Architecture: Peer-to-Peer UDP Broadcast (255.255.255.255:50000) + Auto-Discovery + Kotlin Coroutines (Dispatchers.IO)

export const KOTLIN_UDP_ENGINE_CODE = `package id.tni.au.diskomlek.subdisrudal.wicomm

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Data Model Prajurit / Node pada Tabel Matriks 'ONLINE'
 */
data class TacticalPeerNode(
    val callsign: String,
    val ipAddress: String,
    val freqMhz: String = "142.850",
    val isTalking: Boolean = false,
    val pingMs: Int = 24,
    val lastSeenTimestamp: Long = System.currentTimeMillis()
)

/**
 * Data Model Pesan Taktis HUD 'MESSAGE'
 */
data class TacticalHudMessage(
    val senderCallsign: String,
    val senderIp: String,
    val messageText: String,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * TACTICAL WI-COMM SUBDISRUDAL - P2P UDP Broadcast Engine (Tanpa Server Master)
 *
 * Fitur Utama:
 * 1. Auto-Discovery Listener di latar belakang pada UDP Port 50000 (Dispatchers.IO).
 * 2. Broadcast Kehadiran otomatis ke 255.255.255.255:50000 setiap 3 detik.
 * 3. Pencatatan IP & Callsign otomatis ke memori (ConcurrentHashMap) & update UI 'ONLINE' via StateFlow.
 * 4. Transmisi PTT Half-Duplex: Rekam PCM 16-bit dan pancarkan paket Datagram UDP secara kontinu ke 255.255.255.255:50000.
 */
class TacticalUdpBroadcastEngine(
    private val context: Context,
    @Volatile var localCallsign: String = "SERI-01",
    @Volatile var activeFreqMhz: String = "142.850"
) {
    companion object {
        const val UDP_PORT = 50000
        const val BROADCAST_IP = "255.255.255.255"
        const val BEACON_INTERVAL_MS = 3000L       // Broadcast kehadiran setiap 3 detik
        const val PEER_TIMEOUT_MS = 12000L         // Hapus node jika tidak aktif > 12 detik

        // Header Paket Protokol Taktis UDP
        private const val PKT_BEACON: Byte = 0x01  // Paket Kehadiran (Auto-Discovery)
        private const val PKT_AUDIO: Byte = 0x02   // Paket Suara PTT (PCM Audio Stream)
        private const val PKT_PTT_END: Byte = 0x03 // Paket Selesai Bicara (Roger Beep)
        private const val PKT_MESSAGE: Byte = 0x04 // Paket Pesan Taktis HUD MESSAGE

        // Konfigurasi Audio Walkie-Talkie (16 kHz, 16-Bit PCM, Mono)
        private const val SAMPLE_RATE = 16000
        private const val AUDIO_CHUNK_BYTES = 640  // 20ms frame @ 16kHz 16-bit Mono (sangat ringan untuk UDP)
    }

    // Scope Coroutine Terpisah di Background Thread (Dispatchers.IO) agar UI tidak pernah membeku (freeze)
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Penyimpanan Memori Otomatis: Key = IP Address / Callsign -> Data Node
    private val peerMemoryMap = ConcurrentHashMap<String, TacticalPeerNode>()

    // StateFlow Real-Time untuk Tabel Matriks 'ONLINE:' di UI Android
    private val _onlinePeersFlow = MutableStateFlow<List<TacticalPeerNode>>(emptyList())
    val onlinePeersFlow: StateFlow<List<TacticalPeerNode>> = _onlinePeersFlow.asStateFlow()

    // StateFlow Real-Time untuk Kotak HUD 'MESSAGE'
    private val _hudMessagesFlow = MutableStateFlow<List<TacticalHudMessage>>(emptyList())
    val hudMessagesFlow: StateFlow<List<TacticalHudMessage>> = _hudMessagesFlow.asStateFlow()

    // StateFlow Indikator Transmisi & Penerimaan Suara
    private val _activeSpeakerFlow = MutableStateFlow<String?>(null)
    val activeSpeakerFlow: StateFlow<String?> = _activeSpeakerFlow.asStateFlow()

    private var udpSocket: DatagramSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    private var listenerJob: Job? = null
    private var beaconJob: Job? = null
    private var pttTransmitJob: Job? = null

    private val isRunning = AtomicBoolean(false)
    private val isTransmittingPtt = AtomicBoolean(false)
    private val isSpeakerMuted = AtomicBoolean(false)

    private var audioTrack: AudioTrack? = null

    /**
     * 1. MULAI MESIN JARINGAN SAAT APLIKASI DIBUKA
     */
    fun startEngine() {
        if (isRunning.getAndSet(true)) return

        // Aktifkan WifiManager Multicast/Broadcast Lock agar Android mengizinkan paket 255.255.255.255
        acquireWifiBroadcastLock()

        // Siapkan pemutar suara (AudioTrack) di thread IO
        engineScope.launch {
            initAudioTrackPlayer()
            openSharedUdpSocket()
            startUdpAutoDiscoveryListener()
            startPresenceBroadcastLoop()
        }
    }

    /**
     * Buka Socket UDP pada Port 50000 dengan opsi Broadcast & ReuseAddress
     */
    private fun openSharedUdpSocket() {
        try {
            udpSocket?.close()
            udpSocket = DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                bind(InetSocketAddress(UDP_PORT))
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * 2. AUTO-DISCOVERY & PENCATATAN IP OTOMATIS (Berjalan terus di latar belakang pada Port 50000)
     */
    private fun startUdpAutoDiscoveryListener() {
        listenerJob?.cancel()
        listenerJob = engineScope.launch(Dispatchers.IO) {
            val receiveBuffer = ByteArray(1472) // Ukuran aman MTU Ethernet/Wi-Fi

            while (isActive && isRunning.get()) {
                try {
                    val socket = udpSocket ?: break
                    val packet = DatagramPacket(receiveBuffer, receiveBuffer.size)
                    socket.receive(packet) // Blocking I/O aman karena berada di Dispatchers.IO

                    val senderIp = packet.address?.hostAddress ?: continue
                    val localIp = getLocalWifiIpAddress()

                    // Abaikan paket gema dari IP perangkat sendiri (Anti-Looping)
                    if (senderIp == localIp || packet.length < 2) continue

                    val packetType = packet.data[0]
                    val payloadLength = packet.length - 1

                    when (packetType) {
                        PKT_BEACON -> {
                            // Format Payload: "CALLSIGN|FREQ_MHZ"
                            val text = String(packet.data, 1, payloadLength, StandardCharsets.UTF_8)
                            val parts = text.split("|")
                            val remoteCallsign = parts.getOrNull(0)?.trim().orEmpty()
                            val remoteFreq = parts.getOrNull(1)?.trim() ?: activeFreqMhz

                            if (remoteCallsign.isNotEmpty() && remoteCallsign != localCallsign) {
                                recordPeerInMemory(
                                    callsign = remoteCallsign,
                                    ipAddress = senderIp,
                                    freqMhz = remoteFreq,
                                    isTalking = false
                                )
                            }
                        }

                        PKT_AUDIO -> {
                            // Format Paket Audio: [0]=PKT_AUDIO, [1..16]=Callsign (16 byte), [17..N]=PCM 16-bit Audio
                            if (packet.length <= 17) continue
                            val senderCallsign = String(packet.data, 1, 16, StandardCharsets.UTF_8)
                                .trim { it <= ' ' || it == '\\u0000' }

                            if (senderCallsign == localCallsign) continue

                            // Catat IP pengirim otomatis meskipun baru pertama kali terdengar dari PTT
                            recordPeerInMemory(
                                callsign = senderCallsign,
                                ipAddress = senderIp,
                                freqMhz = activeFreqMhz,
                                isTalking = true
                            )
                            _activeSpeakerFlow.value = "$senderCallsign ($senderIp)"

                            // HALF-DUPLEX: Hanya putar suara jika kita TIDAK sedang menekan tombol PTT
                            if (!isTransmittingPtt.get() && !isSpeakerMuted.get()) {
                                val pcmOffset = 17
                                val pcmLength = packet.length - pcmOffset
                                audioTrack?.write(packet.data, pcmOffset, pcmLength)
                            }
                        }

                        PKT_PTT_END -> {
                            val senderCallsign = String(packet.data, 1, payloadLength, StandardCharsets.UTF_8).trim()
                            recordPeerInMemory(
                                callsign = senderCallsign,
                                ipAddress = senderIp,
                                freqMhz = activeFreqMhz,
                                isTalking = false
                            )
                            _activeSpeakerFlow.value = null
                        }

                        PKT_MESSAGE -> {
                            // Format Payload: "CALLSIGN|ISI_PESAN"
                            val text = String(packet.data, 1, payloadLength, StandardCharsets.UTF_8)
                            val splitIdx = text.indexOf('|')
                            if (splitIdx > 0) {
                                val senderCallsign = text.substring(0, splitIdx)
                                val msgBody = text.substring(splitIdx + 1)
                                recordPeerInMemory(senderCallsign, senderIp, activeFreqMhz, false)
                                val newMsg = TacticalHudMessage(senderCallsign, senderIp, msgBody)
                                _hudMessagesFlow.value = (_hudMessagesFlow.value + newMsg).takeLast(20)
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (isActive && isRunning.get()) {
                        delay(200)
                    }
                }
            }
        }
    }

    /**
     * 3. BROADCAST KEHADIRAN OTOMATIS SETIAP 3 DETIK KE 255.255.255.255:50000
     */
    private fun startPresenceBroadcastLoop() {
        beaconJob?.cancel()
        beaconJob = engineScope.launch(Dispatchers.IO) {
            while (isActive && isRunning.get()) {
                try {
                    // Simpan juga status diri sendiri di tabel ONLINE
                    val myIp = getLocalWifiIpAddress()
                    recordPeerInMemory(
                        callsign = localCallsign,
                        ipAddress = myIp,
                        freqMhz = activeFreqMhz,
                        isTalking = isTransmittingPtt.get()
                    )

                    // Susun paket pendek: [PKT_BEACON] + "SERI-01|142.850"
                    val payloadBytes = "$localCallsign|$activeFreqMhz".toByteArray(StandardCharsets.UTF_8)
                    val packetBytes = ByteArray(1 + payloadBytes.size)
                    packetBytes[0] = PKT_BEACON
                    System.arraycopy(payloadBytes, 0, packetBytes, 1, payloadBytes.size)

                    sendBroadcastDatagram(packetBytes)

                    // Bersihkan peer yang sudah keluar jangkauan Wi-Fi (> 12 detik)
                    pruneInactivePeers()
                } catch (e: Exception) {
                    e.printStackTrace()
                }
                delay(BEACON_INTERVAL_MS)
            }
        }
    }

    /**
     * Simpan IP & Callsign ke Memori dan Perbarui Tabel Matriks 'ONLINE' secara Real-Time
     */
    private fun recordPeerInMemory(
        callsign: String,
        ipAddress: String,
        freqMhz: String,
        isTalking: Boolean
    ) {
        val now = System.currentTimeMillis()
        val existing = peerMemoryMap[ipAddress]
        val estimatedPing = if (existing != null) {
            ((now - existing.lastSeenTimestamp).coerceIn(12L, 45L)).toInt()
        } else {
            24
        }

        val updatedNode = TacticalPeerNode(
            callsign = callsign,
            ipAddress = ipAddress,
            freqMhz = freqMhz,
            isTalking = isTalking,
            pingMs = estimatedPing,
            lastSeenTimestamp = now
        )

        peerMemoryMap[ipAddress] = updatedNode
        publishSortedOnlineMatrix()
    }

    private fun pruneInactivePeers() {
        val now = System.currentTimeMillis()
        val myIp = getLocalWifiIpAddress()
        val removed = peerMemoryMap.entries.removeIf { (ip, node) ->
            ip != myIp && (now - node.lastSeenTimestamp > PEER_TIMEOUT_MS)
        }
        if (removed) {
            publishSortedOnlineMatrix()
        }
    }

    private fun publishSortedOnlineMatrix() {
        val sortedList = peerMemoryMap.values
            .sortedBy { it.callsign }
            .take(21) // Maks 20 Client + Perangkat Sendiri
        _onlinePeersFlow.value = sortedList
    }

    /**
     * 4. TRANSMISI PTT (PUSH-TO-TALK): Rekam Audio & Kirim Datagram UDP Kontinu ke 255.255.255.255
     */
    @SuppressLint("MissingPermission")
    fun startPttTransmission() {
        if (isTransmittingPtt.getAndSet(true)) return

        pttTransmitJob?.cancel()
        pttTransmitJob = engineScope.launch(Dispatchers.IO) {
            val minBufSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(AUDIO_CHUNK_BYTES * 2)

            val recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBufSize
            )

            // Siapkan Header Callsign 16-byte tetap
            val callsignHeader = ByteArray(16)
            val rawCall = localCallsign.toByteArray(StandardCharsets.UTF_8)
            System.arraycopy(rawCall, 0, callsignHeader, 0, minOf(rawCall.size, 16))

            val pcmBuffer = ByteArray(AUDIO_CHUNK_BYTES)
            val udpPayload = ByteArray(1 + 16 + AUDIO_CHUNK_BYTES)
            udpPayload[0] = PKT_AUDIO
            System.arraycopy(callsignHeader, 0, udpPayload, 1, 16)

            try {
                recorder.startRecording()
                recordPeerInMemory(localCallsign, getLocalWifiIpAddress(), activeFreqMhz, true)

                while (isActive && isTransmittingPtt.get()) {
                    val bytesRead = recorder.read(pcmBuffer, 0, AUDIO_CHUNK_BYTES)
                    if (bytesRead > 0) {
                        System.arraycopy(pcmBuffer, 0, udpPayload, 17, bytesRead)
                        sendBroadcastDatagram(udpPayload, 17 + bytesRead)
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                try {
                    recorder.stop()
                    recorder.release()
                } catch (_: Exception) {}

                // Pancarkan paket PTT_END agar seluruh HP di jaringan tahu transmisi selesai
                val endBytes = localCallsign.toByteArray(StandardCharsets.UTF_8)
                val endPacket = ByteArray(1 + endBytes.size)
                endPacket[0] = PKT_PTT_END
                System.arraycopy(endBytes, 0, endPacket, 1, endBytes.size)
                sendBroadcastDatagram(endPacket)

                recordPeerInMemory(localCallsign, getLocalWifiIpAddress(), activeFreqMhz, false)
            }
        }
    }

    /**
     * Hentikan Transmisi PTT ketika tombol dilepas (Half-Duplex)
     */
    fun stopPttTransmission() {
        isTransmittingPtt.set(false)
    }

    /**
     * Kirim Pesan Taktis ke Kotak HUD 'MESSAGE' via UDP Broadcast
     */
    fun sendTacticalMessage(messageText: String) {
        engineScope.launch(Dispatchers.IO) {
            val formatted = if (messageText.uppercase().endsWith("[SELESAI]")) {
                messageText.uppercase()
            } else {
                "\${messageText.uppercase()}... [SELESAI]"
            }
            val raw = "$localCallsign|$formatted".toByteArray(StandardCharsets.UTF_8)
            val pkt = ByteArray(1 + raw.size)
            pkt[0] = PKT_MESSAGE
            System.arraycopy(raw, 0, pkt, 1, raw.size)

            sendBroadcastDatagram(pkt)

            val selfMsg = TacticalHudMessage(localCallsign, getLocalWifiIpAddress(), formatted)
            _hudMessagesFlow.value = (_hudMessagesFlow.value + selfMsg).takeLast(20)
        }
    }

    /**
     * Fungsi Helper Mengirimkan Datagram ke Alamat Broadcast Jaringan (255.255.255.255:50000)
     */
    private suspend fun sendBroadcastDatagram(data: ByteArray, length: Int = data.size) =
        withContext(Dispatchers.IO) {
            try {
                val socket = udpSocket ?: return@withContext
                val broadcastAddr = InetAddress.getByName(BROADCAST_IP)
                val packet = DatagramPacket(data, length, broadcastAddr, UDP_PORT)
                socket.send(packet)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

    private fun initAudioTrackPlayer() {
        val minPlayBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(AUDIO_CHUNK_BYTES * 4)

        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(minPlayBuf)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
            .apply { play() }
    }

    private fun acquireWifiBroadcastLock() {
        try {
            val wifiManager =
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("TacticalWiCommSubdisrudalUdpLock").apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (_: Exception) {}
    }

    fun getLocalWifiIpAddress(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val ip = addr.hostAddress ?: continue
                        if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
                            return ip
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return "192.168.43.1"
    }

    fun setSpeakerMuted(muted: Boolean) {
        isSpeakerMuted.set(muted)
    }

    fun stopEngine() {
        isRunning.set(false)
        isTransmittingPtt.set(false)
        listenerJob?.cancel()
        beaconJob?.cancel()
        pttTransmitJob?.cancel()
        try {
            udpSocket?.close()
            audioTrack?.stop()
            audioTrack?.release()
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
            }
        } catch (_: Exception) {}
        engineScope.cancel()
    }
}
`;
