const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT || process.env.VIDEO_COMPRESSOR_PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const STATIC_ROOT = __dirname;
const VIDEO_LIBRARY_ROOT = path.resolve(process.env.VIDEO_LIBRARY_DIR || path.join(__dirname, "data", "videos"));
const VIDEO_LIBRARY_INDEX = path.join(VIDEO_LIBRARY_ROOT, "video-library.json");
const VIDEO_JOB_ROOT = path.resolve(process.env.VIDEO_JOB_DIR || path.join(os.tmpdir(), "recarga-video-jobs"));
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const VIDEO_MAX_WIDTH = Math.max(480, Math.min(1920, Number(process.env.VIDEO_MAX_WIDTH) || 1280));
const VIDEO_RETRY_TARGET_RATIO = Math.max(0.5, Math.min(0.95, Number(process.env.VIDEO_RETRY_TARGET_RATIO) || 0.74));
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "videos";
const SUPABASE_INDEX_PATH = process.env.SUPABASE_INDEX_PATH || "_recarga/video-library.json";
const SUPABASE_RECORDS_PREFIX = process.env.SUPABASE_RECORDS_PREFIX || "_recarga/records";
const videoJobs = new Map();
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

function isSupabaseVideoStorageEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY && SUPABASE_BUCKET);
}

function encodeStoragePath(objectPath = "") {
  return String(objectPath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function supabaseObjectUrl(objectPath = "") {
  return `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeStoragePath(objectPath)}`;
}

function supabaseBucketUrl() {
  return `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}`;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra
  };
}

async function getSupabaseError(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {}
  return text || `Supabase respondeu com status ${response.status}.`;
}

async function readSupabaseObjectBuffer(objectPath) {
  const response = await fetch(supabaseObjectUrl(objectPath), {
    method: "GET",
    headers: supabaseHeaders()
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await getSupabaseError(response));
  return Buffer.from(await response.arrayBuffer());
}

async function uploadSupabaseObject({ objectPath, buffer, contentType }) {
  const response = await fetch(supabaseObjectUrl(objectPath), {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "31536000",
      "x-upsert": "true"
    }),
    body: buffer
  });
  if (!response.ok) {
    throw new Error(await getSupabaseError(response));
  }
}

async function deleteSupabaseObjects(objectPaths = []) {
  const prefixes = objectPaths.filter(Boolean);
  if (!prefixes.length) return;
  const response = await fetch(supabaseBucketUrl(), {
    method: "DELETE",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes })
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await getSupabaseError(response));
  }
}

async function listSupabaseObjects(prefix = "") {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(SUPABASE_BUCKET)}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" }
    })
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(await getSupabaseError(response));
  const parsed = await response.json();
  return Array.isArray(parsed) ? parsed : [];
}

function getSupabaseRecordPath(id) {
  return `${SUPABASE_RECORDS_PREFIX}/${encodeURIComponent(String(id || "video")).replace(/%/g, "-")}.json`;
}

function resolveSupabaseListedPath(prefix, name = "") {
  const cleanName = String(name || "").replace(/^\/+/, "");
  if (!cleanName) return "";
  return cleanName.includes("/") ? cleanName : `${prefix.replace(/\/+$/, "")}/${cleanName}`;
}

function ensureLocalVideoLibrary() {
  fs.mkdirSync(VIDEO_LIBRARY_ROOT, { recursive: true });
  if (!fs.existsSync(VIDEO_LIBRARY_INDEX)) {
    fs.writeFileSync(VIDEO_LIBRARY_INDEX, "[]", "utf8");
  }
}

