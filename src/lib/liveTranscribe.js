// ─── Kontinuirani Amazon Transcribe streaming ───
//
// Za razliku od prijasnjeg pristupa (snimi blob -> posalji -> cekaj), ovdje se
// mikrofon strima uzivo i rezultati stizu dok doktor jos govori. Transcribe salje
// dvije vrste rezultata:
//   IsPartial: true   -> privremena hipoteza, mijenja se dok govor traje
//   IsPartial: false  -> finalizirani segment, vise se ne mijenja
// Ekstrakciju polja okidamo SAMO na finaliziranima, inace bi polja treperila.

import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';

const TARGET_SAMPLE_RATE = 16000;

// AudioWorklet se ucitava iz zasebne datoteke preko URL-a. Umjesto da je stavljamo
// u public/ i vezemo uz bundler, gradimo je iz Blob URL-a — modul ostaje samodostatan.
const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Kopija je nuzna: Web Audio reciklira isti buffer izmedju poziva.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = srcIdx - lo;
    result[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac;
  }
  return result;
}

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

// Most izmedju mikrofona (push) i SDK-ovog async generatora (pull).
function createAudioQueue() {
  const pending = [];
  let waiter = null;
  let closed = false;

  return {
    push(chunk) {
      if (closed) return;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(chunk);
      } else {
        pending.push(chunk);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(null);
      }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length) {
          yield pending.shift();
          continue;
        }
        if (closed) return;
        const chunk = await new Promise((resolve) => { waiter = resolve; });
        if (chunk === null) return;
        yield chunk;
      }
    },
  };
}

/**
 * Pokrece zivu sesiju transkripcije.
 *
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startLiveTranscription({
  credentials,
  region,
  languageCode,
  vocabularyName,
  onPartial,
  onFinal,
  onError,
}) {
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  try {
    await audioCtx.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = audioCtx.createMediaStreamSource(mediaStream);
  const capture = new AudioWorkletNode(audioCtx, 'pcm-capture');
  const queue = createAudioQueue();

  capture.port.onmessage = (event) => {
    const downsampled = downsampleBuffer(event.data, audioCtx.sampleRate, TARGET_SAMPLE_RATE);
    queue.push(new Uint8Array(float32ToInt16(downsampled).buffer));
  };

  // Web Audio je pull-based: cvor koji ne vodi do destination-a se ne izvrsava.
  // Zato ide kroz gain 0 — graf se vrti, ali se doktor ne cuje kroz zvucnike.
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  source.connect(capture);
  capture.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  const client = new TranscribeStreamingClient({ region, credentials });

  async function* audioStream() {
    for await (const chunk of queue) {
      yield { AudioEvent: { AudioChunk: chunk } };
    }
  }

  const command = new StartStreamTranscriptionCommand({
    LanguageCode: languageCode,
    MediaEncoding: 'pcm',
    MediaSampleRateHertz: TARGET_SAMPLE_RATE,
    AudioStream: audioStream(),
    // Custom vocabulary je jedina poluga za prilagodbu domeni na hrvatskom
    // (custom language modeli ne podrzavaju hr-HR).
    ...(vocabularyName ? { VocabularyName: vocabularyName } : {}),
  });

  let stopped = false;
  let torndown = false;

  const teardown = () => {
    if (torndown) return;
    torndown = true;
    try { capture.port.onmessage = null; } catch { /* ignore */ }
    try { source.disconnect(); } catch { /* ignore */ }
    try { capture.disconnect(); } catch { /* ignore */ }
    try { silentGain.disconnect(); } catch { /* ignore */ }
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (audioCtx.state !== 'closed') audioCtx.close(); } catch { /* ignore */ }
  };

  const pump = (async () => {
    try {
      const response = await client.send(command);
      for await (const event of response.TranscriptResultStream) {
        const results = event.TranscriptEvent?.Transcript?.Results || [];
        for (const r of results) {
          const text = r.Alternatives?.[0]?.Transcript || '';
          if (!text) continue;
          if (r.IsPartial) onPartial?.(text);
          else onFinal?.(text);
        }
      }
    } catch (err) {
      // Prekid koji smo sami izazvali (stop) nije greska.
      if (!stopped) onError?.(err);
    } finally {
      teardown();
    }
  })();

  return {
    async stop() {
      stopped = true;
      queue.close();
      teardown();
      try { await pump; } catch { /* vec obradjeno u pump-u */ }
    },
  };
}
