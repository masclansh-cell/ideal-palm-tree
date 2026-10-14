# Limited Radar — Roblox Limited deal scanner

A hobby prototype with a Node.js backend and dark web dashboard. It:
- searches Roblox's public Collectibles catalog endpoint for a limited number of pages;
- checks each discovered asset's public reseller endpoint, paced sequentially;
- compares the lowest returned reseller price against your chosen Robux limit;
- posts newly found hits to a Discord channel through a webhook;
- offers a dashboard for price limit, scan page count, and automatic scan interval.

## Important limitations

This is a **best-effort prototype**, not a complete Roblox-wide price index:
- It does not guarantee discovery of every Limited. The catalog search API is experimental and pagination/sorting may change.
- The reseller endpoint may be rate-limited (HTTP 429), unavailable, or change without notice.
- Scanning 30 assets can take a while because lookups are intentionally paced. Increasing pages increases API calls and may trigger rate limits.
- On Render's free web service, the server sleeps after inactivity and may restart; scheduled scans do not run while it is asleep. Local in-memory deals and notification history reset on restart/redeploy. A free host cannot promise 24/7 scanning.
- Discord alerts require a webhook. This sends to a channel webhook, not a private DM. To alert a DM, use a properly configured Discord bot and bot token; never use a user token/self-bot.
- Do not enter a Roblox password, session cookie, or other Roblox login credential.

## Run locally (Windows)

1. Install Node.js 20 or newer from https://nodejs.org/
2. Extract this folder.
3. Open Command Prompt in this folder.
4. Run:
   ```bat
   npm install
   set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/PUT_YOUR_WEBHOOK_HERE
   npm start
   ```
   You may omit the `set` line if you are not ready to configure Discord.
5. Open http://localhost:10000

In PowerShell, set the variable for the current session with:
```powershell
$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/PUT_YOUR_WEBHOOK_HERE"
npm start
```

## Create a Discord channel webhook

1. In Discord, open the channel where you want alerts.
2. Open **Edit Channel → Integrations → Webhooks → New Webhook** (wording may vary).
3. Copy the webhook URL. Treat it like a password: anyone who has it can post to that channel.
4. In Render, add it as the `DISCORD_WEBHOOK_URL` environment variable. Do not paste it into public source code or share it.

## Deploy free on Render

1. Create accounts at https://github.com/ and https://render.com/ if needed.
2. Create a **new private GitHub repository** named `limited-radar`.
3. Upload the contents of this folder to the repository root. Ensure `server.js`, `package.json`, `render.yaml`, and `public/index.html` are at the root/paths shown here.
4. In Render, choose **New → Blueprint** (or create a Web Service manually) and connect your repository.
5. If using the Blueprint, review the `limited-radar` service and approve creation. If creating manually, use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance plan: Free
6. In the Render service's **Environment** settings, add `DISCORD_WEBHOOK_URL` with your Discord channel webhook URL. Keep it secret.
7. Deploy and wait for the service to finish. Open its `https://YOUR-SERVICE.onrender.com` URL.
8. In Limited Radar, set the max price and pages, click **Save settings**, then **Scan for Limited deals**.

## API routes

- `GET /health` — health check
- `GET /api/status` — config, latest deals, and logs
- `POST /api/config` — JSON `{ "maxPrice": 500, "pages": 3, "intervalMinutes": 15, "enabled": true }`
- `POST /api/scan` — trigger a scan

## Security note

This starter is intended for a personal deployment. The dashboard endpoints are not protected by login, so keep the GitHub repository private and do not share the deployed URL widely. Anyone who knows the URL could change settings or trigger scans. For a public deployment, add authentication/rate limiting before using it.