function readLocalVideoLibrary() {
  ensureLocalVideoLibrary();
  try {
    const parsed = JSON.parse(fs.readFileSync(VIDEO_LIBRARY_INDEX, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeLocalVideoLibrary(records) {
  ensureLocalVideoLibrary();
  const tempPath = `${VIDEO_LIBRARY_INDEX}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(tempPath, VIDEO_LIBRARY_INDEX);
}

async function readVideoLibrary() {
  if (!isSupabaseVideoStorageEnabled()) return readLocalVideoLibrary();
  const items = await listSupabaseObjects(SUPABASE_RECORDS_PREFIX);
  const records = [];
  for (const item of items) {
    const objectPath = resolveSupabaseListedPath(SUPABASE_RECORDS_PREFIX, item?.name);
    if (!objectPath || !/\.json$/i.test(objectPath)) continue;
    try {
      const buffer = await readSupabaseObjectBuffer(objectPath);
      if (!buffer) continue;
      const record = JSON.parse(buffer.toString("utf8"));
      if (record && record.id && record.storagePath) records.push(record);
    } catch (error) {}
  }
  if (records.length) return records;
  const legacyBuffer = await readSupabaseObjectBuffer(SUPABASE_INDEX_PATH);
  if (!legacyBuffer) return [];
  try {
    const parsed = JSON.parse(legacyBuffer.toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeVideoLibrary(records) {
  if (!isSupabaseVideoStorageEnabled()) {
    writeLocalVideoLibrary(records);
    return;
  }
  await Promise.all((records || []).map((record) => uploadSupabaseObject({
    objectPath: getSupabaseRecordPath(record.id),
    buffer: Buffer.from(JSON.stringify(record, null, 2), "utf8"),
    contentType: "application/json; charset=utf-8"
  })));
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

async function listPublicVideos() {
  const records = await readVideoLibrary();
  return records
    .filter((record) => {
      if (!record || !record.id || !record.storagePath) return false;
      return isSupabaseVideoStorageEnabled() || fs.existsSync(record.storagePath);
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(publicVideoRecord);
}

async function saveSharedVideoBuffer({ buffer, name, brand, folder, originalSize }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeName = sanitizeText(name, "Video");
  const safeBrand = sanitizeText(brand, "Outros", 60);
  const safeFolder = sanitizeFolder(folder || safeBrand);
  const fileName = `${slugify(safeFolder)}-${slugify(safeName)}-16mb-${id.slice(0, 8)}.mp4`;
  const storagePath = isSupabaseVideoStorageEnabled()
    ? `${slugify(safeFolder)}/${fileName}`
    : path.join(VIDEO_LIBRARY_ROOT, slugify(safeFolder), fileName);
  if (isSupabaseVideoStorageEnabled()) {
    await uploadSupabaseObject({
      objectPath: storagePath,
      buffer,
      contentType: "video/mp4"
    });
  } else {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, buffer);
  }

  const record = {
    id,
    name: safeName,
    brand: safeBrand,
    folder: safeFolder,
    fileName,
    mimeType: "video/mp4",
    size: buffer.length,
    originalSize: Math.max(0, Number(originalSize) || buffer.length),
    createdAt: new Date().toISOString(),
    storagePath
  };
  if (isSupabaseVideoStorageEnabled()) {
    await uploadSupabaseObject({
      objectPath: getSupabaseRecordPath(id),
      buffer: Buffer.from(JSON.stringify(record, null, 2), "utf8"),
      contentType: "application/json; charset=utf-8"
    });
  } else {
    const records = await readVideoLibrary();
    records.push(record);
    await writeVideoLibrary(records);
  }
  return record;
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

function parseFfmpegProgressSeconds(line = "") {
  const outTimeMs = line.match(/out_time_ms=(\d+)/i);
  if (outTimeMs) return Number(outTimeMs[1]) / 1000000;
  const outTime = line.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (outTime) {
    return (Number(outTime[1]) * 3600) + (Number(outTime[2]) * 60) + Number(outTime[3]);
  }
  const time = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (time) {
    return (Number(time[1]) * 3600) + (Number(time[2]) * 60) + Number(time[3]);
  }
  return null;
}

function runFfmpeg(command, args, { duration = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!duration || !onProgress) return;
      text.split(/\r?\n/).forEach((line) => {
        const seconds = parseFfmpegProgressSeconds(line);
        if (seconds !== null) {
          onProgress(Math.max(0, Math.min(0.98, seconds / duration)));
        }
      });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        if (onProgress) onProgress(1);
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `FFmpeg saiu com codigo ${code}.`));
      }
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

function getVideoScaleFilter(duration) {
  const durationWidth = duration > 240 ? 854 : duration > 120 ? 960 : VIDEO_MAX_WIDTH;
  const width = Math.min(VIDEO_MAX_WIDTH, durationWidth);
  return `scale=w='if(gt(iw,${width}),${width},trunc(iw/2)*2)':h=-2:flags=fast_bilinear`;
}

async function compressVideo({ ffmpeg, inputPath, outputPath, targetBytes, duration, onProgress }) {
  const videoDuration = Math.max(1, Number(duration) || await getDuration(ffmpeg, inputPath));
  const totalBitrate = Math.max(76000, Math.floor((targetBytes * 8) / videoDuration));
  const audioBitrate = Math.min(96000, Math.max(24000, Math.floor(totalBitrate * 0.15)));
  const videoBitrate = Math.max(52000, totalBitrate - audioBitrate);

  await runFfmpeg(ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", getVideoScaleFilter(videoDuration),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "fastdecode",
    "-threads", "2",
    "-b:v", `${Math.floor(videoBitrate / 1000)}k`,
    "-maxrate", `${Math.floor(videoBitrate / 1000)}k`,
    "-bufsize", `${Math.floor((videoBitrate * 2) / 1000)}k`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${Math.floor(audioBitrate / 1000)}k`,
    "-movflags", "+faststart",
    "-nostats",
    "-progress", "pipe:2",
    outputPath
  ], { duration: videoDuration, onProgress });
}

async function compressVideoToTarget({ ffmpeg, inputPath, outputPath, targetBytes, maxBytes = targetBytes, onProgress }) {
  const duration = Math.max(1, await getDuration(ffmpeg, inputPath));
  const attempts = [1, VIDEO_RETRY_TARGET_RATIO];
  let bestPath = "";
  let bestSize = Infinity;
  for (let index = 0; index < attempts.length; index += 1) {
    const ratio = attempts[index];
    const attemptPath = `${outputPath.replace(/\.mp4$/i, "")}-${index + 1}.mp4`;
    const startProgress = index === 0 ? 18 : 78;
    const endProgress = index === 0 ? 76 : 90;
    if (onProgress) onProgress(startProgress, `Compactando tentativa ${index + 1}/${attempts.length}...`);
    await compressVideo({
      ffmpeg,
      inputPath,
      outputPath: attemptPath,
      targetBytes: Math.floor(targetBytes * ratio),
      duration,
      onProgress: (ratioProgress) => {
        if (onProgress) {
          const progress = startProgress + ((endProgress - startProgress) * ratioProgress);
          onProgress(progress, `Compactando tentativa ${index + 1}/${attempts.length}...`);
        }
      }
    });
    const size = fs.statSync(attemptPath).size;
    if (onProgress) onProgress(endProgress, `Tentativa ${index + 1} gerou ${(size / 1024 / 1024).toFixed(1)}MB. Validando...`);
    if (size < bestSize) {
      bestPath = attemptPath;
      bestSize = size;
    }
    if (size <= maxBytes) {
      fs.copyFileSync(attemptPath, outputPath);
      return outputPath;
    }
  }
  if (bestPath && bestSize <= maxBytes) {
    fs.copyFileSync(bestPath, outputPath);
    return outputPath;
  }
  throw new Error("O video ainda ficou acima de 16MB. Tente um video menor ou com menor duracao.");
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
    await compressVideoToTarget({ ffmpeg, inputPath, outputPath, targetBytes, maxBytes: targetBytes });
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
  const record = await saveSharedVideoBuffer({
    buffer: multipart.file.buffer,
    name: multipart.fields.name,
    brand: multipart.fields.brand,
    folder: multipart.fields.folder,
    originalSize: multipart.fields.originalSize
  });
  sendJson(res, 201, { video: publicVideoRecord(record) });
}

function publicVideoJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    video: job.video || null
  };
}

