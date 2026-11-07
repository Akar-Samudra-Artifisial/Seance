import type { MentionAudio } from "./client-store.js";

const BEEP_HZ = 880;
const BEEP_SECONDS = 0.15;
const BEEP_GAIN = 0.05;

/** Web Audio adapter: a short sine beep. The context is created on unlock, which needs a user gesture. */
export function createBrowserAudio(): MentionAudio {
  let ctx: AudioContext | null = null;
  return {
    unlock() {
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
    },
    play() {
      if (ctx === null) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = BEEP_HZ;
      gain.gain.value = BEEP_GAIN;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + BEEP_SECONDS);
    },
  };
}
