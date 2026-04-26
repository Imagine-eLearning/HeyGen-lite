import { Room, RoomEvent, dispose } from "@livekit/rtc-node";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8788);
const sessions = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(body));
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

function chunkPcmBase64(audioBase64) {
  const pcm = Buffer.from(audioBase64, "base64");
  const bytesPerSecond = 24000 * 2;
  const chunks = [];

  for (let offset = 0; offset < pcm.length; offset += bytesPerSecond) {
    chunks.push(pcm.subarray(offset, offset + bytesPerSecond).toString("base64"));
  }

  return chunks;
}

async function joinSession(sessionInfo) {
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
    return existing;
  }

  const room = new Room();
  const ws = new WebSocket(wsUrl);

  await Promise.all([
    room.connect(livekitUrl, livekitAgentToken, { autoSubscribe: true }),
    waitForWebSocketOpen(ws)
  ]);
  await waitForSessionConnected(ws);

  const sessionRecord = {
    id: sessionId,
    room,
    ws,
    connectedAt: new Date().toISOString(),
    keepAliveTimer: null
  };

  room
    .on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[${sessionId}] participant connected: ${participant.identity}`);
    })
    .on(RoomEvent.Disconnected, (reason) => {
      console.log(`[${sessionId}] LiveKit room disconnected: ${reason || "unknown"}`);
      closeSession(sessionId).catch((error) => console.error(error));
    });

  ws.on("message", (message) => {
    console.log(`[${sessionId}] LiveAvatar event: ${message.toString()}`);
  });
  ws.on("close", () => {
    console.log(`[${sessionId}] LiveAvatar WebSocket closed.`);
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
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        sessions: Array.from(sessions.keys())
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(req);
      const sessionRecord = await joinSession(body.sessionInfo || body);
      sendJson(res, 200, {
        success: true,
        sessionId: sessionRecord.id
      });
      return;
    }

    const speakMatch = url.pathname.match(/^\/sessions\/([^/]+)\/speak$/);
    if (req.method === "POST" && speakMatch) {
      const body = await readJson(req);
      if (!body.audioBase64) {
        sendJson(res, 400, { error: "Missing audioBase64." });
        return;
      }

      const result = await speak(decodeURIComponent(speakMatch[1]), body.audioBase64);
      sendJson(res, 200, {
        success: true,
        eventId: result.eventId
      });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "DELETE" && sessionMatch) {
      await closeSession(decodeURIComponent(sessionMatch[1]));
      sendJson(res, 200, { success: true });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error"
    });
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
