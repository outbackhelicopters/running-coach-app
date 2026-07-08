# Strava setup

Real Strava integration (athletes connect their account, their runs show up automatically) needs a tiny piece of backend, because Strava's API requires a Client Secret that can never sit in a public static file — anyone could view-source `index.html` and steal it. This folder contains a small Cloudflare Worker (free tier is plenty for this) that holds the secret and does the OAuth handshake on your behalf. The app talks to the Worker; the Worker talks to Strava; your secret never reaches the browser.

Costs nothing at this scale (Cloudflare's free plan covers 100,000 requests/day).

## 1. Create a Strava API application

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an application (any name/website works — this is just for API access, not published anywhere).
2. Note your **Client ID** and **Client Secret**.
3. Leave "Authorization Callback Domain" for now — you'll set it once you know your Worker's URL (step 4 below).

## 2. Install Wrangler (Cloudflare's CLI)

```
npm install -g wrangler
wrangler login
```

This opens a browser to connect your Cloudflare account (free signup at cloudflare.com if you don't have one).

## 3. Create the KV namespace (where connected athletes' tokens are stored)

From this folder:

```
wrangler kv namespace create STRAVA_KV
```

It prints an `id`. Paste it into `wrangler.toml` in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 4. Set your app's URL

Edit `wrangler.toml`:
- `APP_URL` — where your app is actually hosted, e.g. `https://yourusername.github.io/your-repo` (no trailing slash).
- `ALLOWED_ORIGIN` — usually just the scheme + host part, e.g. `https://yourusername.github.io`.

## 5. Set your Strava secrets

These are stored encrypted by Cloudflare, never written to a file:

```
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
```

Paste the values from step 1 when prompted.

## 6. Deploy

```
wrangler deploy
```

It prints your Worker's URL, something like:

```
https://running-coach-strava.yourname.workers.dev
```

## 7. Finish the loop

1. Back in [strava.com/settings/api](https://www.strava.com/settings/api), set **Authorization Callback Domain** to your Worker's domain only — no `https://`, no path. Just `running-coach-strava.yourname.workers.dev`.
2. Open `index.html`, find `CONFIG.STRAVA_WORKER_URL`, and paste your Worker's URL in.
3. Re-deploy/redeploy `index.html` wherever it's hosted.

## Using it

Once set up, each athlete's **Overview** tab in the dashboard shows a "Connect Strava" link — send it to them, or click it yourself if you're connecting on their behalf. Once connected, their recent runs (date, distance, time, pace) show up automatically at the top of their **Weekly Check-ins** tab, so you've got real data in front of you while you write the check-in.

No polling or webhooks — activities are fetched fresh each time you open the Check-ins tab (or hit Refresh), which keeps this simple and avoids Strava's stricter webhook approval process.

## If something's not working

- **"Not set up yet" message never goes away** — double check `CONFIG.STRAVA_WORKER_URL` in `index.html` has no typo and no trailing slash mismatch with what you deployed.
- **Redirects to a Strava error page** — the "Authorization Callback Domain" in your Strava API settings must exactly match your Worker's domain (no `https://`, no trailing slash, no path).
- **Connects but no activities show up** — the athlete needs actual `Run`-type activities on Strava; other activity types are filtered out. Also confirm the scope requested (`activity:read_all`) was approved during connect.
- **`wrangler deploy` fails** — run `wrangler whoami` to confirm you're logged into the right Cloudflare account, and that the KV namespace id in `wrangler.toml` matches what `wrangler kv namespace create` printed.
