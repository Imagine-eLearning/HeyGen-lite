# LiveAvatar LITE Agent Server

This process keeps the required LiveKit agent participant connected for a
LiveAvatar LITE session and forwards PCM 16-bit 24 kHz TTS audio to the
LiveAvatar session WebSocket.

Supabase Edge Functions are request/response and should not be used for this
long-lived room connection.

## Run locally

```bash
cd agent-server
npm install
npm start
```

The browser page defaults to `http://localhost:8788`. For production, host this
service on a public HTTPS URL and set:

```html
<script>
  window.LIVEKIT_AGENT_SERVER_URL = "https://your-agent-server.example";
</script>
```

before the module script in `index.html`.
