/* ============================================================
   Running Coach — server
   Serves the static frontend (index.html, process-editor.html,
   assets/) and a small JSON API backed by Postgres.
   ============================================================ */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { createPool, migrate, rowToAthlete } = require("./db");
const {
  hashPassword,
  verifyPassword,
  signCoachToken,
  signAthleteToken,
  authMiddleware,
  requireCoach,
  requireAthleteOrCoach,
} = require("./auth");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(authMiddleware);

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
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const hash = await hashPassword(newPassword);
  await pool.query("UPDATE coach SET password_hash = $1 WHERE id = 1", [hash]);
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
  };
  await pool.query(
    `INSERT INTO athletes (id, name, email, stage, data) VALUES ($1,$2,$3,0,$4)`,
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
app.get("/api/resources", requireCoach, async (req, res) => {
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------
   STATIC FRONTEND
   ------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, "..")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Running Coach server listening on :${PORT}`);
});
