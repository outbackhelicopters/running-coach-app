/* ============================================================
   Running Coach — server
   Serves the static frontend (index.html, process-editor.html,
   assets/) and a small JSON API backed by Postgres.
   ============================================================ */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const { createPool, migrate, rowToAthlete } = require("./db");
const { getPlan } = require("./plans");
const {
  hashPassword,
  verifyPassword,
  signCoachToken,
  signAthleteToken,
  authMiddleware,
  requireCoach,
  requireAthleteOrCoach,
  requireAnyLogin,
} = require("./auth");

const app = express();
// Stash the raw request body alongside the parsed one — Stripe webhook
// signature verification needs the exact original bytes, not a
// re-serialized version of the parsed JSON.
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(authMiddleware);

/* ------------------------------------------------------------
   STRIPE — two entirely separate accounts, one per region, each
   with its own secret key + webhook signing secret via env vars.
   Both are optional at boot so the app still runs before they're
   configured; endpoints that need them fail with a clear error.
   ------------------------------------------------------------ */
const stripeClients = {
  AU: process.env.STRIPE_SECRET_KEY_AU ? new Stripe(process.env.STRIPE_SECRET_KEY_AU) : null,
  UK: process.env.STRIPE_SECRET_KEY_UK ? new Stripe(process.env.STRIPE_SECRET_KEY_UK) : null,
};
const stripeWebhookSecrets = {
  AU: process.env.STRIPE_WEBHOOK_SECRET_AU || "",
  UK: process.env.STRIPE_WEBHOOK_SECRET_UK || "",
};
function getStripeClient(region) {
  const client = stripeClients[region];
  if (!client) throw new Error(`Stripe is not configured for region ${region}`);
  return client;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — try again in a few minutes." },
});

const pool = createPool();
let ready = migrate(pool).catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
app.use(async (req, res, next) => {
  try {
    await ready;
    next();
  } catch (e) {
    res.status(503).json({ error: "Database not ready" });
  }
});

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/* ------------------------------------------------------------
   COACH AUTH
   ------------------------------------------------------------ */
app.get("/api/coach/status", async (req, res) => {
  const r = await pool.query("SELECT id FROM coach WHERE id = 1");
  res.json({ exists: r.rowCount > 0 });
});

app.post("/api/coach/setup", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "Email and an 8+ character password are required" });
  }
  const existing = await pool.query("SELECT id FROM coach WHERE id = 1");
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: "A coach account already exists — log in instead" });
  }
  const hash = await hashPassword(password);
  await pool.query("INSERT INTO coach (id, email, password_hash) VALUES (1, $1, $2)", [
    email.trim().toLowerCase(),
    hash,
  ]);
  res.json({ token: signCoachToken() });
});

app.post("/api/coach/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query("SELECT email, password_hash FROM coach WHERE id = 1");
  if (r.rowCount === 0) return res.status(404).json({ error: "No coach account set up yet" });
  const row = r.rows[0];
  if ((email || "").trim().toLowerCase() !== row.email || !(await verifyPassword(password || "", row.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }
  res.json({ token: signCoachToken() });
});

app.put("/api/coach/password", requireCoach, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  const r = await pool.query("SELECT password_hash FROM coach WHERE id = 1");
  if (r.rowCount === 0) return res.status(404).json({ error: "No coach account found" });
  if (!(await verifyPassword(currentPassword || "", r.rows[0].password_hash))) {
    return res.status(403).json({ error: "Current password is incorrect" });
  }
  const hash = await hashPassword(newPassword);
  await pool.query("UPDATE coach SET password_hash = $1 WHERE id = 1", [hash]);
  res.json({ ok: true });
});

