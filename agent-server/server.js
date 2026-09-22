import { Room, RoomEvent, dispose } from "@livekit/rtc-node";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8788);
const sessions = new Map();
const USAGE_TRACKING_ENABLED = process.env.USAGE_TRACKING_ENABLED === "true";
const USAGE_ALLOWED_ORIGINS = new Set(
  String(process.env.USAGE_ALLOWED_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    Vary: "Origin"
  };
  if (USAGE_ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(body));
}

async function callUsageFunction(url, body) {
  const secret = process.env.AI_USAGE_INGEST_SECRET;
  if (!secret) throw new Error("Usage tracking is not configured.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ingest-secret": secret },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(payload.message || "Usage service request failed."));
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function bindUsageSession(sessionId, usageToken) {
  if (!USAGE_TRACKING_ENABLED) return null;
  if (!usageToken) {
    const error = new Error("A verified usage session is required.");
    error.status = 401;
    throw error;
  }
  const url = process.env.SUPABASE_BIND_AI_USAGE_URL;
  if (!url) throw new Error("Usage tracking is not configured.");
  return callUsageFunction(url, { renderSessionId: sessionId, usageToken });
}

async function reportUsage(sessionRecord) {
  if (!sessionRecord?.usage) {
    const error = new Error("Usage tracking was not initialised for this session.");
    error.status = 409;
    throw error;
  }
  if (sessionRecord.usage.reported) return { duplicate: true, chargedSeconds: 0 };
  const url = process.env.SUPABASE_RECORD_AI_USAGE_URL;
  if (!url) throw new Error("Usage tracking is not configured.");
  const result = await callUsageFunction(url, { sessionId: sessionRecord.id });
  sessionRecord.usage.reported = true;
  return result;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out connecting to LiveAvatar session WebSocket."));
    }, 10000);

    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connectSessionWebSocket(sessionRecord) {
  if (sessionRecord.ws && sessionRecord.ws.readyState === WebSocket.OPEN) {
    return sessionRecord.ws;
  }

  if (
    sessionRecord.ws &&
    (sessionRecord.ws.readyState === WebSocket.CONNECTING ||
      sessionRecord.ws.readyState === WebSocket.OPEN)
  ) {
    await waitForWebSocketOpen(sessionRecord.ws);
    return sessionRecord.ws;
  }

  const ws = new WebSocket(sessionRecord.wsUrl);
  sessionRecord.ws = ws;
  attachWebSocketLogs(sessionRecord);
  await waitForWebSocketOpen(ws);
  await waitForSessionConnected(ws);
  return ws;
}

function waitForSessionConnected(ws) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10000);

    const onMessage = (message) => {
      try {
        const event = JSON.parse(message.toString());
        const eventType = event.type || event.event_type;
        if (eventType === "session.state_updated" && event.state === "connected") {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve();
        }
      } catch {
        // Ignore non-JSON diagnostics from the provider.
      }
    };

    ws.on("message", onMessage);
  });
}

function sendSessionCommand(sessionRecord, payload) {
  if (!sessionRecord.ws || sessionRecord.ws.readyState !== WebSocket.OPEN) {
    throw new Error("LiveAvatar session WebSocket is not connected.");
  }

  sessionRecord.ws.send(JSON.stringify(payload));
}

function attachWebSocketLogs(sessionRecord) {
  const { id: sessionId, ws } = sessionRecord;

  ws.on("message", (message) => {
    console.log(`[${sessionId}] LiveAvatar event: ${message.toString()}`);
  });
  ws.on("close", (code, reason) => {
    console.log(
      `[${sessionId}] LiveAvatar WebSocket closed: ${code} ${reason?.toString() || ""}`.trim()
    );
  });
  ws.on("error", (error) => {
    console.error(`[${sessionId}] LiveAvatar WebSocket error:`, error);
  });
}

function chunkPcmBase64(audioBase64) {
  const pcm = Buffer.from(audioBase64, "base64");
  const bytesPerSecond = 24000 * 2;
  const chunks = [];

  for (let offset = 0; offset < pcm.length; offset += bytesPerSecond) {
    chunks.push(pcm.subarray(offset, offset + bytesPerSecond).toString("base64"));
  }

  return chunks;
}

