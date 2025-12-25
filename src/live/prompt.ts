/**
 * Builds system instruction for translation
 */
import { LANGUAGES } from "../config";

export function buildSystemInstruction(sourceLang: string, targetLang: string): string {
  const source = LANGUAGES.find((l) => l.code === sourceLang)?.name ?? sourceLang;
  const target = LANGUAGES.find((l) => l.code === targetLang)?.name ?? targetLang;
  return `You are a real-time interpreter. Translate spoken ${source} to ${target}. 
Speak the translation naturally without commentary or annotations. 
Maintain the speaker's tone and intent.`;
}

