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

## Optional PaintScope SQ usage tracking

Usage tracking is disabled unless `USAGE_TRACKING_ENABLED=true`. When enabled,
the browser must supply an opaque, short-lived usage token issued only after
PaintScope access verification. The token is sent to Render once to bind it to
the LiveAvatar session; no secret is present in browser code.

Configure these Render secrets:

```text
USAGE_TRACKING_ENABLED=true
SUPABASE_BIND_AI_USAGE_URL=https://<project>.supabase.co/functions/v1/bind-ai-usage-session
SUPABASE_RECORD_AI_USAGE_URL=https://<project>.supabase.co/functions/v1/record-ai-usage
AI_USAGE_INGEST_SECRET=<same value configured in Supabase>
USAGE_ALLOWED_ORIGINS=https://<approved-avatar-host>,https://<approved-gcs-host>
```

`USAGE_ALLOWED_ORIGINS` is an exact, comma-separated production allowlist. Do
not use `*`; add local origins only in a test environment. The application
records server-derived duration once per Render session and relies on Supabase
ledger idempotency for repeat reports.

The browser page defaults to `http://localhost:8788`. For production, host this
service on a public HTTPS URL and set:

```html
<script>
  window.LIVEKIT_AGENT_SERVER_URL = "https://your-agent-server.example";
</script>
```

before the module script in `index.html`.
