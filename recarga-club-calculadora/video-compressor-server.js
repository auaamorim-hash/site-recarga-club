const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT || process.env.VIDEO_COMPRESSOR_PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const STATIC_ROOT = __dirname;
const VIDEO_LIBRARY_ROOT = path.resolve(process.env.VIDEO_LIBRARY_DIR || path.join(__dirname, "data", "videos"));
const VIDEO_LIBRARY_INDEX = path.join(VIDEO_LIBRARY_ROOT, "video-library.json");
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
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
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  sendCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function getPathname(req) {
  return new URL(req.url || "/", "http://localhost").pathname;
}

function sendStaticFile(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(safePath);
  } catch (error) {
    sendJson(res, 400, { error: "Caminho invalido." });
    return true;
  }

  const resolved = path.resolve(STATIC_ROOT, `.${decodedPath}`);
  const isInsideStaticRoot = resolved === STATIC_ROOT || resolved.startsWith(STATIC_ROOT + path.sep);
  if (!isInsideStaticRoot) {
    sendJson(res, 403, { error: "Acesso negado." });
    return true;
  }
  if (resolved === VIDEO_LIBRARY_ROOT || resolved.startsWith(VIDEO_LIBRARY_ROOT + path.sep)) {
    sendJson(res, 403, { error: "Use a biblioteca de videos pelo sistema." });
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return false;
  }

  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).pipe(res);
  return true;
}

function safeExtension(fileName = "") {
  const ext = path.extname(fileName).replace(/[^a-z0-9.]/gi, "").toLowerCase();
  return ext && ext.length <= 6 ? ext : ".mp4";
}

function ensureVideoLibrary() {
  fs.mkdirSync(VIDEO_LIBRARY_ROOT, { recursive: true });
  if (!fs.existsSync(VIDEO_LIBRARY_INDEX)) {
    fs.writeFileSync(VIDEO_LIBRARY_INDEX, "[]", "utf8");
  }
}

function readVideoLibrary() {
  ensureVideoLibrary();
  try {
    const parsed = JSON.parse(fs.readFileSync(VIDEO_LIBRARY_INDEX, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeVideoLibrary(records) {
  ensureVideoLibrary();
  const tempPath = `${VIDEO_LIBRARY_INDEX}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(tempPath, VIDEO_LIBRARY_INDEX);
}

function sanitizeText(value = "", fallback = "Video", maxLength = 90) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function sanitizeFolder(value = "") {
  return sanitizeText(value, "Outros", 40).replace(/[\\/:*?"<>|]/g, "-") || "Outros";
}

function slugify(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "video";
}

function publicVideoRecord(record) {
  return {
    id: record.id,
    name: record.name,
    brand: record.brand,
    folder: record.folder,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.size,
    originalSize: record.originalSize,
    createdAt: record.createdAt,
    downloadUrl: `/shared-videos/${encodeURIComponent(record.id)}`,
    shared: true
  };
}

function listPublicVideos() {
  return readVideoLibrary()
    .filter((record) => record && record.id && record.storagePath && fs.existsSync(record.storagePath))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(publicVideoRecord);
}

function commandWorks(command) {
  try {
    const result = spawnSync(command, ["-version"], { windowsHide: true, stdio: "ignore" });
    return result.status === 0;
  } catch (error) {
    return false;
  }
}

function findFfmpeg() {
  const localCandidates = [
    process.env.FFMPEG_PATH,
    path.join(__dirname, "ffmpeg.exe"),
    path.join(__dirname, "tools", "ffmpeg.exe"),
    "ffmpeg"
  ].filter(Boolean);
  return localCandidates.find((candidate) => {
    if (/[/\\]/.test(candidate) && fs.existsSync(candidate)) return true;
    return commandWorks(candidate);
  }) || null;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("Video grande demais para o compactador local."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType = "") {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Envio invalido: boundary ausente.");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const result = { fields: {}, file: null };
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start < 0) break;
    let partStart = start + boundary.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;
    if (buffer.slice(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

    const next = buffer.indexOf(boundary, partStart);
    if (next < 0) break;
    let part = buffer.slice(partStart, next);
    if (part.slice(part.length - 2).toString() === "\r\n") part = part.slice(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > -1) {
      const headerText = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + 4);
      const name = headerText.match(/name="([^"]+)"/i)?.[1];
      const fileName = headerText.match(/filename="([^"]*)"/i)?.[1];
      if (name && fileName !== undefined) {
        result.file = { field: name, fileName, buffer: body };
      } else if (name) {
        result.fields[name] = body.toString("utf8").trim();
      }
    }
    cursor = next;
  }

  if (!result.file) throw new Error("Nenhum video foi recebido.");
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `FFmpeg saiu com codigo ${code}.`));
    });
  });
}

async function getDuration(ffmpeg, inputPath) {
  try {
    await run(ffmpeg, ["-i", inputPath]);
  } catch (error) {
    const text = String(error.message || "");
    const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (!match) throw new Error("Nao foi possivel ler a duracao do video.");
    return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
  }
  throw new Error("Nao foi possivel ler a duracao do video.");
}

async function compressVideo({ ffmpeg, inputPath, outputPath, targetBytes }) {
  const duration = Math.max(1, await getDuration(ffmpeg, inputPath));
  const totalBitrate = Math.max(220000, Math.floor((targetBytes * 8) / duration));
  const audioBitrate = Math.min(128000, Math.max(48000, Math.floor(totalBitrate * 0.16)));
  const videoBitrate = Math.max(140000, totalBitrate - audioBitrate);

  await run(ffmpeg, [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", `${Math.floor(videoBitrate / 1000)}k`,
    "-maxrate", `${Math.floor(videoBitrate / 1000)}k`,
    "-bufsize", `${Math.floor((videoBitrate * 2) / 1000)}k`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${Math.floor(audioBitrate / 1000)}k`,
    "-movflags", "+faststart",
    outputPath
  ]);
}

async function handleCompress(req, res) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    sendJson(res, 500, {
      error: "FFmpeg nao encontrado. No deploy publico, use o Dockerfile deste projeto ou configure FFmpeg no servidor. No uso local, coloque o ffmpeg.exe na pasta do site ou em tools."
    });
    return;
  }

  const body = await readRequestBody(req);
  const multipart = parseMultipart(body, req.headers["content-type"] || "");
  const targetBytes = Math.max(1024 * 1024, Number(multipart.fields.targetBytes) || 16 * 1024 * 1024);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recarga-video-"));
  const inputPath = path.join(tempDir, `input${safeExtension(multipart.file.fileName)}`);
  const outputPath = path.join(tempDir, "output.mp4");

  try {
    fs.writeFileSync(inputPath, multipart.file.buffer);
    await compressVideo({ ffmpeg, inputPath, outputPath, targetBytes });
    const output = fs.readFileSync(outputPath);
    sendCors(res);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": output.length,
      "Content-Disposition": "attachment; filename=video-16mb.mp4"
    });
    res.end(output);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) {}
  }
}