app.put("/api/coach/email", requireCoach, async (req, res) => {
  const { currentPassword, newEmail } = req.body || {};
  const email = (newEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  const r = await pool.query("SELECT password_hash FROM coach WHERE id = 1");
  if (r.rowCount === 0) return res.status(404).json({ error: "No coach account found" });
  if (!(await verifyPassword(currentPassword || "", r.rows[0].password_hash))) {
    return res.status(403).json({ error: "Current password is incorrect" });
  }
  await pool.query("UPDATE coach SET email = $1 WHERE id = 1", [email]);
  res.json({ ok: true, email });
});

/* ------------------------------------------------------------
   COACH SETTINGS (access codes for free/comp athlete access —
   payment status itself lives on the athlete record and is set via
   the normal PUT /api/athletes/:id, same as any other field)
   ------------------------------------------------------------ */
app.get("/api/coach/settings", requireCoach, async (req, res) => {
  const r = await pool.query("SELECT settings FROM coach WHERE id = 1");
  res.json((r.rowCount && r.rows[0].settings) || {});
});

app.put("/api/coach/settings", requireCoach, async (req, res) => {
  const settings = req.body || {};
  await pool.query("UPDATE coach SET settings = $1 WHERE id = 1", [settings]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------
   ATHLETE AUTH
   ------------------------------------------------------------ */
app.post("/api/athlete/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const r = await pool.query("SELECT id, password_hash FROM athletes WHERE lower(email) = lower($1)", [
    (email || "").trim(),
  ]);
  if (r.rowCount === 0) return res.status(401).json({ error: "Incorrect email or password" });
  const row = r.rows[0];
  if (!row.password_hash || !(await verifyPassword(password, row.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }
  res.json({ token: signAthleteToken(row.id), athleteId: row.id });
});

/* ------------------------------------------------------------
   ATHLETES — coach-only list/create/delete/password/full-update
   ------------------------------------------------------------ */
app.get("/api/athletes", requireCoach, async (req, res) => {
  const r = await pool.query("SELECT * FROM athletes ORDER BY created_at DESC");
  res.json(r.rows.map(rowToAthlete));
});

app.post("/api/athletes", requireCoach, async (req, res) => {
  const a = req.body || {};
  if (!a.id) return res.status(400).json({ error: "Athlete id is required" });
  await pool.query(
    `INSERT INTO athletes (id, name, email, stage, data)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=$2, email=$3, stage=$4, data=$5, updated_at=now()`,
    [a.id, a.name || "", a.email || "", a.stage || 0, a]
  );
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [a.id]);
  res.json(rowToAthlete(r.rows[0]));
});

app.delete("/api/athletes/:id", requireCoach, async (req, res) => {
  await pool.query("DELETE FROM athletes WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.put("/api/athletes/:id/password", requireCoach, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const check = await pool.query("SELECT email FROM athletes WHERE id = $1", [req.params.id]);
  if (check.rowCount === 0) return res.status(404).json({ error: "Athlete not found" });
  if (!check.rows[0].email) {
    return res.status(400).json({ error: "Add an email for this athlete before setting a password" });
  }
  const hash = await hashPassword(password);
  await pool.query("UPDATE athletes SET password_hash = $1, updated_at = now() WHERE id = $2", [
    hash,
    req.params.id,
  ]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------
   ATHLETES — coach OR the athlete themself
   ------------------------------------------------------------ */
app.get("/api/athletes/:id", requireAthleteOrCoach, async (req, res) => {
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
  res.json(rowToAthlete(r.rows[0]));
});

// Full replace — coach only (athletes use the narrower endpoints below so
// they can never overwrite plan content, stage, personal bests, etc).
app.put("/api/athletes/:id", requireCoach, async (req, res) => {
  const a = req.body || {};
  a.id = req.params.id;
  await pool.query(
    `INSERT INTO athletes (id, name, email, stage, data)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=$2, email=$3, stage=$4, data=$5, updated_at=now()`,
    [a.id, a.name || "", a.email || "", a.stage || 0, a]
  );
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [a.id]);
  res.json(rowToAthlete(r.rows[0]));
});

// Athlete (or coach) marks a single session complete/incomplete — the one
// write a logged-in athlete is allowed to make to their plan.
app.patch("/api/athletes/:id/session", requireAthleteOrCoach, async (req, res) => {
  const { weekId, sessionId, completed, actual } = req.body || {};
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
  const data = r.rows[0].data || {};
  const weeks = (data.plan && data.plan.weeks) || [];
  const week = weeks.find((w) => w.id === weekId);
  if (!week) return res.status(404).json({ error: "Week not found" });
  const session = (week.sessions || []).find((s) => s.id === sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.completed = !!completed;
  session.actual = actual || session.actual || {};
  await pool.query("UPDATE athletes SET data = $1, updated_at = now() WHERE id = $2", [data, req.params.id]);
  res.json(rowToAthlete({ ...r.rows[0], data }));
});

// Athlete (or coach) updates which week they're currently viewing.
app.patch("/api/athletes/:id/current-week", requireAthleteOrCoach, async (req, res) => {
  const { weekIndex } = req.body || {};
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
  const data = r.rows[0].data || {};
  data.currentWeekIndex = Math.max(0, parseInt(weekIndex, 10) || 0);
  await pool.query("UPDATE athletes SET data = $1, updated_at = now() WHERE id = $2", [data, req.params.id]);
  res.json(rowToAthlete({ ...r.rows[0], data }));
});

// Athlete (or coach) redeems a coach-issued access code to unlock dashboard
// access for free (giveaways, trial runners) without going through payment.
// Narrow and safe despite being athlete-writable: it can only ever flip
// paymentStatus to "comp" after validating against the coach's own code
// list, never touch anything else on the record.
app.post("/api/athletes/:id/redeem-code", requireAthleteOrCoach, async (req, res) => {
  const code = String((req.body || {}).code || "").trim();
  if (!code) return res.status(400).json({ error: "Enter a code" });
  const settingsRow = await pool.query("SELECT settings FROM coach WHERE id = 1");
  const codes = (settingsRow.rowCount && settingsRow.rows[0].settings && settingsRow.rows[0].settings.accessCodes) || [];
  const entry = codes.find((c) => c.code && c.code.toLowerCase() === code.toLowerCase() && c.active !== false);
  if (!entry) return res.status(404).json({ error: "That code isn't valid or has been deactivated" });
  if (entry.maxUses && (entry.usedCount || 0) >= entry.maxUses) {
    return res.status(410).json({ error: "That code has already been fully redeemed" });
  }
  const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
  const data = r.rows[0].data || {};
  data.paymentStatus = "comp";
  data.accessCode = entry.code;
  await pool.query("UPDATE athletes SET data = $1, updated_at = now() WHERE id = $2", [data, req.params.id]);
  entry.usedCount = (entry.usedCount || 0) + 1;
  const settings = (settingsRow.rowCount && settingsRow.rows[0].settings) || {};
  settings.accessCodes = codes;
  await pool.query("UPDATE coach SET settings = $1 WHERE id = 1", [settings]);
  res.json(rowToAthlete({ ...r.rows[0], data }));
});

/* ------------------------------------------------------------
   PUBLIC — inquiry form + questionnaire (no auth; the athlete
   isn't a user yet at this point in the funnel)
   ------------------------------------------------------------ */
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

app.post("/api/inquiry", publicLimiter, async (req, res) => {
  const data = req.body || {};
  const id = newId();
  const athlete = {
    id,
    createdAt: Date.now(),
    stage: 0,
    name: data.name || "",
    email: data.email || "",
    phone: data.phone || "",
    inquiry: data,
    paymentStatus: "pending",
  };
  await pool.query(
    `INSERT INTO athletes (id, name, email, stage, data) VALUES ($1,$2,$3,0,$4)`,
    [id, athlete.name, athlete.email, athlete]
  );
  res.json({ id });
});

// Anonymous full-questionnaire submission — a brand-new visitor going
// straight from the homepage "Start Coaching" CTA to the full questionnaire,
// with no existing athlete record yet. Creates one from scratch, same as
// /api/inquiry does, but starts them further along the pipeline (stage 2)
// since a completed questionnaire is a much stronger signal than a bare inquiry.
app.post("/api/questionnaire", publicLimiter, async (req, res) => {
  const data = req.body || {};
  const id = newId();
  const athlete = {
    id,
    createdAt: Date.now(),
    stage: 2,
    name: data.fullName || "",
    email: data.email || "",
    phone: data.phone || "",
    questionnaire: data,
    paymentStatus: "pending",
  };
  await pool.query(
    `INSERT INTO athletes (id, name, email, stage, data) VALUES ($1,$2,$3,2,$4)`,
    [id, athlete.name, athlete.email, athlete]
  );
  res.json({ id });
});

app.post("/api/questionnaire/:athleteId", publicLimiter, async (req, res) => {
  const data = req.body || {};
  const r = await pool.query("SELECT data, stage FROM athletes WHERE id = $1", [req.params.athleteId]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
  const athlete = r.rows[0].data || {};
  athlete.questionnaire = data;
  athlete.name = athlete.name || data.fullName || "";
  athlete.email = athlete.email || data.email || "";
  athlete.phone = athlete.phone || data.phone || "";
  const newStage = Math.max(r.rows[0].stage || 0, 2);
  athlete.stage = newStage;
  await pool.query("UPDATE athletes SET data=$1, name=$2, email=$3, stage=$4, updated_at=now() WHERE id=$5", [
    athlete,
    athlete.name,
    athlete.email,
    newStage,
    req.params.athleteId,
  ]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------
   RESOURCES (content library) — coach-only
   ------------------------------------------------------------ */
// Read is open to any logged-in user (coach or athlete) — the whole
// point of the library is athletes can see what the coach shares.
// Writes (add/delete) stay coach-only, just below.
app.get("/api/resources", requireAnyLogin, async (req, res) => {
  const r = await pool.query("SELECT * FROM resources ORDER BY created_at DESC");
  res.json(r.rows);
});
app.post("/api/resources", requireCoach, async (req, res) => {
  const { category, title, body, link } = req.body || {};
  if (!title) return res.status(400).json({ error: "Title is required" });
  const id = newId();
  await pool.query(
    "INSERT INTO resources (id, category, title, body, link) VALUES ($1,$2,$3,$4,$5)",
    [id, category || "Other", title, body || "", link || ""]
  );
  const r = await pool.query("SELECT * FROM resources WHERE id = $1", [id]);
  res.json(r.rows[0]);
});
app.delete("/api/resources/:id", requireCoach, async (req, res) => {
  await pool.query("DELETE FROM resources WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------
   STRIPE CHECKOUT — region-aware, catalog-driven (never trusts a
   client-submitted price). Anonymous visitors can start a checkout
   with no athleteId (a lead is created from it once payment lands,
   via the webhook below). If athleteId is set, this checkout is
   meant to unlock that specific athlete's dashboard — only that
   athlete (or the coach) may attach their own id, so a stranger's
   payment can't get pointed at someone else's account.
   ------------------------------------------------------------ */
app.post("/api/checkout/create-session", publicLimiter, async (req, res) => {
  const { region, planId, athleteId } = req.body || {};
  if (region !== "AU" && region !== "UK") return res.status(400).json({ error: "Invalid region" });
  const plan = getPlan(region, planId);
  if (!plan) return res.status(400).json({ error: "Invalid plan" });

  let athlete = null;
  if (athleteId) {
    const isAllowed =
      req.auth && (req.auth.role === "coach" || (req.auth.role === "athlete" && req.auth.athleteId === athleteId));
    if (!isAllowed) return res.status(401).json({ error: "Login required to link this purchase to your account" });
    const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [athleteId]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Athlete not found" });
    athlete = rowToAthlete(r.rows[0]);
  }

  try {
    const stripe = getStripeClient(region);
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      line_items: [
        {
          price_data: {
            currency: plan.currency,
            product_data: { name: plan.name },
            unit_amount: plan.unitAmount,
            ...(plan.mode === "subscription"
              ? { recurring: { interval: plan.interval, interval_count: plan.intervalCount || 1 } }
              : {}),
          },
          quantity: 1,
        },
      ],
      customer_email: athlete && athlete.email ? athlete.email : undefined,
      success_url: `${origin}/#/payment-success`,
      cancel_url: `${origin}/#/payment-cancelled`,
      metadata: {
        region,
        planId,
        athleteId: athleteId || "",
        gatesAccess: plan.gatesAccess ? "1" : "",
      },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe checkout session error:", e.message);
    res.status(500).json({ error: "Couldn't start checkout — try again shortly" });
  }
});

// Two Stripe accounts = two webhook endpoints, distinguished by ?region=.
// Each is verified against that region's own signing secret, so a payload
// (even a genuinely-signed one) can never be replayed against the wrong
// account's secret.
app.post("/api/stripe/webhook", async (req, res) => {
  const region = req.query.region === "UK" ? "UK" : req.query.region === "AU" ? "AU" : null;
  if (!region) return res.status(400).send("Missing or invalid region");
  const secret = stripeWebhookSecrets[region];
  if (!secret) return res.status(500).send("Webhook not configured for this region");

  let event;
  try {
    const stripe = getStripeClient(region);
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], secret);
  } catch (err) {
    console.error(`Stripe webhook (${region}) signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};
    const gatesAccess = meta.gatesAccess === "1";
    try {
      if (meta.athleteId) {
        const r = await pool.query("SELECT * FROM athletes WHERE id = $1", [meta.athleteId]);
        if (r.rowCount) {
          const data = r.rows[0].data || {};
          if (gatesAccess) data.paymentStatus = "active";
          data.stripe = Object.assign({}, data.stripe, {
            region: meta.region,
            planId: meta.planId,
            customerId: session.customer || (data.stripe && data.stripe.customerId) || "",
            subscriptionId: session.subscription || (data.stripe && data.stripe.subscriptionId) || "",
            lastCheckoutAt: Date.now(),
          });
          await pool.query("UPDATE athletes SET data = $1, updated_at = now() WHERE id = $2", [
            data,
            meta.athleteId,
          ]);
        }
      } else {
        // Anonymous purchase from the public pricing section — create a new
        // lead so the coach can follow up, same pattern as /api/inquiry.
        const id = newId();
        const details = session.customer_details || {};
        const athlete = {
          id,
          createdAt: Date.now(),
          stage: 0,
          name: details.name || "",
          email: details.email || "",
          phone: "",
          inquiry: { source: "Stripe checkout", plan: meta.planId, region: meta.region },
          paymentStatus: gatesAccess ? "active" : "pending",
          stripe: {
            region: meta.region,
            planId: meta.planId,
            customerId: session.customer || "",
            subscriptionId: session.subscription || "",
            lastCheckoutAt: Date.now(),
          },
        };
        await pool.query(`INSERT INTO athletes (id, name, email, stage, data) VALUES ($1,$2,$3,0,$4)`, [
          id,
          athlete.name,
          athlete.email,
          athlete,
        ]);
      }
    } catch (e) {
      // Signature already verified at this point — an internal error here
      // shouldn't make Stripe retry forever, so still ack with 200.
      console.error(`Stripe webhook (${region}) handling error:`, e.message);
    }
  }

  res.json({ received: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------
   STATIC FRONTEND
   ------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, "..")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Running Coach server listening on :${PORT}`);
});
