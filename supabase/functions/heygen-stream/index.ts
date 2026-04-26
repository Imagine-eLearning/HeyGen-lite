// ===== ENV VARIABLES =====
const HEYGEN_API_KEY = Deno.env.get("HeyGen_AI_Project");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID") || "ys3XeJJA4ArWMhRpcX1D";

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function getAudioFilename(mimeType: string) {
  if (mimeType.includes("webm")) return "input.webm";
  if (mimeType.includes("mp4")) return "input.mp4";
  if (mimeType.includes("mpeg")) return "input.mp3";
  if (mimeType.includes("wav")) return "input.wav";
  return "input.webm";
}

// ===== MAIN HANDLER =====
Deno.serve(async (req: Request) => {
  // ===== CORS =====
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    // ===== AUDIO PROCESSING ROUTE =====
    if (body.audio && body.sessionToken) {
      if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
        return createJsonResponse(
          {
            error:
              "Missing backend API keys. Set OPENAI_API_KEY and ELEVENLABS_API_KEY in the environment.",
          },
          500
        );
      }

      const audioMimeType = String(body.audioMimeType || "audio/webm");
      const audioBytes = decodeBase64(String(body.audio));
      const audioBlob = new Blob([audioBytes], { type: audioMimeType });
      const transcriptionForm = new FormData();
      transcriptionForm.append("file", audioBlob, getAudioFilename(audioMimeType));
      transcriptionForm.append("model", "whisper-1");

      const transcriptionResponse = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: transcriptionForm,
        }
      );

      if (!transcriptionResponse.ok) {
        const errorText = await transcriptionResponse.text();
        return createJsonResponse(
          {
            error: `Whisper transcription failed: ${transcriptionResponse.status} ${errorText}`,
          },
          500
        );
      }

      const transcriptionData = await transcriptionResponse.json();
      const userTranscript = String(transcriptionData.text || "").trim();

      if (!userTranscript) {
        return createJsonResponse(
          { error: "Transcription succeeded but returned no text." },
          500
        );
      }

      if (!/[A-Za-z0-9À-ž]/.test(userTranscript)) {
        return createJsonResponse({
          userTranscript,
          avatarResponse: "",
          ignored: true,
          success: true,
        });
      }

      const completionResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful avatar assistant. Respond naturally to the learner's spoken prompt.",
              },
              {
                role: "user",
                content: `Learner says: ${userTranscript}`,
              },
            ],
            temperature: 0.75,
            max_tokens: 250,
          }),
        }
      );

      if (!completionResponse.ok) {
        const errorText = await completionResponse.text();
        return createJsonResponse(
          {
            error: `OpenAI completion failed: ${completionResponse.status} ${errorText}`,
          },
          500
        );
      }

      const completionData = await completionResponse.json();
      const avatarResponse = String(
        completionData.choices?.[0]?.message?.content || ""
      ).trim();

      if (!avatarResponse) {
        return createJsonResponse(
          { error: "OpenAI returned an empty avatar response." },
          500
        );
      }

      const ttsResponse = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=pcm_24000`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY,
          },
          body: JSON.stringify({
            text: avatarResponse,
            model_id: "eleven_multilingual_v2",
          }),
        }
      );

      if (!ttsResponse.ok) {
        const errorText = await ttsResponse.text();
        return createJsonResponse(
          {
            error: `ElevenLabs TTS failed: ${ttsResponse.status} ${errorText}`,
          },
          500
        );
      }

      const audioBuffer = await ttsResponse.arrayBuffer();
      const audioBase64 = encodeBase64(new Uint8Array(audioBuffer));

      return createJsonResponse({
        userTranscript,
        avatarResponse,
        audioBase64,
        audioFormat: "pcm_24000",
        success: true,
      });
    }

    // ===== CREATE SESSION TOKEN (LITE MODE) =====
    if (String(body.mode || "").toUpperCase() === "LITE") {
      if (!HEYGEN_API_KEY) {
        return createJsonResponse(
          {
            error:
              "Missing HeyGen API key. Set the HeyGen_AI_Project secret in Supabase.",
          },
          500
        );
      }

      const avatarId = String(body.avatar_id || "").trim();
      if (!avatarId) {
        return createJsonResponse(
          { error: "Missing required avatar_id for LITE mode." },
          400
        );
      }
      const contextId = String(body.context_id || "").trim();

      const response = await fetch(
        "https://api.liveavatar.com/v1/sessions/token",
        {
          method: "POST",
          headers: {
            "X-API-KEY": HEYGEN_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "LITE",
            avatar_id: avatarId,
            ...(contextId ? { avatar_persona: { context_id: contextId } } : {}),
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return createJsonResponse(
          {
            error: `LiveAvatar API error: ${response.status} ${error}`,
          },
          500
        );
      }

      const data = await response.json();
      const sessionToken =
        data.sessionToken ||
        data.session_token ||
        data.token ||
        data.data?.session_token;

      if (!sessionToken) {
        return createJsonResponse(
          {
            error: "LiveAvatar token response did not include a session token.",
            details: data,
          },
          500
        );
      }

      return createJsonResponse({
        sessionToken,
        success: true,
      });
    }

    // ===== FALLBACK =====
    return createJsonResponse(
      { error: "Invalid request parameters" },
      400
    );
  } catch (error) {
    return createJsonResponse(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      500
    );
  }
});
