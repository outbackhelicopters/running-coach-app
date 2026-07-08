/**
 * Strava OAuth relay for the Running Coach app.
 *
 * Why this exists: Strava's API requires a Client Secret to exchange an
 * OAuth code for an access token, and a secret can never live in a public
 * static HTML file (anyone could view-source and steal it). This Worker
 * holds that secret server-side, does the token exchange, stores tokens in
 * Cloudflare KV, and proxies activity requests — the browser never sees a
 * Strava secret or long-lived token.
 *
 * Routes:
 *   GET /connect?athleteId=XXX     -> redirects the browser to Strava's OAuth screen
 *   GET /callback?code=..&state=.. -> Strava redirects here after approval; exchanges
 *                                     the code for tokens, stores them, sends the
 *                                     browser back to the app
 *   GET /activities?athleteId=XXX  -> returns recent runs for a connected athlete
 *                                     (refreshes the access token if it's expired)
 *   GET /disconnect?athleteId=XXX  -> deletes the stored tokens for that athlete
 *
 * See SETUP.md in this folder for how to deploy this and wire it up.
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, env, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

async function exchangeToken(env, body) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...body,
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getValidTokens(env, athleteId) {
  const raw = await env.STRAVA_KV.get(`athlete:${athleteId}`);
  if (!raw) return null;
  let tokens = JSON.parse(raw);

  // Refresh if expired or about to expire in the next 60s
  if (Date.now() / 1000 > tokens.expires_at - 60) {
    const refreshed = await exchangeToken(env, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    if (!refreshed) return null;
    tokens = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    };
    await env.STRAVA_KV.put(`athlete:${athleteId}`, JSON.stringify(tokens));
  }
  return tokens;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // ---- /connect ----
    if (url.pathname === "/connect") {
      const athleteId = url.searchParams.get("athleteId");
      if (!athleteId) return new Response("Missing athleteId", { status: 400 });

      const redirectUri = `${url.origin}/callback`;
      const authorize = new URL("https://www.strava.com/oauth/authorize");
      authorize.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("approval_prompt", "auto");
      authorize.searchParams.set("scope", "activity:read_all");
      authorize.searchParams.set("state", athleteId);
      return Response.redirect(authorize.toString(), 302);
    }

    // ---- /callback ----
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const athleteId = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const appUrl = (env.APP_URL || "").replace(/\/$/, "");

      if (error) {
        return Response.redirect(`${appUrl}/#/dashboard/athlete/${athleteId}?strava=denied`, 302);
      }
      if (!code || !athleteId) return new Response("Missing code or state", { status: 400 });

      const tokenData = await exchangeToken(env, { code, grant_type: "authorization_code" });
      if (!tokenData) {
        return Response.redirect(`${appUrl}/#/dashboard/athlete/${athleteId}?strava=error`, 302);
      }

      await env.STRAVA_KV.put(
        `athlete:${athleteId}`,
        JSON.stringify({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_at,
          strava_athlete_id: tokenData.athlete && tokenData.athlete.id,
          strava_name: `${(tokenData.athlete && tokenData.athlete.firstname) || ""} ${(tokenData.athlete && tokenData.athlete.lastname) || ""}`.trim(),
        })
      );
      return Response.redirect(`${appUrl}/#/dashboard/athlete/${athleteId}?strava=connected`, 302);
    }

    // ---- /activities ----
    if (url.pathname === "/activities") {
      const athleteId = url.searchParams.get("athleteId");
      if (!athleteId) return json({ error: "Missing athleteId" }, env, 400);

      const tokens = await getValidTokens(env, athleteId);
      if (!tokens) return json({ connected: false }, env);

      const actRes = await fetch("https://www.strava.com/api/v3/athlete/activities?per_page=10", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!actRes.ok) return json({ connected: true, error: "fetch_failed" }, env);

      const activities = await actRes.json();
      const runs = activities
        .filter((act) => act.type === "Run" || act.sport_type === "Run")
        .map((act) => ({
          id: act.id,
          name: act.name,
          date: act.start_date_local,
          distanceKm: +(act.distance / 1000).toFixed(2),
          movingTimeMin: +(act.moving_time / 60).toFixed(1),
          avgPaceMinPerKm: act.distance > 0 ? +((act.moving_time / 60) / (act.distance / 1000)).toFixed(2) : null,
          elevationGain: act.total_elevation_gain,
        }));

      return json({ connected: true, athleteName: tokens.strava_name, activities: runs }, env);
    }

    // ---- /disconnect ----
    if (url.pathname === "/disconnect") {
      const athleteId = url.searchParams.get("athleteId");
      if (athleteId) await env.STRAVA_KV.delete(`athlete:${athleteId}`);
      return json({ ok: true }, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
