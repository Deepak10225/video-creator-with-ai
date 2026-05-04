require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
const multer = require('multer');

// ─── Setup ───────────────────────────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegInstaller);

const app = express();
const port = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create dirs
['public/videos', 'public/uploads', 'temp'].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Multer (character image upload) ─────────────────────────────────────────
const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Job tracker ─────────────────────────────────────────────────────────────
const jobs = {};

// ─── Routes ──────────────────────────────────────────────────────────────────

// Upload character image
app.post('/api/upload-character', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Generate Story
app.post('/api/generate-story', async (req, res) => {
    try {
        const { prompt, characters = [] } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'Please enter a story prompt' });
        }

        console.log(`\n📖 Generating story: "${prompt}"`);

        // Analyze uploaded character images via GPT-4o Vision
        for (const char of characters) {
            if (char.imageUrl) {
                try {
                    const imgPath = path.join(__dirname, 'public', char.imageUrl.replace(/^\//, ''));
                    if (fs.existsSync(imgPath)) {
                        const ext = path.extname(imgPath).slice(1) || 'jpeg';
                        const b64 = fs.readFileSync(imgPath).toString('base64');
                        const vision = await openai.chat.completions.create({
                            model: 'gpt-4o',
                            max_tokens: 200,
                            messages: [{
                                role: 'user',
                                content: [
                                    { type: 'text', text: 'Describe this character\'s visual appearance in one concise paragraph for use in image generation prompts (focus on: species/type, color, clothing, features).' },
                                    { type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } }
                                ]
                            }]
                        });
                        char.visualDescription = vision.choices[0].message.content;
                        console.log(`  ✅ Analyzed ${char.name}`);
                    }
                } catch (e) {
                    console.warn(`  ⚠️  Vision failed for ${char.name}: ${e.message}`);
                }
            }
        }

        const charContext = characters.length > 0
            ? 'Characters:\n' + characters.map(c =>
                `- ${c.name}: ${c.description || ''}${c.visualDescription ? '. Appearance: ' + c.visualDescription : ''}`
              ).join('\n')
            : '';

        const systemPrompt = `You are a Hindi storyteller for children and families. Create a 1-minute animated video story with exactly 5 scenes.

RULES:
- Title and all narration MUST be in Hindi (Devanagari script)
- Each narration must be 25-35 words in Hindi (to last ~10 seconds when spoken)
- Visual prompts must be in English, family-friendly, cinematic, and DALL-E safe (no violence, no real people, no copyrighted characters)
- Choose voice: onyx=deep/male, nova=warm/female, shimmer=clear/neutral, alloy=calm, echo=smooth, fable=storytelling
- For animals: use onyx for lions/bears, shimmer for parrots/birds, nova for gentle animals

Return ONLY valid JSON, no markdown, no code blocks:
{
  "title": "...",
  "scenes": [
    {
      "narration": "Hindi text here",
      "voice": "alloy",
      "visual_prompt": "Detailed English prompt for DALL-E, cinematic, high quality digital art"
    }
  ]
}`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            response_format: { type: 'json_object' },
            temperature: 0.8,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Story prompt: ${prompt}\n\n${charContext}` }
            ]
        });

        const story = JSON.parse(completion.choices[0].message.content);
        
        // Validate
        if (!story.title || !Array.isArray(story.scenes) || story.scenes.length === 0) {
            throw new Error('Invalid story format returned by AI');
        }

        console.log(`  ✅ Story "${story.title}" with ${story.scenes.length} scenes`);
        res.json(story);

    } catch (err) {
        console.error('❌ Story generation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Start Video Generation (async)
app.post('/api/generate-video', (req, res) => {
    const { scenes } = req.body;
    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
        return res.status(400).json({ error: 'No scenes provided' });
    }
    const jobId = crypto.randomUUID();
    jobs[jobId] = { status: 'processing', progress: 0, message: 'Starting...' };
    runVideoGeneration(jobId, scenes);
    res.json({ jobId });
});

// Poll Video Status
app.get('/api/video-status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ─── Background video generator ──────────────────────────────────────────────
async function runVideoGeneration(jobId, scenes) {
    const tempDir = path.join(__dirname, 'temp', jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    const setProgress = (progress, message) => {
        jobs[jobId] = { ...jobs[jobId], status: 'processing', progress, message };
        console.log(`  [${jobId.slice(0, 6)}] ${progress}% - ${message}`);
    };

    try {
        console.log(`\n🎬 Starting video job ${jobId.slice(0, 8)}... (${scenes.length} scenes)`);
        setProgress(5, 'Preparing assets...');

        const sceneAssets = [];

        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const pct = Math.round(10 + (i / scenes.length) * 60);
            setProgress(pct, `Generating scene ${i + 1} of ${scenes.length}...`);

            // Generate image with safety fallback
            let imageUrl;
            const safePrompt = scene.visual_prompt + ', animated cartoon style, family-friendly, vibrant colors, no humans, no real people, no copyrighted characters';
            for (const prompt of [safePrompt, 'Beautiful colorful jungle landscape, animated cartoon style, vibrant, cinematic']) {
                try {
                    const imgResp = await openai.images.generate({
                        model: 'dall-e-3',
                        prompt,
                        n: 1,
                        size: '1024x1024',
                        quality: 'standard'
                    });
                    imageUrl = imgResp.data[0].url;
                    break;
                } catch (e) {
                    console.warn(`  ⚠️  Image attempt failed: ${e.message.slice(0, 60)}`);
                }
            }

            if (!imageUrl) throw new Error(`Failed to generate image for scene ${i + 1}`);

            // Download image
            const imgPath = path.join(tempDir, `scene_${i}.jpg`);
            const imgData = await fetch(imageUrl);
            fs.writeFileSync(imgPath, Buffer.from(await imgData.arrayBuffer()));

            // Generate audio
            const audioPath = path.join(tempDir, `scene_${i}.mp3`);
            const audio = await openai.audio.speech.create({
                model: 'tts-1',
                voice: scene.voice || 'alloy',
                input: scene.narration,
                speed: 0.9
            });
            fs.writeFileSync(audioPath, Buffer.from(await audio.arrayBuffer()));

            sceneAssets.push({ image: imgPath, audio: audioPath });
        }

        setProgress(70, 'Processing video scenes...');

        // Build each scene video
        const sceneVideos = [];
        for (let i = 0; i < sceneAssets.length; i++) {
            const { image, audio } = sceneAssets[i];
            const outPath = path.join(tempDir, `clip_${i}.mp4`);

            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(image)
                    .inputOptions(['-loop 1'])
                    .input(audio)
                    .complexFilter([
                        `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,zoompan=z='min(zoom+0.001,1.3)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720[v]`
                    ])
                    .outputOptions([
                        '-map [v]',
                        '-map 1:a',
                        '-c:v libx264',
                        '-c:a aac',
                        '-pix_fmt yuv420p',
                        '-shortest',
                        '-movflags +faststart'
                    ])
                    .output(outPath)
                    .on('end', () => { sceneVideos.push(outPath); resolve(); })
                    .on('error', reject)
                    .run();
            });

            setProgress(70 + Math.round((i + 1) / sceneAssets.length * 20), `Rendered scene ${i + 1}/${sceneAssets.length}`);
        }

        setProgress(92, 'Concatenating final video...');

        // Concatenate all scene clips
        const listFile = path.join(tempDir, 'list.txt');
        fs.writeFileSync(listFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

        const finalVideo = path.join(__dirname, 'public', 'videos', `${jobId}.mp4`);
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listFile)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions(['-c copy'])
                .output(finalVideo)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        jobs[jobId] = {
            status: 'completed',
            progress: 100,
            message: 'Done!',
            videoUrl: `/videos/${jobId}.mp4`
        };
        console.log(`\n✅ Video job ${jobId.slice(0, 8)} complete!`);

    } catch (err) {
        console.error(`\n❌ Video job ${jobId.slice(0, 8)} failed:`, err.message);
        jobs[jobId] = { status: 'failed', progress: 0, message: err.message, error: err.message };
    }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
    console.log(`\n🚀 Server running at http://localhost:${port}`);
    console.log(`   OpenAI Key: ${process.env.OPENAI_API_KEY ? '✅ Set' : '❌ MISSING!'}`);
});
