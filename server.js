import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

const VOICES = new Set(["Kore","Puck","Charon","Fenrir","Leda","Aoede","Orus","Zephyr"]);

function keyOf(req) {
  const key = String(req.get("x-gemini-api-key") || "").trim();
  if (key.length < 20) throw new Error("Gemini API key missing or too short.");
  return key;
}
function aiOf(req) { return new GoogleGenAI({ apiKey: keyOf(req) }); }
function tmp(ext) { return path.join(OUTPUT_DIR, crypto.randomBytes(14).toString("hex") + ext); }

async function ffmpeg(args) {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner","-loglevel","error","-y",...args], {
      maxBuffer: 30 * 1024 * 1024
    });
  } catch (e) {
    throw new Error("FFmpeg failed: " + (e.stderr || e.message));
  }
}
async function ffprobeDuration(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",file
    ]);
    const n = Number(stdout.trim());
    if (!Number.isFinite(n)) throw new Error("Could not read video duration.");
    return n;
  } catch (e) {
    throw new Error("FFprobe failed. Please install FFmpeg/ffprobe.");
  }
}
function parseJson(text) {
  const s = String(text || "").replace(/```json/gi,"").replace(/```/g,"").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Gemini returned invalid JSON.");
  return JSON.parse(s.slice(a,b+1));
}
function timeSrt(sec) {
  const ms = Math.max(0, Math.round(sec*1000));
  return `${String(Math.floor(ms/3600000)).padStart(2,"0")}:${String(Math.floor((ms%3600000)/60000)).padStart(2,"0")}:${String(Math.floor((ms%60000)/1000)).padStart(2,"0")},${String(ms%1000).padStart(3,"0")}`;
}
function cleanText(x) {
  return String(x ?? "").replace(/\r?\n/g," ").replace(/\s+/g," ").trim();
}

app.get("/api/health", async (_req,res) => {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    await execFileAsync("ffprobe", ["-version"]);
    res.json({ok:true, ffmpeg:true});
  } catch {
    res.status(500).json({ok:false, error:"FFmpeg/ffprobe is not installed or not in PATH."});
  }
});

