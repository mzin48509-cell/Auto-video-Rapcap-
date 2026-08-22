# AI Video Translator v2

This version is designed for **1 minute through 90 minutes**.

## Required
- Node.js 20+
- FFmpeg + FFprobe installed and available in PATH
- A Gemini API key with access to the required models

## Run
npm install
npm start

Open http://localhost:3000

Paste the Gemini API key at the top and press Test.

## Long video design
Videos up to 90 minutes are split into 10-minute temporary clips for Gemini analysis. Caption timestamps are shifted back to the original timeline. TTS is generated per caption and FFmpeg places the audio at the correct timestamps.

## Current Gemini API
The code follows the current Interactions API examples for:
- video input with `type: "video"`
- TTS with `gemini-3.1-flash-tts-preview`
- `response_format: { type: "audio" }`
- `interaction.output_audio.data`

## Honest reliability note
No software can be guaranteed to have zero errors on every machine, API account, video codec, quota state, or deployment. This package includes explicit error handling and checks for FFmpeg/FFprobe. Test with a short video first.

## Copyright / watermark
This starter does not remove third-party watermarks. Use video that you own or have permission to edit.
