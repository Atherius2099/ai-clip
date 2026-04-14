import React, { useState } from 'react'

export default function App() {
  const [videoFile, setVideoFile] = useState(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [numClips, setNumClips] = useState(3)
  const [minDuration, setMinDuration] = useState(2)
  const [maxDuration, setMaxDuration] = useState(15)
  const [temperature, setTemperature] = useState(0.7)
  const [status, setStatus] = useState('')

  async function uploadFile() {
    if (!videoFile) return null
    const fd = new FormData()
    fd.append('video', videoFile)
    const res = await fetch('/api/upload', { method: 'POST', body: fd })
    return res.json()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setStatus('Uploading...')
    let uploaded = null
    if (videoFile) uploaded = await uploadFile()
    const videoRef = uploaded ? uploaded.path : videoUrl
    setStatus('Processing...')
    const resp = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: videoRef, prompt, numClips, minDuration, maxDuration, temperature })
    })
    const data = await resp.json()
    setStatus('Done')
    console.log(data)
    alert('Processing complete. See console for output (clip files or candidate timestamps).')
  }

  return (
    <div className="container">
      <h1>AI Clip Creator</h1>
      <form onSubmit={handleSubmit}>
        <label>Upload video file</label>
        <input type="file" accept="video/*" onChange={e => setVideoFile(e.target.files[0])} />
        <div>or provide URL</div>
        <input placeholder="https://..." value={videoUrl} onChange={e => setVideoUrl(e.target.value)} />

        <label>Prompt / what to look for</label>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} />

        <label>Number of clips: {numClips}</label>
        <input type="range" min={1} max={10} value={numClips} onChange={e => setNumClips(Number(e.target.value))} />

        <label>Min duration (s): {minDuration}</label>
        <input type="range" min={1} max={30} value={minDuration} onChange={e => setMinDuration(Number(e.target.value))} />

        <label>Max duration (s): {maxDuration}</label>
        <input type="range" min={1} max={120} value={maxDuration} onChange={e => setMaxDuration(Number(e.target.value))} />

        <label>Temperature: {temperature}</label>
        <input type="range" min={0} max={1} step={0.05} value={temperature} onChange={e => setTemperature(Number(e.target.value))} />

        <button type="submit">Create Clips</button>
      </form>
      <div>{status}</div>
    </div>
  )
}
