const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());

const upload = multer({ dest: UPLOAD_DIR });

// Configuration via env
const MCP_URL = process.env.MCP_URL || 'http://localhost:8000/analyze';
const BACKEND_LLAMA_CMD = process.env.BACKEND_LLAMA_CMD || (process.platform === 'win32' ? 'llama-cli.exe' : '/opt/llama/bin/llama');
const BACKEND_MODEL_PATH = process.env.BACKEND_MODEL_PATH || path.resolve(process.cwd(), 'models', 'model.gguf');
const FFMPEG_CMD = process.env.FFMPEG_CMD || 'ffmpeg';
const FFPROBE_CMD = process.env.FFPROBE_CMD || 'ffprobe';
const MCP_EMBEDDED_ENABLED = process.env.MCP_EMBEDDED_ENABLED !== 'false';
let hasLoggedMcpUnavailable = false;
let embeddedVideoEnginePromise = null;

function ensureBinaryOnPath(binaryPath) {
  if (!binaryPath || /^(ffmpeg|ffprobe)$/i.test(binaryPath)) return;
  const dir = path.dirname(binaryPath);
  if (!dir) return;
  const currentPath = process.env.PATH || process.env.Path || '';
  if (!currentPath.toLowerCase().includes(dir.toLowerCase())) {
    process.env.PATH = `${dir}${path.delimiter}${currentPath}`;
  }
}

async function getEmbeddedVideoEngine() {
  if (!MCP_EMBEDDED_ENABLED) return null;
  if (!embeddedVideoEnginePromise) {
    ensureBinaryOnPath(FFMPEG_CMD);
    ensureBinaryOnPath(FFPROBE_CMD);
    embeddedVideoEnginePromise = import('@pickstar-2002/video-clip-mcp/dist/core/video-engine.js')
      .then((m) => m.VideoEngine.getInstance())
      .catch((e) => {
        console.warn(`Embedded MCP engine load failed: ${e.message}`);
        return null;
      });
  }
  return embeddedVideoEnginePromise;
}

// Auto-detect multimodal projection file if it exists
function findMultimodalProj(modelPath) {
  const modelDir = path.dirname(modelPath);
  const mmproj = path.join(modelDir, 'mmproj-mythos-26b-a4b-prism-pro.gguf');
  if (fs.existsSync(mmproj)) return mmproj;
  
  // Try common mmproj patterns
  const baseName = path.basename(modelPath, path.extname(modelPath));
  const possibleMmproj = path.join(modelDir, `mmproj-${baseName}.gguf`);
  if (fs.existsSync(possibleMmproj)) return possibleMmproj;
  
  return null;
}

const MMPROJ_PATH = findMultimodalProj(BACKEND_MODEL_PATH);

function clampClip(c, maxDurationSec) {
  const start = Math.max(0, Number(c.start || 0));
  const endRaw = Math.max(start + 0.1, Number(c.end || start + 1));
  const end = Number.isFinite(maxDurationSec) ? Math.min(endRaw, maxDurationSec) : endRaw;
  if (end <= start) return null;
  return { start, end, score: Number(c.score || 0) };
}

function getVideoDuration(inputPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ];
    const proc = spawn(FFPROBE_CMD, args);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => {
      // ffprobe missing or not executable: treat as unknown duration.
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const parsed = Number(out.trim());
      resolve(Number.isFinite(parsed) ? parsed : null);
    });
  });
}

function buildFallbackCandidates(numClips, minDuration, maxDuration, videoDurationSec) {
  const count = Math.max(1, Number(numClips || 1));
  const minDur = Math.max(1, Number(minDuration || 1));
  const maxDur = Math.max(minDur, Number(maxDuration || minDur));
  const clipLen = Math.min(maxDur, Math.max(minDur, 12));

  if (Number.isFinite(videoDurationSec) && videoDurationSec > clipLen + 0.5) {
    const usable = Math.max(0, videoDurationSec - clipLen);
    const step = count > 1 ? usable / (count - 1) : 0;
    return Array.from({ length: count }, (_, i) => {
      const start = Math.max(0, step * i);
      const end = Math.min(videoDurationSec, start + clipLen);
      return { start, end, score: 0.1 };
    });
  }

  return Array.from({ length: count }, (_, i) => {
    const start = i * Math.max(2, Math.floor(clipLen / 2));
    return { start, end: start + clipLen, score: 0.1 };
  });
}