async function processVideoJob(job) {
  let heartbeat = null;
  try {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      throw new Error("FFmpeg nao encontrado no servidor.");
    }
    job.status = "processing";
    job.progress = 12;
    job.message = "Video recebido. Preparando compactacao...";
    let lastProgressAt = Date.now();
    heartbeat = setInterval(() => {
      if (job.status !== "processing") return;
      if (Date.now() - lastProgressAt < 10000) return;
      if (job.progress >= 88) return;
      job.progress = Math.min(88, job.progress + 1);
      job.message = "Compactando em modo rapido no servidor...";
    }, 6000);
    heartbeat.unref?.();
    const outputPath = path.join(job.tempDir, "output.mp4");
    await compressVideoToTarget({
      ffmpeg,
      inputPath: job.inputPath,
      outputPath,
      targetBytes: job.targetBytes,
      maxBytes: job.maxBytes,
      onProgress: (progress, message) => {
        lastProgressAt = Date.now();
        job.progress = Math.min(92, progress);
        job.message = message;
      }
    });
    const output = fs.readFileSync(outputPath);
    if (output.length > job.maxBytes) {
      throw new Error("O video ainda ficou acima de 16MB. Tente um video menor ou com menor resolucao.");
    }
    job.progress = 94;
    job.message = "Salvando na biblioteca compartilhada...";
    const record = await saveSharedVideoBuffer({
      buffer: output,
      name: job.name,
      brand: job.brand,
      folder: job.folder,
      originalSize: job.originalSize
    });
    job.video = publicVideoRecord(record);
    job.status = "done";
    job.progress = 100;
    job.message = "Video compactado e compartilhado.";
  } catch (error) {
    job.status = "error";
    job.progress = 100;
    job.error = error.message || "Falha ao compactar video.";
    job.message = job.error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { fs.rmSync(job.tempDir, { recursive: true, force: true }); } catch (error) {}
    setTimeout(() => videoJobs.delete(job.id), 60 * 60 * 1000).unref?.();
  }
}

