// ============================================================================
// DIRECT 8kHz 16-BIT PCM WAV WALKIE-TALKIE ENGINE (HALF-DUPLEX ANTI-LOOP)
// Zero MediaRecorder codec issues · Zero decodeAudioData crashes · Live Streaming
// Strict Half-Duplex: Automatically mutes speaker playback while Mic is transmitting!
// ============================================================================

class RadioAudioEngine {
  private ctx: AudioContext | null = null;
  private nextPlayTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  // Live Mic Capture state
  private micStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silentGainNode: GainNode | null = null;
  private recordedSamples8k: number[] = [];
  private liveChunkSamples8k: number[] = [];
  private isCapturing = false;
  private lastTxStopTime = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const unlock = () => {
        this.unlockAudio();
      };
      window.addEventListener('touchstart', unlock, { passive: true });
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock, { passive: true });
    }
  }

  public unlockAudio(): AudioContext | null {
    try {
      if (!this.ctx) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  public getAudioState(): 'READY' | 'LOCKED' {
    if (this.ctx && this.ctx.state === 'running') return 'READY';
    return 'LOCKED';
  }

  // Immediately stops any playing incoming audio so speaker sound never feeds back into the mic
  public stopAllPlayback() {
    this.activeSources.forEach((src) => {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    });
    this.activeSources.clear();
    if (this.ctx) {
      this.nextPlayTime = this.ctx.currentTime;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
  }

  // 1. Classic Military HT PTT Key-Down Chirp
  public playPttKeyDown(volume = 0.5) {
    try {
      const ctx = this.unlockAudio();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';

      osc.frequency.setValueAtTime(1800, now);
      osc.frequency.setValueAtTime(1200, now + 0.04);
      osc.frequency.setValueAtTime(1850, now + 0.08);

      gain.gain.setValueAtTime(Math.min(1, volume * 0.45), now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {
      // Ignore
    }
  }

  // 2. Classic HT Roger Beep + Static Squelch Tail ("Beep-Kssshhh!")
  public playRogerBeepAndSquelchTail(volume = 0.55) {
    try {
      const ctx = this.unlockAudio();
      if (!ctx) return;
      const now = Math.max(ctx.currentTime, this.nextPlayTime);

      const osc = ctx.createOscillator();
      const toneGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1560, now);
      osc.frequency.setValueAtTime(1980, now + 0.07);

      toneGain.gain.setValueAtTime(Math.min(1, volume * 0.55), now);
      toneGain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);

      osc.connect(toneGain);
      toneGain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);

      const bufferSize = Math.floor(ctx.sampleRate * 0.14);
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.setValueAtTime(1450, now + 0.13);
      bandpass.Q.setValueAtTime(1.0, now + 0.13);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(Math.min(1, volume * 0.4), now + 0.13);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.27);

      whiteNoise.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(ctx.destination);

      whiteNoise.start(now + 0.13);
      whiteNoise.stop(now + 0.28);
    } catch {
      // Ignore
    }
  }

  // 3. Barcode Scan / Pairing Connected Confirmation Sound
  public playBarcodeLockConfirm(volume = 0.5) {
    try {
      const ctx = this.unlockAudio();
      if (!ctx) return;
      const now = ctx.currentTime;

      const freqs = [1046.5, 1318.5, 1567.98, 2093.0];
      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + idx * 0.065);
        gain.gain.setValueAtTime(Math.min(1, volume * 0.6), now + idx * 0.065);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.065 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.065);
        osc.stop(now + idx * 0.065 + 0.13);
      });
    } catch {
      // Ignore
    }
  }

  // 3b. Tactical Data-Link Chat Notification Beep
  public playChatNotificationBeep(volume = 0.45) {
    try {
      if (this.isCurrentlyTransmitting()) return;
      const ctx = this.unlockAudio();
      if (!ctx) return;
      const now = ctx.currentTime;

      [1480, 1975].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.055);
        gain.gain.setValueAtTime(Math.min(1, volume * 0.45), now + idx * 0.055);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.055);
        osc.stop(now + idx * 0.055 + 0.09);
      });
    } catch {
      // Ignore
    }
  }

  // 4. SOS Emergency Siren
  public playSosAlarm(volume = 0.6) {
    try {
      const ctx = this.unlockAudio();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(850, now);
      osc.frequency.linearRampToValueAtTime(1500, now + 0.22);
      osc.frequency.linearRampToValueAtTime(850, now + 0.44);
      osc.frequency.linearRampToValueAtTime(1500, now + 0.66);

      gain.gain.setValueAtTime(Math.min(1, volume * 0.6), now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.72);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.72);
    } catch {
      // Ignore
    }
  }

  // ==========================================================================
  // REAL-TIME MICROPHONE CAPTURE -> 8000Hz 16-BIT PCM WAV + LIVE STREAM CHUNKS
  // ==========================================================================
  public async startLiveMicCapture(
    onLiveWavChunk: (wavDataUrl: string) => void,
    onMicLevel?: (levelPercent: number) => void
  ): Promise<boolean> {
    const ctx = this.unlockAudio();
    if (!ctx) return false;

    // Half-duplex rule: immediately silence speaker before opening microphone!
    this.stopAllPlayback();

    this.recordedSamples8k = [];
    this.liveChunkSamples8k = [];
    this.isCapturing = true;

    try {
      if (!this.micStream || !this.micStream.active) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      const inputSampleRate = ctx.sampleRate;
      const targetSampleRate = 8000;
      const ratio = inputSampleRate / targetSampleRate;

      this.sourceNode = ctx.createMediaStreamSource(this.micStream);
      this.processorNode = ctx.createScriptProcessor(4096, 1, 1);
      this.silentGainNode = ctx.createGain();
      this.silentGainNode.gain.value = 0; // Never route mic to local speaker!

      this.processorNode.onaudioprocess = (ev) => {
        if (!this.isCapturing) return;
        const input = ev.inputBuffer.getChannelData(0);

        let sumSq = 0;
        for (let i = 0; i < input.length; i++) {
          sumSq += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSq / input.length);
        const level = Math.min(100, Math.max(12, Math.round(rms * 420)));
        onMicLevel?.(level);

        let offset = 0;
        while (offset < input.length) {
          const idx = Math.floor(offset);
          const s = Math.max(-1, Math.min(1, input[idx] * 1.65));
          this.recordedSamples8k.push(s);
          this.liveChunkSamples8k.push(s);
          offset += ratio;
        }

        // Every ~450ms (3600 samples at 8kHz), emit a live streamable WAV chunk
        if (this.liveChunkSamples8k.length >= 3600) {
          const chunkSamples = this.liveChunkSamples8k.splice(0, this.liveChunkSamples8k.length);
          const wavChunk = this.encodeFloat32ToWavDataUrl(chunkSamples, 8000);
          onLiveWavChunk(wavChunk);
        }
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.silentGainNode);
      this.silentGainNode.connect(ctx.destination);
      return true;
    } catch {
      this.isCapturing = false;
      return false;
    }
  }

  public stopLiveMicCapture(onFinalChunk?: (wavDataUrl: string) => void): string | undefined {
    this.isCapturing = false;
    this.lastTxStopTime = Date.now();

    try {
      if (this.liveChunkSamples8k.length > 400 && onFinalChunk) {
        const remaining = this.liveChunkSamples8k.splice(0, this.liveChunkSamples8k.length);
        onFinalChunk(this.encodeFloat32ToWavDataUrl(remaining, 8000));
      }
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
      this.silentGainNode?.disconnect();
    } catch {
      // ignore
    }

    if (this.recordedSamples8k.length > 400) {
      const fullWav = this.encodeFloat32ToWavDataUrl(this.recordedSamples8k, 8000);
      this.recordedSamples8k = [];
      return fullWav;
    }

    return this.generateTestRadioToneWav();
  }

  public isCurrentlyTransmitting(): boolean {
    return this.isCapturing || Date.now() - this.lastTxStopTime < 350;
  }

  // Encode Float32 mono samples (-1..1) into a standard 16-bit PCM RIFF WAVE DataURL
  public encodeFloat32ToWavDataUrl(samples: number[], sampleRate = 8000): string {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return 'data:audio/wav;base64,' + btoa(binary);
  }

  private generateTestRadioToneWav(): string {
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * 0.65);
    const samples: number[] = [];
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const freq = t < 0.22 ? 880 : t < 0.44 ? 1174.66 : 1567.98;
      const tone = Math.sin(2 * Math.PI * freq * t) * 0.55;
      const staticNoise = (Math.random() * 2 - 1) * 0.08;
      samples.push(tone + staticNoise);
    }
    return this.encodeFloat32ToWavDataUrl(samples, sampleRate);
  }

  // ==========================================================================
  // ZERO-FAILURE DIRECT PCM WAV PLAYER (Half-Duplex Protected!)
  // ==========================================================================
  public playWavDataUrlDirectly(
    wavDataUrl: string,
    volume = 1.0,
    withChirpAndRoger = false,
    allowDuringTx = false
  ) {
    try {
      // Half-Duplex Protection: Never play incoming audio while our own mic is transmitting!
      if (!allowDuringTx && this.isCurrentlyTransmitting()) {
        return;
      }

      const ctx = this.unlockAudio();
      if (!ctx) return;

      if (withChirpAndRoger) {
        this.playPttKeyDown(volume * 0.45);
      }

      const base64Idx = wavDataUrl.indexOf('base64,');
      if (base64Idx === -1) return;
      const b64 = wavDataUrl.slice(base64Idx + 7);
      const binary = atob(b64);
      const len = binary.length;
      if (len <= 44) return;

      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const view = new DataView(bytes.buffer);
      const sampleRate = view.getUint32(24, true) || 8000;
      const numSamples = Math.floor((len - 44) / 2);
      if (numSamples <= 0) return;

      const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      let offset = 44;
      for (let i = 0; i < numSamples; i++) {
        const int16 = view.getInt16(offset, true);
        channelData[i] = int16 / 32768.0;
        offset += 2;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 280;

      const gain = ctx.createGain();
      gain.gain.value = Math.min(2.4, Math.max(0.2, volume * 1.7));

      source.connect(highpass);
      highpass.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = withChirpAndRoger
        ? now + 0.14
        : Math.max(now + 0.02, this.nextPlayTime);

      this.activeSources.add(source);
      source.start(startAt);
      this.nextPlayTime = startAt + audioBuffer.duration;

      source.onended = () => {
        this.activeSources.delete(source);
        if (withChirpAndRoger) {
          this.playRogerBeepAndSquelchTail(volume * 0.5);
        }
      };
    } catch {
      // Fallback
    }
  }

  public async playIncomingRadioVoice(
    audioDataUrl?: string,
    fallbackText?: string,
    volume = 0.95,
    allowDuringTx = false
  ): Promise<void> {
    if (!allowDuringTx && this.isCurrentlyTransmitting()) {
      return;
    }

    if (audioDataUrl && audioDataUrl.startsWith('data:audio/wav;base64,')) {
      this.playWavDataUrlDirectly(audioDataUrl, volume, true, allowDuringTx);
      return;
    }

    this.playPttKeyDown(volume * 0.5);

    if (fallbackText && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(fallbackText);
        utter.lang = 'id-ID';
        utter.rate = 1.05;
        utter.volume = Math.min(1, volume);
        utter.onend = () => {
          this.playRogerBeepAndSquelchTail(volume * 0.5);
        };
        window.speechSynthesis.speak(utter);
        return;
      } catch {
        // ignore
      }
    }

    const toneWav = this.generateTestRadioToneWav();
    this.playWavDataUrlDirectly(toneWav, volume, false, allowDuringTx);
    setTimeout(() => {
      this.playRogerBeepAndSquelchTail(volume * 0.5);
    }, 680);
  }
}

export const radioAudio = new RadioAudioEngine();
