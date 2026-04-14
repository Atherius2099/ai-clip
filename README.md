Local AI Clip Creator

This project is a local AI-powered video clip creator with:
- a `llama.cpp` backend entry point for GGUF inference
- MCP integration for video timestamp analysis
- a React web UI for uploads, URLs, prompts, and tuning sliders

Current scaffold includes:
- `backend/server.js` for uploads, MCP calls, and clip extraction via `ffmpeg`
- `frontend/` for the web UI
- `scripts/bootstrap.js` to install backend and frontend dependencies

Important platform note
- ROCm acceleration for AMD Strix Halo is typically a Linux setup. This repo can be developed on Windows, but ROCm-backed `llama.cpp` execution is expected on Linux.

Quick start

```powershell
npm run bootstrap
npm run start:backend
npm run start:frontend
```

Environment variables
- `MCP_URL` for the video clip MCP endpoint
- `BACKEND_LLAMA_CMD` for the local `llama.cpp` executable path
- `BACKEND_MODEL_PATH` for the GGUF model path

Model target
- https://huggingface.co/Ex0bit/MYTHOS-26B-A4B-PRISM-PRO-DQ-GGUF

MCP target
- https://github.com/pickstar-2002/video-clip-mcp