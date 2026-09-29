"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.env.APP_PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = 32 * 1024;
const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const PASSWORD_HASH_ITERATIONS = 210000;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    role: user.role || "Consultor",
    showUserArea: user.showUserArea !== false
  };
}

function readAgenda(dataFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (!Array.isArray(parsed.users) || !Array.isArray(parsed.activities) || String(parsed.sessionSecret || "").length < 32) {
      throw new Error("O arquivo privado precisa conter users, activities e uma chave de sessão.");
    }
    const userIds = new Set();
    const emails = new Set();
    for (const user of parsed.users) {
      const email = normalizeEmail(user.email);
      const legacyPassword = /^[a-f\d]{64}$/i.test(String(user.passwordHash || ""));
      const derivedPassword = user.passwordScheme === "pbkdf2-sha256"
        && /^[a-f\d]{64}$/i.test(String(user.passwordHash || ""))
        && /^[A-Za-z\d_-]{16,}$/i.test(String(user.passwordSalt || ""))
        && Number.isInteger(user.passwordIterations)
        && user.passwordIterations >= 100000
        && user.passwordIterations <= 1000000;
      if (!user.id || !email || (!legacyPassword && !derivedPassword)) {
        throw new Error("Há um perfil inválido no arquivo privado da agenda.");
      }
      if (userIds.has(String(user.id)) || emails.has(email)) {
        throw new Error("O arquivo privado contém perfis duplicados.");
      }
      userIds.add(String(user.id));
      emails.add(email);
    }
    for (const activity of parsed.activities) {
      if (!activity.id || !activity.owner || !userIds.has(String(activity.owner)) || !activity.subject || !activity.date) {
        throw new Error("Há uma atividade inválida ou sem responsável no arquivo privado.");
      }
    }
    return {
      sessionSecret: parsed.sessionSecret,
      users: parsed.users.map((user) => ({ ...user, email: normalizeEmail(user.email) })),
      activities: parsed.activities
    };
  } catch (error) {
    const wrapped = new Error(`Agenda privada indisponível: ${error.message}`);
    wrapped.code = "AGENDA_UNAVAILABLE";
    throw wrapped;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || origin === "null" || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("A solicitação excede o limite permitido."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

function constantTimeHashMatch(candidate, expected) {
  if (!/^[a-f\d]{64}$/i.test(candidate) || !/^[a-f\d]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

function verifyPassword(password, user) {
  if (user.passwordScheme === "pbkdf2-sha256") {
    const salt = Buffer.from(user.passwordSalt, "base64url");
    const expected = Buffer.from(user.passwordHash, "hex");
    const actual = crypto.pbkdf2Sync(String(password || ""), salt, user.passwordIterations, expected.length, "sha256");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  const candidate = crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
  return constantTimeHashMatch(candidate, user.passwordHash);
}

function createAppServer({ dataFile = process.env.ACTIVITY_DATA_FILE || path.join(ROOT, "data", "agenda.json") } = {}) {
  let agenda;
  let agendaError = "";
  try {
    agenda = readAgenda(path.resolve(dataFile));
  } catch (error) {
    agendaError = error.message;
  }

  const loginAttempts = new Map();

  function getUserById(id) {
    return agenda?.users.find((user) => String(user.id) === String(id)) || null;
  }

  function signToken(type, userId, expiresAt, sessionId) {
    const payload = Buffer.from(JSON.stringify({ type, userId, expiresAt, sessionId })).toString("base64url");
    const signature = crypto.createHmac("sha256", agenda.sessionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function verifyToken(token, expectedType) {
    const [payload, signature, ...extra] = String(token || "").split(".");
    if (!payload || !signature || extra.length) return null;
    const expected = crypto.createHmac("sha256", agenda.sessionSecret).update(payload).digest();
    let received;
    try { received = Buffer.from(signature, "base64url"); } catch { return null; }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (claims.type !== expectedType || !claims.userId || !claims.sessionId || Number(claims.expiresAt) <= Math.floor(Date.now() / 1000)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  function issueSession(userId) {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = crypto.randomBytes(24).toString("base64url");
    const accessExpiresAt = now + Math.floor(ACCESS_TTL_MS / 1000);
    return {
      access_token: signToken("access", userId, accessExpiresAt, sessionId),
      refresh_token: signToken("refresh", userId, now + REFRESH_TTL_SECONDS, sessionId),
      expires_at: accessExpiresAt
    };
  }

  function authenticate(req) {
    const token = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const claims = verifyToken(token, "access");
    const user = claims && getUserById(claims.userId);
    return user ? { session: claims, user } : null;
  }

  function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      sendJson(res, 400, { error: "Caminho inválido." });
      return true;
    }
    const filePath = path.resolve(ROOT, `.${decoded}`);
    if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
      sendJson(res, 403, { error: "Acesso negado." });
      return true;
    }
    const relative = path.relative(ROOT, filePath).split(path.sep).join("/").toLowerCase();
    if (relative.startsWith("data/") || relative === "recarga-agenda.json" || relative.startsWith(".env") || relative.startsWith(".git/")) {
      sendJson(res, 404, { error: "Arquivo não encontrado." });
      return true;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    sendCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          activitiesReady: Boolean(agenda),
          activityCount: agenda?.activities.length || 0
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        if (!agenda) {
          sendJson(res, 503, { error: "A agenda privada ainda não foi configurada no servidor." });
          return;
        }
        const body = await readJson(req);
        const email = normalizeEmail(body.email);
        const attempts = loginAttempts.get(email) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
        if (attempts.resetAt <= Date.now()) {
          attempts.count = 0;
          attempts.resetAt = Date.now() + LOGIN_WINDOW_MS;
        }
        if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
          sendJson(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
          return;
        }
        const user = agenda.users.find((item) => item.email === email);
        if (!user || !verifyPassword(body.password, user)) {
          attempts.count += 1;
          loginAttempts.set(email, attempts);
          sendJson(res, 401, { error: "E-mail ou senha incorretos." });
          return;
        }
        loginAttempts.delete(email);
        const session = issueSession(user.id);
        sendJson(res, 200, { session, user: safeUser(user) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/refresh") {
        const body = await readJson(req);
        const refreshToken = String(body.refresh_token || "");
        const claims = verifyToken(refreshToken, "refresh");
        const user = claims && getUserById(claims.userId);
        if (!user) {
          sendJson(res, 401, { error: "Sessão expirada. Entre novamente." });
          return;
        }
        sendJson(res, 200, { session: issueSession(user.id), user: safeUser(user) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/logout") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/auth/session") {
        const auth = authenticate(req);
        if (!auth) {
          sendJson(res, 401, { error: "Sessão inválida ou expirada." });
          return;
        }
        sendJson(res, 200, { user: safeUser(auth.user) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/activities") {
        const auth = authenticate(req);
        if (!auth) {
          sendJson(res, 401, { error: "Entre novamente para consultar suas atividades." });
          return;
        }
        const activities = agenda.activities.filter((activity) => String(activity.owner) === String(auth.user.id));
        sendJson(res, 200, { user: safeUser(auth.user), activities });
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, pathname)) return;
      sendJson(res, 404, { error: "Rota não encontrada." });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : "Falha interna do servidor." });
      else res.destroy();
    }
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    const address = server.address();
    console.log(`RECARGA CLUB ativo em http://127.0.0.1:${address.port}`);
    console.log(`Agenda privada: ${agendaStatus(process.env.ACTIVITY_DATA_FILE || path.join(ROOT, "data", "agenda.json"))}`);
  });
}

function agendaStatus(dataFile) {
  try {
    readAgenda(path.resolve(dataFile));
    return "configurada";
  } catch {
    return "não configurada (dados privados ausentes ou inválidos)";
  }
}

module.exports = { createAppServer, readAgenda };
