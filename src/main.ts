/**
 * Main entry: route to speaker or audience based on URL
 */
import { SpeakerUI } from "./ui/speaker";
import { AudienceUI } from "./ui/audience";
import { API_BASE } from "./config";

const path = location.pathname;
const speakerKeyStorageKey = "sermon_translator_speakerKey_v1";

// Home page
if (path === "/" || path === "") {
  showPage("home");
  document.getElementById("createRoom")!.onclick = async () => {
    const res = await fetch(`${API_BASE}/api/rooms`, { method: "POST" });
    const { roomId, speakerKey } = await res.json();
    location.href = `/speaker/${roomId}?speakerKey=${speakerKey}`;
  };
}

// Speaker page: /speaker/:roomId?speakerKey=...
const speakerMatch = path.match(/^\/speaker\/([^/]+)$/);
if (speakerMatch) {
  const roomId = speakerMatch[1];
  const params = new URLSearchParams(location.search);
  const speakerKeyParam = params.get("speakerKey");
  if (speakerKeyParam) {
    sessionStorage.setItem(`${speakerKeyStorageKey}:${roomId}`, speakerKeyParam);
    history.replaceState(null, "", location.pathname);
  }
  const speakerKey = speakerKeyParam || sessionStorage.getItem(`${speakerKeyStorageKey}:${roomId}`);
  if (!speakerKey) {
    alert("Missing speakerKey");
  } else {
    showPage("speaker");
    new SpeakerUI(
      {
        sourceLang: document.getElementById("sourceLang") as HTMLSelectElement,
        targetLang: document.getElementById("targetLang") as HTMLSelectElement,
        startBtn: document.getElementById("startBtn") as HTMLButtonElement,
        stopBtn: document.getElementById("stopBtn") as HTMLButtonElement,
        statusEl: document.getElementById("speakerStatus")!,
        inputText: document.getElementById("inputText")!,
        outputText: document.getElementById("outputText")!,
        audienceLink: document.getElementById("audienceLink") as HTMLButtonElement,
        audioToggle: document.getElementById("speakerAudioToggle") as HTMLInputElement,
      },
      roomId,
      speakerKey
    );
  }
}

// Audience page: /room/:roomId
const audienceMatch = path.match(/^\/room\/([^/]+)$/);
if (audienceMatch) {
  const roomId = audienceMatch[1];
  showPage("audience");
  new AudienceUI(
    {
      statusEl: document.getElementById("audienceStatus")!,
      inputText: document.getElementById("audInputText")!,
      outputText: document.getElementById("audOutputText")!,
      audioToggle: document.getElementById("audioToggle") as HTMLInputElement,
      inputLabel: document.getElementById("audInputLabel")!,
      outputLabel: document.getElementById("audOutputLabel")!,
    },
    roomId
  );
}

function showPage(id: string): void {
  document.getElementById(id)!.style.display = "block";
}
