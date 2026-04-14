const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());

const upload = multer({ dest: UPLOAD_DIR });

// Configuration via env
const MCP_URL = process.env.MCP_URL || 'http://localhost:8000/analyze';
const BACKEND_LLAMA_CMD = process.env.BACKEND_LLAMA_CMD || '/opt/llama/bin/llama';
const BACKEND_MODEL_PATH = process.env.BACKEND_MODEL_PATH || path.resolve(process.cwd(), 'models', 'model.gguf');

async function runLlama(prompt, temperature = 0.7) {
  return new Promise((resolve, reject) => {
    const args = ['-m', BACKEND_MODEL_PATH, '--temp', String(temperature), '--prompt', prompt, '--n', '128'];
    const proc = spawn(BACKEND_LLAMA_CMD, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`llama exited ${code}: ${err}`));
    });
  });
}

// Helper: call MCP service which returns an array of candidate timestamps [{start, end, score}, ...]
async function callMCP(videoPathOrUrl, prompt, options = {}) {
  try {
    const resp = await axios.post(MCP_URL, { video: videoPathOrUrl, prompt, options }, { timeout: 120000 });
    return resp.data;
  } catch (e) {
    console.error('MCP call failed', e.message);
    throw e;
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
      const ff = spawn('ffmpeg', args);
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

    // 1) Ask MCP for candidate timestamps
    const options = { numClips, minDuration, maxDuration };
    const mcpResult = await callMCP(video, prompt, options);

    // Expect MCP to return list of {start, end,score}
    const candidates = Array.isArray(mcpResult) ? mcpResult : (mcpResult.candidates || []);

    // Optionally re-rank with LLM guidance (prompt + timestamps)
    // Build simple ranking prompt
    const rankingPrompt = `Rank these candidate clips for the request: "${prompt}". Candidates: ${JSON.stringify(candidates)}. Return JSON array of indices in preferred order.`;
    let ranking = null;
    try {
      const llmOut = await runLlama(rankingPrompt, temperature);
      // naive parse: try to find JSON in output
      const m = llmOut.match(/\[.*\]/s);
      if (m) ranking = JSON.parse(m[0]);
    } catch (e) {
      console.warn('LLM ranking failed', e.message);
    }

    // Choose top N
    let chosen = candidates.slice(0, numClips);
    if (Array.isArray(ranking) && ranking.length) {
      chosen = ranking.map(i => candidates[i]).filter(Boolean).slice(0, numClips);
    }

    // If video is a local path pointing to uploads, extract clips
    let clipFiles = [];
    if (video && video.startsWith(path.resolve(UPLOAD_DIR))) {
      const outDir = path.join(UPLOAD_DIR, 'clips_' + uuidv4());
      clipFiles = await extractClips(video, chosen, outDir);
    }

    res.json({ chosen, clipFiles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening ${PORT}`));
