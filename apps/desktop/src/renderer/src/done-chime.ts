/** Short two-note “done” chime. No bundled audio file. */

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
  }
  return ctx;
}

function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  duration: number,
  peak: number,
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

export async function playDoneChime(): Promise<void> {
  try {
    const ac = audio();
    if (ac.state === "suspended") await ac.resume();
    const t = ac.currentTime;
    tone(ac, 784, t, 0.22, 0.16);
    tone(ac, 1046.5, t + 0.14, 0.38, 0.2);
  } catch {
    /* autoplay / AudioContext unavailable */
  }
}
