const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("todos os scripts inline do HTML continuam sintaticamente válidos", () => {
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]) && match[2].trim())
    .map((match) => match[2]);
  assert.ok(inlineScripts.length > 0);
  inlineScripts.forEach((source) => new vm.Script(source));
});

test("HTML não contém hashes de senha nem carrega agenda como arquivo público", () => {
  assert.doesNotMatch(html, /passwordHash|activities-data\.js|RECARGA_CLUB_ACTIVITIES/);
});

test("interface não inclui compactação de vídeos nem dependência do Supabase", () => {
  assert.doesNotMatch(html, /Supabase|supabase|FFmpeg|compress-video|videoCompressor|compactador de vídeo/i);
  assert.match(html, /recarga_app_server_url/);
  assert.match(html, /getAppServerUrl\("\/api\/auth\/login"\)/);
});
