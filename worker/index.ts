/**
 * Cloudflare Worker entry: API routes + Durable Object export
 */
import { RoomDO } from "./roomDO";

export { RoomDO };

interface Env {
  ROOM: DurableObjectNamespace;
  GEMINI_API_KEY: string;
  /**
   * Optional comma-separated allowlist for CORS (e.g. "https://app.example.com,http://localhost:5173")
   * Use "*" to allow all (current default behavior).
   */
  ALLOWED_ORIGINS?: string;
}

function parseAllowedOrigins(raw?: string): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ["*"];
}

function corsHeadersFor(request: Request, env: Env): HeadersInit {
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (allowed.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }

  const origin = request.headers.get("Origin") ?? "";
  const allowOrigin = allowed.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

const ROOM_ID_RE = /^[a-f0-9]{8}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for API requests
    const corsHeaders = corsHeadersFor(request, env);
    const baseSecurityHeaders = {
      "X-Content-Type-Options": "nosniff",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...corsHeaders, ...baseSecurityHeaders } });
    }

    // POST /api/rooms - create a new room
    if (path === "/api/rooms" && request.method === "POST") {
      const roomId = crypto.randomUUID().slice(0, 8);
      const speakerKey = crypto.randomUUID();
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      await room.fetch(new Request("http://internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerKey }),
      }));
      return new Response(JSON.stringify({ roomId, speakerKey }), {
        headers: {
          ...corsHeaders,
          ...baseSecurityHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // POST /api/token - get ephemeral Gemini token (requires speakerKey)
    if (path === "/api/token" && request.method === "POST") {
      let body: { roomId?: string; speakerKey?: string } = {};
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: {
            ...corsHeaders,
            ...baseSecurityHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      const { roomId, speakerKey } = body;
      if (!roomId || !speakerKey) {
        return new Response(JSON.stringify({ error: "Missing roomId or speakerKey" }), {
          status: 400,
          headers: {
            ...corsHeaders,
            ...baseSecurityHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response(JSON.stringify({ error: "Invalid roomId" }), {
          status: 400,
          headers: {
            ...corsHeaders,
            ...baseSecurityHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }

      // Validate speakerKey with the room
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      const validRes = await room.fetch(new Request("http://internal/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerKey }),
      }));
      const valid = await validRes.json() as { valid: boolean };
      if (!valid.valid) {
        return new Response(JSON.stringify({ error: "Invalid speakerKey" }), {
          status: 403,
          headers: {
            ...corsHeaders,
            ...baseSecurityHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }

      // Request ephemeral token from Gemini (v1alpha auth_tokens endpoint)
      const tokenRes = await fetch(
        `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uses: 1 }),
        }
      );
      if (!tokenRes.ok) {
        console.error(`Token API error (${tokenRes.status})`);
        return new Response(JSON.stringify({ error: "Token fetch failed", status: tokenRes.status }), {
          status: 500,
          headers: {
            ...corsHeaders,
            ...baseSecurityHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      const tokenData = await tokenRes.json() as { name: string };
      return new Response(JSON.stringify({ token: tokenData.name }), {
        headers: {
          ...corsHeaders,
          ...baseSecurityHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // GET /api/rooms/:roomId/status - check room existence and expiry
    const statusMatch = path.match(/^\/api\/rooms\/([^/]+)\/status$/);
    if (statusMatch && request.method === "GET") {
      const roomId = statusMatch[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response(JSON.stringify({ exists: false, expiresAt: null }), {
          headers: { ...corsHeaders, ...baseSecurityHeaders, "Content-Type": "application/json" },
        });
      }
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      const res = await room.fetch(new Request("http://internal/status", { method: "GET" }));
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, ...baseSecurityHeaders, "Content-Type": "application/json" },
      });
    }

    // WebSocket /api/rooms/:roomId/ws
    const wsMatch = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("Invalid roomId", { status: 400, headers: { ...baseSecurityHeaders } });
      }
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      return room.fetch(request);
    }

    // Health check
    if (path === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, ...baseSecurityHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
