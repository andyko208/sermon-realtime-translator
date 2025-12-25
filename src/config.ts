/**
 * Application configuration constants
 */

// Worker API URL: use relative path in dev (proxied), absolute in production
export const API_BASE = import.meta.env.DEV ? "" : "https://sermon-translator.peanut61313.workers.dev";

export const CONFIG = {
  MODEL: "gemini-2.5-flash-native-audio-preview-12-2025",
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  CHUNK_SIZE: 4096, // PCM16 samples per chunk
} as const;

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ko", name: "Korean" },
  { code: "es", name: "Spanish" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
] as const;

