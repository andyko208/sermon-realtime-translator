/**
 * Main entry: route to speaker or audience based on URL
 */
import { SpeakerUI } from "./ui/speaker";
import { AudienceUI } from "./ui/audience";
import { API_BASE } from "./config";

const path = location.pathname;
const speakerKeyStorageKey = "sermon_translator_speakerKey_v1";

interface RoomStatus {
  exists: boolean;
  expiresAt: number | null;
}

/** Check if room exists and get expiry timestamp */
async function checkRoomStatus(roomId: string): Promise<RoomStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/rooms/${roomId}/status`);
    return await res.json();
  } catch {
    return { exists: false, expiresAt: null };
  }
}

/** Redirect to home with expired room message */
function redirectExpired(): void {
  location.href = "/?expired=1";
}

function showPage(id: string): void {
  document.getElementById(id)!.style.display = "block";
}

/** Show toast notification if redirected from expired room */
function showExpiredToastIfNeeded(): void {
  const params = new URLSearchParams(location.search);
  if (params.get("expired") !== "1") return;
  history.replaceState(null, "", "/");
  const toast = document.getElementById("expiredToast");
  if (toast) {
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 5000);
  }
}

// Home page
if (path === "/" || path === "") {
  showPage("home");
  showExpiredToastIfNeeded();
  const versionEl = document.getElementById("versionNumber");
  if (versionEl) {
    versionEl.textContent = __APP_VERSION__;
  }
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
    // Validate room exists before showing UI
    checkRoomStatus(roomId).then((status) => {
      if (!status.exists) return redirectExpired();
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
          expiryEl: document.getElementById("roomExpiry")!,
        },
        roomId,
        speakerKey,
        status.expiresAt
      );
    });
  }
}

// Audience page: /room/:roomId
const audienceMatch = path.match(/^\/room\/([^/]+)$/);
if (audienceMatch) {
  const roomId = audienceMatch[1];
  // Validate room exists before showing UI
  checkRoomStatus(roomId).then((status) => {
    if (!status.exists) return redirectExpired();
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
  });
}