async function joinSession(sessionInfo, usageToken) {
  const sessionId = sessionInfo?.session_id;
  const livekitUrl = sessionInfo?.livekit_url;
  const livekitAgentToken = sessionInfo?.livekit_agent_token;
  const wsUrl = sessionInfo?.ws_url;

  if (!sessionId || !livekitUrl || !livekitAgentToken || !wsUrl) {
    throw new Error(
      "Missing session_id, livekit_url, livekit_agent_token, or ws_url in LiveAvatar start response."
    );
  }

  const existing = sessions.get(sessionId);
  if (existing) {
    if (USAGE_TRACKING_ENABLED && !existing.usage) existing.usage = await bindUsageSession(sessionId, usageToken);
    return existing;
  }

  const sessionRecord = {
    id: sessionId,
    wsUrl,
    livekitUrl,
    livekitAgentToken,
    room: new Room(),
    ws: null,
    connectedAt: new Date().toISOString(),
    keepAliveTimer: null,
    usage: null
  };

  await Promise.all([
    sessionRecord.room.connect(livekitUrl, livekitAgentToken, { autoSubscribe: true }),
    connectSessionWebSocket(sessionRecord)
  ]);

  sessionRecord.connectedAt = new Date().toISOString();
  sessionRecord.usage = await bindUsageSession(sessionId, usageToken);

  sessionRecord.room
    .on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[${sessionId}] participant connected: ${participant.identity}`);
    })
    .on(RoomEvent.Disconnected, (reason) => {
      console.log(`[${sessionId}] LiveKit room disconnected: ${reason || "unknown"}`);
      closeSession(sessionId).catch((error) => console.error(error));
    });

  sessionRecord.keepAliveTimer = setInterval(() => {
    try {
      sendSessionCommand(sessionRecord, {
        type: "session.keep_alive",
        event_id: randomUUID()
      });
    } catch (error) {
      console.warn(`[${sessionId}] keep_alive failed:`, error.message);
    }
  }, 60000);

  sessions.set(sessionId, sessionRecord);
  console.log(`[${sessionId}] LiveAvatar LITE agent joined.`);
  return sessionRecord;
}

async function speak(sessionId, audioBase64) {
  const sessionRecord = sessions.get(sessionId);
  if (!sessionRecord) {
    throw new Error(`No active LiveAvatar agent session for ${sessionId}.`);
  }

  await connectSessionWebSocket(sessionRecord);

  const eventId = randomUUID();
  for (const audio of chunkPcmBase64(audioBase64)) {
    sendSessionCommand(sessionRecord, {
      type: "agent.speak",
      event_id: eventId,
      audio
    });
  }

  sendSessionCommand(sessionRecord, {
    type: "agent.speak_end",
    event_id: eventId
  });

  return { eventId };
}

async function closeSession(sessionId) {
  const sessionRecord = sessions.get(sessionId);
  if (!sessionRecord) return;

  sessions.delete(sessionId);

  if (sessionRecord.keepAliveTimer) {
    clearInterval(sessionRecord.keepAliveTimer);
  }

  if (sessionRecord.ws && sessionRecord.ws.readyState === WebSocket.OPEN) {
    sessionRecord.ws.close();
  }

  if (sessionRecord.room?.isConnected) {
    await sessionRecord.room.disconnect();
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, {
        ok: true,
        sessionCount: sessions.size
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(req);
      const sessionRecord = await joinSession(body.sessionInfo || body, body.usageSessionToken);
      sendJson(req, res, 200, {
        success: true,
        sessionId: sessionRecord.id
      });
      return;
    }

    const speakMatch = url.pathname.match(/^\/sessions\/([^/]+)\/speak$/);
    if (req.method === "POST" && speakMatch) {
      const body = await readJson(req);
      if (!body.audioBase64) {
        sendJson(req, res, 400, { error: "Missing audioBase64." });
        return;
      }

      const result = await speak(decodeURIComponent(speakMatch[1]), body.audioBase64);
      sendJson(req, res, 200, {
        success: true,
        eventId: result.eventId
      });
      return;
    }

    const usageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/usage$/);
    if (req.method === "POST" && usageMatch) {
      const sessionRecord = sessions.get(decodeURIComponent(usageMatch[1]));
      if (!sessionRecord) {
        sendJson(req, res, 409, { error: "Usage session is no longer active." });
        return;
      }
      const result = await reportUsage(sessionRecord);
      sendJson(req, res, 200, { success: true, ...result });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "DELETE" && sessionMatch) {
      await closeSession(decodeURIComponent(sessionMatch[1]));
      sendJson(req, res, 200, { success: true });
      return;
    }

    sendJson(req, res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 500;
    sendJson(req, res, status, { error: status < 500 ? error.message : "Unable to process the request." });
  }
});

server.listen(PORT, () => {
  console.log(`LiveAvatar LITE agent server listening on http://localhost:${PORT}`);
});

async function shutdown() {
  for (const sessionId of Array.from(sessions.keys())) {
    await closeSession(sessionId);
  }
  await dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
