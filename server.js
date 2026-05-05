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
- Video prompts must be in English, family-friendly, cinematic, and Sora-safe (no violence, no real people, no copyrighted characters).
- Focus video prompts on MOVEMENT and ACTION (e.g., "A playful monkey swings from vine to vine in a lush jungle").
- Choose voice: nova=sweet/warm (best for kids), shimmer=clear/friendly, fable=expressive/storytelling.
- AVOID deep/scary voices unless for a villain. 
- The tone MUST be sweet, gentle, and child-friendly. Always default to 'nova' for a sweet baby-like narration.

Return ONLY valid JSON, no markdown, no code blocks:
{
  "title": "...",
  "scenes": [
    {
      "narration": "Hindi text here",
      "voice": "nova",
      "video_prompt": "Detailed English video prompt for Sora, cinematic, high quality 3D animation style, focusing on movement"
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
        
        // Pass character images to scenes if applicable (for reference)
        story.scenes = story.scenes.map(s => {
            if (characters.length > 0) {
                s.character_ref = characters[0].imageUrl; // Use primary character for reference
            }
            return s;
        });
        
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

        const sceneVideos = [];
        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const sceneProgressBase = 10 + Math.round((i / scenes.length) * 80);
            
            setProgress(sceneProgressBase, `Generating video for scene ${i + 1} of ${scenes.length}...`);

            // 1. Start Sora Video Generation
            let soraJob;
            try {
                const videoParams = {
                    model: 'sora-2',
                    prompt: scene.video_prompt + ', high quality 3D animated cartoon style, vibrant colors, cinematic lighting',
                    size: '1280x720',
                    seconds: '12'
                };

                // Add character reference if available
                if (scene.character_ref) {
                    const charPath = path.join(__dirname, 'public', scene.character_ref.replace(/^\//, ''));
                    if (fs.existsSync(charPath)) {
                        // Sora expects file-id or URL. We'll use a local stream if supported or base64
                        // For this environment, we'll assume it takes a readable stream or we can skip reference if it fails
                        try {
                            videoParams.input_reference = fs.createReadStream(charPath);
                        } catch (e) {
                            console.warn(`  ⚠️ Could not attach reference: ${e.message}`);
                        }
                    }
                }

                soraJob = await openai.videos.create(videoParams);
                console.log(`  🚀 Sora job created: ${soraJob.id}`);
            } catch (e) {
                console.error(`  ❌ Sora creation failed: ${e.message}`);
                throw new Error(`Failed to start video generation for scene ${i+1}: ${e.message}`);
            }

            // 2. Generate Audio (simultaneously)
            const audioPromise = openai.audio.speech.create({
                model: 'tts-1',
                voice: scene.voice || 'alloy',
                input: scene.narration,
                speed: 0.95
            });

            // 3. Poll Sora Job Status
            let videoResult = soraJob;
            let pollCount = 0;
            while (videoResult.status !== 'completed' && videoResult.status !== 'failed') {
                await new Promise(r => setTimeout(r, 10000)); // Poll every 10s
                videoResult = await openai.videos.retrieve(soraJob.id);
                pollCount++;
                setProgress(sceneProgressBase + Math.min(pollCount, 10), `Sora is rendering scene ${i + 1}... (${videoResult.progress}%)`);
                
                if (pollCount > 60) throw new Error(`Scene ${i+1} generation timed out`);
            }

            if (videoResult.status === 'failed') {
                throw new Error(`Sora failed to generate scene ${i+1}: ${videoResult.error?.message || 'Unknown error'}`);
            }

            // 4. Download Video and Save Audio
            setProgress(sceneProgressBase + 12, `Downloading assets for scene ${i + 1}...`);
            const [audio, videoStream] = await Promise.all([
                audioPromise,
                openai.videos.downloadContent(videoResult.id)
            ]);

            const videoPath = path.join(tempDir, `raw_scene_${i}.mp4`);
            const audioPath = path.join(tempDir, `scene_${i}.mp3`);
            
            // Save video
            const videoBuffer = await videoStream.arrayBuffer();
            fs.writeFileSync(videoPath, Buffer.from(videoBuffer));

            // Save audio
            fs.writeFileSync(audioPath, Buffer.from(await audio.arrayBuffer()));

            // 5. Merge Video + Audio with FFmpeg
            const outPath = path.join(tempDir, `clip_${i}.mp4`);
            setProgress(sceneProgressBase + 15, `Merging scene ${i + 1}...`);

            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(videoPath)
                    .input(audioPath)
                    .outputOptions([
                        '-c:v copy',      // Copy video stream (no re-encode)
                        '-c:a aac',       // Encode audio
                        '-shortest',      // Cut to shortest (usually audio)
                        '-map 0:v:0',     // Take video from first input
                        '-map 1:a:0'      // Take audio from second input
                    ])
                    .output(outPath)
                    .on('end', () => { sceneVideos.push(outPath); resolve(); })
                    .on('error', reject)
                    .run();
            });
        }

        setProgress(95, 'Finalizing video...');

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
