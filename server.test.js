"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAppServer } = require("./server");

test("login atende apenas as atividades do perfil e mantém dados privados fora dos arquivos", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recarga-app-test-"));
  const dataFile = path.join(tempDir, "agenda.json");
  const passwordHash = crypto.createHash("sha256").update("senha-teste").digest("hex");
  const passwordSalt = crypto.randomBytes(18).toString("base64url");
  const passwordIterations = 210000;
  const derivedPasswordHash = crypto.pbkdf2Sync("senha-forte-teste", Buffer.from(passwordSalt, "base64url"), passwordIterations, 32, "sha256").toString("hex");
  fs.writeFileSync(dataFile, JSON.stringify({
    sessionSecret: "test-session-secret-is-at-least-32-characters",
    users: [
      { id: "aua", name: "Aua", email: "aua@example.test", passwordHash, showUserArea: true },
      { id: "jessica", name: "Jessica", email: "jessica@example.test", passwordHash, showUserArea: true },
      { id: "arthur", name: "Arthur", email: "arthur@example.test", passwordHash: derivedPasswordHash, passwordSalt, passwordIterations, passwordScheme: "pbkdf2-sha256", showUserArea: true }
    ],
    activities: [
      { id: "a1", owner: "aua", subject: "Tarefa privada A", date: "2026-10-01T12:00:00.000Z" },
      { id: "j1", owner: "jessica", subject: "Tarefa privada B", date: "2026-10-02T12:00:00.000Z" }
    ]
  }));
  const server = createAppServer({ dataFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const restartedServer = createAppServer({ dataFile });
  await new Promise((resolve) => restartedServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => restartedServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: " AUA@example.test ", password: "senha-teste" })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.equal(login.user.id, "aua");
  assert.equal("passwordHash" in login.user, false);
  assert.ok(login.session.access_token);

  const derivedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "arthur@example.test", password: "senha-forte-teste" })
  });
  assert.equal(derivedLoginResponse.status, 200);
  assert.equal((await derivedLoginResponse.json()).user.id, "arthur");

  const restoredSession = await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/auth/session`, {
    headers: { Authorization: `Bearer ${login.session.access_token}` }
  });
  assert.equal(restoredSession.status, 200);

  const activitiesResponse = await fetch(`${baseUrl}/api/activities`, {
    headers: { Authorization: `Bearer ${login.session.access_token}` }
  });
  const activityPayload = await activitiesResponse.json();
  assert.equal(activitiesResponse.status, 200);
  assert.deepEqual(activityPayload.activities.map((activity) => activity.id), ["a1"]);
  assert.equal("completions" in activityPayload, false);

  const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: login.session.refresh_token })
  });
  assert.equal(refreshResponse.status, 200);

  const removedVideoRoute = await fetch(`${baseUrl}/api/videos`);
  assert.equal(removedVideoRoute.status, 404);
  const privateAgendaResponse = await fetch(`${baseUrl}/data/agenda.json`);
  assert.equal(privateAgendaResponse.status, 404);
  assert.match(fs.readFileSync(path.join(__dirname, ".gitignore"), "utf8"), /^data$/m);
  assert.match(fs.readFileSync(path.join(__dirname, ".dockerignore"), "utf8"), /^data$/m);
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "aua@example.test", password: "wrong" })
  });
  assert.equal(badLogin.status, 401);
});