async function runLlama(prompt, temperature = 0.7) {
  return new Promise((resolve, reject) => {
    const args = ['-m', BACKEND_MODEL_PATH, '--temp', String(temperature), '-p', prompt, '-n', '128', '--no-display-prompt'];
    if (MMPROJ_PATH) {
      args.push('--mmproj', MMPROJ_PATH);
    }
    const proc = spawn(BACKEND_LLAMA_CMD, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => {
      reject(new Error(`llama spawn failed: ${e.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`llama exited ${code}: ${err}`));
    });
  });
}

// Helper: call MCP service which returns an array of candidate timestamps [{start, end, score}, ...]
async function callMCP(videoPathOrUrl, prompt, options = {}) {
  async function tryEmbedded() {
    // Embedded MCP adapter only works with local files.
    if (!MCP_EMBEDDED_ENABLED || !videoPathOrUrl || /^https?:\/\//i.test(videoPathOrUrl)) {
      return null;
    }
    if (!fs.existsSync(videoPathOrUrl)) {
      return null;
    }
    const engine = await getEmbeddedVideoEngine();
    if (!engine) return null;

    const info = await engine.getVideoInfo(videoPathOrUrl);
    const durationSec = Number(info && info.duration);
    const candidates = buildFallbackCandidates(
      options.numClips,
      options.minDuration,
      options.maxDuration,
      Number.isFinite(durationSec) ? durationSec : null
    );

    return {
      candidates,
      source: 'embedded-video-clip-mcp',
      videoInfo: info
    };
  }

  if (!MCP_URL || MCP_URL === 'embedded') {
    const embedded = await tryEmbedded();
    if (embedded) return embedded;
    throw new Error('embedded MCP unavailable');
  }

  try {
    const resp = await axios.post(MCP_URL, { video: videoPathOrUrl, prompt, options }, { timeout: 120000 });
    return resp.data;
  } catch (e) {
    try {
      const embedded = await tryEmbedded();
      if (embedded) {
        hasLoggedMcpUnavailable = false;
        return embedded;
      }
    } catch (embeddedError) {
      // Ignore embedded adapter errors and continue with normal warning path.
      if (embeddedError && embeddedError.message) {
        console.warn(`Embedded MCP fallback failed: ${embeddedError.message}`);
      }
    }

    const status = e && e.response && e.response.status ? `HTTP ${e.response.status}` : null;
    const code = e && e.code ? e.code : null;
    const message = e && e.message ? e.message : 'unknown error';
    const detail = status || code || message;

    if (!hasLoggedMcpUnavailable) {
      hasLoggedMcpUnavailable = true;
      console.warn(`MCP unavailable at ${MCP_URL}: ${detail}. Using local fallback.`);
    }
    throw new Error(detail);
  }
}

// Extract clips using ffmpeg given array of {start, end}
function extractClips(inputPath, clips, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const promises = clips.map((c, i) => {
    return new Promise((resolve, reject) => {
      const out = path.join(outDir, `clip-${i + 1}.mp4`);
      const duration = c.end - c.start;
      const args = ['-y', '-i', inputPath, '-ss', String(c.start), '-t', String(duration), '-c', 'copy', out];
      const ff = spawn(FFMPEG_CMD, args);
      ff.on('error', (e) => {
        reject(new Error(`ffmpeg spawn failed: ${e.message}`));
      });
      ff.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error('ffmpeg failed ' + code));
      });
    });
  });
  return Promise.all(promises);
}

// Upload endpoint (multipart)
app.post('/api/upload', upload.single('video'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });
  res.json({ path: file.path, originalname: file.originalname });
});

// Process endpoint: accepts {video: localPathOrUrl, prompt, numClips, minDuration, maxDuration, temperature}
app.post('/api/process', async (req, res) => {
  try {
    const { video, prompt, numClips = 3, minDuration = 2, maxDuration = 15, temperature = 0.7 } = req.body;
    if (!video || !prompt) return res.status(400).json({ error: 'video and prompt required' });
    const isLocalUpload = video.startsWith(path.resolve(UPLOAD_DIR));
    const localVideoDuration = isLocalUpload ? await getVideoDuration(video) : null;

    // 1) Ask MCP for candidate timestamps
    const options = { numClips, minDuration, maxDuration };
    let mcpResult = null;
    let mcpUnavailable = false;
    let warning = null;
    let mcpSource = MCP_URL;
    try {
      mcpResult = await callMCP(video, prompt, options);
      if (mcpResult && mcpResult.source) {
        mcpSource = mcpResult.source;
      }
      hasLoggedMcpUnavailable = false;
    } catch (e) {
      mcpUnavailable = true;
      warning = `MCP unavailable at ${MCP_URL} (${e.message}). Falling back to local timestamp generation.`;
    }

    // Expect MCP to return list of {start, end,score}
    let candidates = Array.isArray(mcpResult) ? mcpResult : ((mcpResult && mcpResult.candidates) || []);

    // If MCP is offline or returned no candidates, generate fallback windows.
    if (!candidates.length) {
      candidates = buildFallbackCandidates(numClips, minDuration, maxDuration, localVideoDuration);
      if (!warning) {
        warning = 'MCP returned no candidates. Using fallback timestamp generation.';
      }
    }

    const sanitizedCandidates = candidates
      .map((c) => clampClip(c, localVideoDuration))
      .filter(Boolean);

    // Optionally re-rank with LLM guidance (prompt + timestamps)
    // Build simple ranking prompt
    const rankingPrompt = `Rank these candidate clips for the request: "${prompt}". Candidates: ${JSON.stringify(sanitizedCandidates)}. Return JSON array of indices in preferred order.`;
    let ranking = null;
    if (sanitizedCandidates.length) {
      try {
        const llmOut = await runLlama(rankingPrompt, temperature);
        // naive parse: try to find JSON in output
        const m = llmOut.match(/\[.*\]/s);
        if (m) ranking = JSON.parse(m[0]);
      } catch (e) {
        console.warn('LLM ranking failed', e.message);
      }
    }

    // Choose top N
    let chosen = sanitizedCandidates.slice(0, numClips);
    if (Array.isArray(ranking) && ranking.length) {
      chosen = ranking.map(i => sanitizedCandidates[i]).filter(Boolean).slice(0, numClips);
    }

    // If video is a local path pointing to uploads, extract clips
    let clipFiles = [];
    if (isLocalUpload) {
      const outDir = path.join(UPLOAD_DIR, 'clips_' + uuidv4());
      try {
        clipFiles = await extractClips(video, chosen, outDir);
      } catch (e) {
        warning = warning ? `${warning} Clip extraction failed: ${e.message}` : `Clip extraction failed: ${e.message}`;
      }
    }

    res.json({ chosen, clipFiles, warning, mcpUnavailable, mcpSource });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
  console.log(`  llama cmd : ${BACKEND_LLAMA_CMD}`);
  console.log(`  model     : ${BACKEND_MODEL_PATH}`);
  console.log(`  mmproj    : ${MMPROJ_PATH || '(not found)'}`);
  console.log(`  ffmpeg    : ${FFMPEG_CMD}`);
  console.log(`  ffprobe   : ${FFPROBE_CMD}`);
  console.log(`  MCP URL   : ${MCP_URL}`);
});
