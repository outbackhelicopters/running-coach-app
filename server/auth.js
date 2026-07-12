/* ============================================================
   AUTH — bcrypt password hashing + JWT session tokens.
   Two roles: "coach" (one account, full access) and "athlete"
   (scoped to their own record only).
   ============================================================ */
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET environment variable must be set to a long random string.");
  }
  return secret;
}

function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
function verifyPassword(pw, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(pw, hash);
}

function signCoachToken() {
  return jwt.sign({ role: "coach" }, getSecret(), { expiresIn: "30d" });
}
function signAthleteToken(athleteId) {
  return jwt.sign({ role: "athlete", athleteId }, getSecret(), { expiresIn: "30d" });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  req.auth = token ? verifyToken(token) : null;
  next();
}
function requireCoach(req, res, next) {
  if (!req.auth || req.auth.role !== "coach") {
    return res.status(401).json({ error: "Coach login required" });
  }
  next();
}
// Allows the coach (any athlete id) or the athlete themself (their own id only).
function requireAthleteOrCoach(req, res, next) {
  const id = req.params.id;
  if (req.auth && req.auth.role === "coach") return next();
  if (req.auth && req.auth.role === "athlete" && req.auth.athleteId === id) return next();
  return res.status(401).json({ error: "Login required" });
}

module.exports = {
  hashPassword,
  verifyPassword,
  signCoachToken,
  signAthleteToken,
  verifyToken,
  authMiddleware,
  requireCoach,
  requireAthleteOrCoach,
};