async function handleStartVideoJob(req, res) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    sendJson(res, 500, { error: "FFmpeg nao encontrado no servidor." });
    return;
  }
  fs.mkdirSync(VIDEO_JOB_ROOT, { recursive: true });
  const body = await readRequestBody(req);
  const multipart = parseMultipart(body, req.headers["content-type"] || "");
  const id = crypto.randomUUID ? crypto.randomUUID() : `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDir = fs.mkdtempSync(path.join(VIDEO_JOB_ROOT, `${id}-`));
  const inputPath = path.join(tempDir, `input${safeExtension(multipart.file.fileName)}`);
  fs.writeFileSync(inputPath, multipart.file.buffer);
  const maxBytes = 16 * 1024 * 1024;
  const job = {
    id,
    status: "queued",
    progress: 5,
    message: "Upload recebido. Entrando na fila de compactacao...",
    inputPath,
    tempDir,
    name: multipart.fields.name,
    brand: multipart.fields.brand,
    folder: multipart.fields.folder,
    originalSize: Math.max(0, Number(multipart.fields.originalSize) || multipart.file.buffer.length),
    maxBytes,
    targetBytes: Math.max(1024 * 1024, Number(multipart.fields.targetBytes) || Math.floor(maxBytes * 0.94)),
    createdAt: new Date().toISOString()
  };
  videoJobs.set(id, job);
  sendJson(res, 202, { job: publicVideoJob(job) });
  setImmediate(() => processVideoJob(job));
}

function handleGetVideoJob(req, res, id) {
  const job = videoJobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: "Compactacao nao encontrada ou expirada." });
    return;
  }
  sendJson(res, 200, { job: publicVideoJob(job) });
}

async function handleListSharedVideos(req, res) {
  sendJson(res, 200, {
    videos: await listPublicVideos(),
    storage: isSupabaseVideoStorageEnabled() ? "supabase" : "local"
  });
}

async function handleDownloadSharedVideo(req, res, id) {
  const record = (await readVideoLibrary()).find((item) => item.id === id);
  if (!record || !record.storagePath) {
    sendJson(res, 404, { error: "Video nao encontrado." });
    return;
  }
  if (isSupabaseVideoStorageEnabled()) {
    const buffer = await readSupabaseObjectBuffer(record.storagePath);
    if (!buffer) {
      sendJson(res, 404, { error: "Video nao encontrado no Supabase." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": record.mimeType || "video/mp4",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="${String(record.fileName || "video-16mb.mp4").replace(/"/g, "")}"`,
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    res.end(buffer);
    return;
  }
  if (!fs.existsSync(record.storagePath)) {
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

async function handleDeleteSharedVideo(req, res, id) {
  const records = await readVideoLibrary();
  const record = records.find((item) => item.id === id);
  if (!record) {
    sendJson(res, 404, { error: "Video nao encontrado." });
    return;
  }
  if (isSupabaseVideoStorageEnabled()) {
    await deleteSupabaseObjects([record.storagePath, getSupabaseRecordPath(record.id)]);
  } else {
    try {
      if (record.storagePath && fs.existsSync(record.storagePath)) {
        fs.unlinkSync(record.storagePath);
      }
    } catch (error) {}
    await writeVideoLibrary(records.filter((item) => item.id !== id));
  }
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
      sendJson(res, 200, {
        ok: true,
        ffmpeg: Boolean(findFfmpeg()),
        videoStorage: isSupabaseVideoStorageEnabled() ? "supabase" : "local",
        supabaseBucket: isSupabaseVideoStorageEnabled() ? SUPABASE_BUCKET : null
      });
      return;
    }
    if (req.method === "GET" && pathname === "/api/videos") {
      await handleListSharedVideos(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/api/videos") {
      await handleSaveSharedVideo(req, res);
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/shared-videos/")) {
      await handleDownloadSharedVideo(req, res, decodeURIComponent(pathname.replace("/shared-videos/", "")));
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/videos/")) {
      await handleDeleteSharedVideo(req, res, decodeURIComponent(pathname.replace("/api/videos/", "")));
      return;
    }
    if (req.method === "POST" && pathname === "/api/compress-video") {
      await handleCompress(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/api/compress-video-job") {
      await handleStartVideoJob(req, res);
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/api/compress-video-job/")) {
      handleGetVideoJob(req, res, decodeURIComponent(pathname.replace("/api/compress-video-job/", "")));
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
