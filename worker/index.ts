/**
 * Cloudflare Worker entry: API routes + Durable Object export
 */
import { RoomDO } from "./roomDO";

export { RoomDO };

interface Env {
  ROOM: DurableObjectNamespace;
  GEMINI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for API requests
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /api/rooms - create a new room
    if (path === "/api/rooms" && request.method === "POST") {
      const roomId = crypto.randomUUID().slice(0, 8);
      const speakerKey = crypto.randomUUID();
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      await room.fetch(new Request("http://internal/init", {
        method: "POST",
        body: JSON.stringify({ speakerKey }),
      }));
      return new Response(JSON.stringify({ roomId, speakerKey }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /api/token - get ephemeral Gemini token (requires speakerKey)
    if (path === "/api/token" && request.method === "POST") {
      const body = await request.json() as { roomId: string; speakerKey: string };
      const { roomId, speakerKey } = body;
      if (!roomId || !speakerKey) {
        return new Response(JSON.stringify({ error: "Missing roomId or speakerKey" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate speakerKey with the room
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      const validRes = await room.fetch(new Request("http://internal/validate", {
        method: "POST",
        body: JSON.stringify({ speakerKey }),
      }));
      const valid = await validRes.json() as { valid: boolean };
      if (!valid.valid) {
        return new Response(JSON.stringify({ error: "Invalid speakerKey" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        const err = await tokenRes.text();
        console.error(`Token API error (${tokenRes.status}):`, err);
        return new Response(JSON.stringify({ error: "Token fetch failed", status: tokenRes.status, details: err }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const tokenData = await tokenRes.json() as { name: string };
      return new Response(JSON.stringify({ token: tokenData.name }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // WebSocket /api/rooms/:roomId/ws
    const wsMatch = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const id = env.ROOM.idFromName(roomId);
      const room = env.ROOM.get(id);
      return room.fetch(request);
    }

    // Health check
    if (path === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