app.post("/api/test-key", async (req,res) => {
  try {
    const ai = aiOf(req);
    const r = await ai.interactions.create({
      model: "gemini-3.7-flash",
      input: "Reply with exactly OK."
    });
    res.json({ok:true, message:"Gemini API key works.", reply:r.output_text || "OK"});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

async function uploadVideo(ai, filePath, mime) {
  const f = await ai.files.upload({ file:filePath, config:{mimeType:mime || "video/mp4"} });
  for (let i=0;i<240;i++) {
    const s = await ai.files.get({name:f.name});
    if (s.state === "ACTIVE") return s;
    if (s.state === "FAILED") throw new Error("Gemini video processing failed.");
    await new Promise(r=>setTimeout(r,5000));
  }
  throw new Error("Gemini video processing timed out.");
}

async function analyzeOne(ai, filePath, mime, offset, target, style) {
  const f = await uploadVideo(ai,filePath,mime);
  const prompt = `
You are preparing a dubbing transcript from a video.
Return ONLY JSON. No markdown.
Create short, speakable segments covering spoken dialogue and important visible actions/reactions.
Every segment must have start/end seconds RELATIVE TO THIS CLIP.
Translate every segment into Hindi, Myanmar Burmese, and English.
Do not invent dialogue. If there is no speech, describe the important visible action briefly so the voice-over can narrate it.
Keep each segment concise enough for natural voice-over.
Target language: ${target}. Voice style: ${style}.
JSON:
{"captions":[{"start":0,"end":2,"original":"...","hindi":"...","burmese":"...","english":"..."}]}
`;
  const r = await ai.interactions.create({
    model:"gemini-3.7-flash",
    input:[
      {type:"video",uri:f.uri,mime_type:f.mimeType || mime || "video/mp4"},
      {type:"text",text:prompt}
    ]
  });
  const data = parseJson(r.output_text);
  if (!Array.isArray(data.captions)) throw new Error("Gemini returned no captions.");
  return data.captions.map(c=>({
    start: Math.max(0, Number(c.start)+offset),
    end: Math.max(0, Number(c.end)+offset),
    original: cleanText(c.original),
    hindi: cleanText(c.hindi),
    burmese: cleanText(c.burmese),
    english: cleanText(c.english)
  })).filter(c=>c.end>c.start && (c.hindi||c.burmese||c.english||c.original));
}

app.post("/api/analyze", upload.single("video"), async (req,res) => {
  let original = null;
  const clips = [];
  try {
    const ai = aiOf(req);
    if (!req.file) throw new Error("Please select a video.");
    original = req.file.path;
    const target = req.body.target || "Hindi";
    const style = req.body.style || "normal";
    const duration = await ffprobeDuration(original);
    if (duration > 5400) throw new Error("Maximum supported video length is 90 minutes.");
    // Ten-minute chunks make long videos much more reliable.
    const chunkSeconds = 600;
    const all = [];
    for (let start=0; start<duration; start+=chunkSeconds) {
      const len = Math.min(chunkSeconds,duration-start);
      const clip = tmp(".mp4");
      clips.push(clip);
      await ffmpeg(["-ss",String(start),"-i",original,"-t",String(len),"-map","0:v:0?","-map","0:a:0?","-c","copy","-avoid_negative_ts","make_zero",clip]);
      const rows = await analyzeOne(ai,clip,req.file.mimetype,start,target,style);
      all.push(...rows);
      await fs.unlink(clip).catch(()=>{});
    }
    all.sort((a,b)=>a.start-b.start);
    res.json({duration,captions:all});
  } catch(e) {
    for (const p of clips) await fs.unlink(p).catch(()=>{});
    res.status(400).json({error:e.message});
  } finally {
    if (original) await fs.unlink(original).catch(()=>{});
  }
});

async function ttsToWav(ai, text, voice, style) {
  const styleText = style==="dramatic" ? "dramatic and expressive" : style==="soft" ? "warm, gentle and pleasant" : "natural and clear";
  const r = await ai.interactions.create({
    model:"gemini-3.1-flash-tts-preview",
    input:`Speak ${styleText}. Read this text naturally and clearly: ${text}`,
    response_format:{type:"audio"},
    generation_config:{speech_config:[{voice}]}
  });
  const a = r.output_audio;
  if (!a?.data) throw new Error("Gemini TTS returned no audio data.");
  const mime = String(a.mime_type || "audio/wav");
  const ext = mime.includes("mp3") ? ".mp3" : ".wav";
  const p = tmp(ext);
  await fs.writeFile(p,Buffer.from(a.data,"base64"));
  return p;
}

app.post("/api/render", upload.single("video"), async (req,res) => {
  let original=null, silent=null, final=null;
  const audioFiles=[], listFiles=[];
  try {
    const ai=aiOf(req);
    if (!req.file) throw new Error("Please select the original video.");
    original=req.file.path;
    const captions=JSON.parse(req.body.captions || "[]");
    const target=req.body.target || "Hindi";
    const voice=req.body.voice || "Kore";
    const style=req.body.style || "normal";
    const speed=Math.max(0.5,Math.min(1.5,Number(req.body.speed)||1));
    const zoom=Math.max(1,Math.min(1.5,Number(req.body.zoom)||1));
    const flip=req.body.flip==="true";
    if (!VOICES.has(voice)) throw new Error("Invalid voice selected.");
    if (!Array.isArray(captions) || !captions.length) throw new Error("Analyze the video first.");
    const duration=await ffprobeDuration(original);
    if (duration>5400) throw new Error("Maximum supported video length is 90 minutes.");

    const vf=[];
    if (zoom>1) vf.push(`crop=iw/${zoom}:ih/${zoom}:(iw-iw/${zoom})/2:(ih-ih/${zoom})/2,scale=iw:ih`);
    if (flip) vf.push("hflip");
    silent=tmp(".mp4");
    await ffmpeg([
      "-i",original,
      ...(vf.length?["-vf",vf.join(",")]:[]),
      "-an","-c:v","libx264","-preset","veryfast","-crf","23","-movflags","+faststart",silent
    ]);

    // Generate speech one caption at a time, then place each clip at its timestamp.
    const mixInputs=[];
    const filter=[];
    for(let i=0;i<captions.length;i++){
      const c=captions[i];
      const text=target==="Myanmar"?c.burmese:target==="English"?c.english:c.hindi;
      if(!text) continue;
      const wav=await ttsToWav(ai,text,voice,style);
      audioFiles.push(wav);
      const label=`a${mixInputs.length}`;
      const delay=Math.max(0,Math.round(Number(c.start)*1000));
      filter.push(`[${mixInputs.length+1}:a]atempo=${speed},adelay=${delay}:all=1[${label}]`);
      mixInputs.push(wav);
    }

    if(!mixInputs.length) throw new Error("No voice segments were generated.");

    final=tmp(".mp4");
    const args=["-i",silent];
    for(const f of mixInputs) args.push("-i",f);
    filter.push(`${mixInputs.map((_,i)=>`[a${i}]`).join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0[aout]`);
    await ffmpeg([
      ...args,
      "-filter_complex",filter.join(";"),
      "-map","0:v:0","-map","[aout]",
      "-t",String(duration),
      "-c:v","copy","-c:a","aac","-b:a","160k","-movflags","+faststart",
      final
    ]);

    // Add a simple subtitle file as a separate download-ready artifact too.
    const srt=tmp(".srt");
    const lines=captions.map((c,i)=>{
      const text=target==="Myanmar"?c.burmese:target==="English"?c.english:c.hindi;
      return `${i+1}\n${timeSrt(c.start)} --> ${timeSrt(Math.max(c.start+0.1,c.end))}\n${text}\n`;
    }).join("\n");
    await fs.writeFile(srt,lines,"utf8");
    listFiles.push(srt);

    res.download(final,"translated-video.mp4",async()=>{
      for(const p of [original,silent,final,...audioFiles,...listFiles]) await fs.unlink(p).catch(()=>{});
    });
  } catch(e) {
    for(const p of [original,silent,final,...audioFiles,...listFiles]) await fs.unlink(p).catch(()=>{});
    res.status(400).json({error:e.message});
  }
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));


app.listen(PORT,()=>console.log(`AI Video Translator: http://localhost:${PORT}`));