async function handleSaveSharedVideo(req, res) {
  const body = await readRequestBody(req);
  const multipart = parseMultipart(body, req.headers["content-type"] || "");
  const id = crypto.randomUUID ? crypto.randomUUID() : `video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = sanitizeText(multipart.fields.name, "Video");
  const brand = sanitizeText(multipart.fields.brand, "Outros", 60);
  const folder = sanitizeFolder(multipart.fields.folder || brand);
  const originalSize = Math.max(0, Number(multipart.fields.originalSize) || multipart.file.buffer.length);
  const mimeType = "video/mp4";
  const fileName = `${slugify(folder)}-${slugify(name)}-16mb-${id.slice(0, 8)}.mp4`;
  const folderPath = path.join(VIDEO_LIBRARY_ROOT, slugify(folder));
  const storagePath = path.join(folderPath, fileName);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(storagePath, multipart.file.buffer);

  const records = readVideoLibrary();
  const record = {
    id,
    name,
    brand,
    folder,
    fileName,
    mimeType,
    size: multipart.file.buffer.length,
    originalSize,
    createdAt: new Date().toISOString(),
    storagePath
  };
  records.push(record);
  writeVideoLibrary(records);
  sendJson(res, 201, { video: publicVideoRecord(record) });
}

function handleListSharedVideos(req, res) {
  sendJson(res, 200, { videos: listPublicVideos() });
}

function handleDownloadSharedVideo(req, res, id) {
  const record = readVideoLibrary().find((item) => item.id === id);
  if (!record || !record.storagePath || !fs.existsSync(record.storagePath)) {
    sendJson(res, 404, { error: "Video nao encontrado." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": record.mimeType || "video/mp4",
    "Content-Length": fs.statSync(record.storagePath).size,
    "Content-Disposition": `attachment; filename="${String(record.fileName || "video-16mb.mp4").replace(/"/g, "")}"`,
    "Cache-Control": "public, max-age=31536000, immutable"
  });
  fs.createReadStream(record.storagePath).pipe(res);
}

function handleDeleteSharedVideo(req, res, id) {
  const records = readVideoLibrary();
  const record = records.find((item) => item.id === id);
  if (!record) {
    sendJson(res, 404, { error: "Video nao encontrado." });
    return;
  }
  try {
    if (record.storagePath && fs.existsSync(record.storagePath)) {
      fs.unlinkSync(record.storagePath);
    }
  } catch (error) {}
  writeVideoLibrary(records.filter((item) => item.id !== id));
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = getPathname(req);
    if (req.method === "OPTIONS") {
      sendCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, ffmpeg: Boolean(findFfmpeg()) });
      return;
    }
    if (req.method === "GET" && pathname === "/api/videos") {
      handleListSharedVideos(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/api/videos") {
      await handleSaveSharedVideo(req, res);
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/shared-videos/")) {
      handleDownloadSharedVideo(req, res, decodeURIComponent(pathname.replace("/shared-videos/", "")));
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/videos/")) {
      handleDeleteSharedVideo(req, res, decodeURIComponent(pathname.replace("/api/videos/", "")));
      return;
    }
    if (req.method === "POST" && pathname === "/api/compress-video") {
      await handleCompress(req, res);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && sendStaticFile(req, res, pathname)) {
      return;
    }
    sendJson(res, 404, { error: "Rota nao encontrada." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Falha no servidor de compactacao." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RECARGA CLUB ativo em http://127.0.0.1:${PORT}`);
  console.log(`API de compactacao pronta em http://127.0.0.1:${PORT}/api/compress-video`);
  console.log("Mantenha esta janela aberta no uso local. Em producao, publique este servidor com FFmpeg.");
});
