require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
const multer = require('multer');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller);

const app = express();
const port = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// Create necessary directories
const dirs = ['public/videos', 'public/uploads', 'temp'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Multer storage setup
const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Endpoint for character image upload
app.post('/api/upload-character', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Endpoint to generate story
app.post('/api/generate-story', async (req, res) => {
    try {
        const { prompt, characters } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        console.log(`Generating story for prompt: "${prompt}"`);
        
        // Analyze character images if they exist
        const analyzedCharacters = await Promise.all(characters.map(async (char) => {
            if (char.imageUrl) {
                try {
                    console.log(`Analyzing character image for ${char.name}...`);
                    // Fix path: remove leading slash if present
                    const relativePath = char.imageUrl.startsWith('/') ? char.imageUrl.substring(1) : char.imageUrl;
                    const imagePath = path.join(__dirname, 'public', relativePath);
                    
                    if (!fs.existsSync(imagePath)) {
                        console.warn(`Character image not found at ${imagePath}`);
                        return char;
                    }

                    const base64Image = fs.readFileSync(imagePath).toString('base64');
                    const extension = path.extname(imagePath).replace('.', '') || 'png';
                    
                    const visionResponse = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    { type: "text", text: "Describe this character's appearance in detail for an image generation prompt. Focus on hair, clothes, facial features, and style. Keep it concise." },
                                    {
                                        type: "image_url",
                                        image_url: { url: `data:image/${extension};base64,${base64Image}` }
                                    }
                                ],
                            },
                        ],
                    });
                    char.visualDescription = visionResponse.choices[0].message.content;
                    console.log(`Successfully analyzed ${char.name}`);
                } catch (visionErr) {
                    console.error(`Vision analysis failed for ${char.name}:`, visionErr.message);
                    // Continue without visual description if vision fails
                }
            }
            return char;
        }));

        const characterContext = analyzedCharacters && analyzedCharacters.length > 0 
            ? `Characters: ${analyzedCharacters.map(c => `${c.name} (${c.description}). Visual Description: ${c.visualDescription || 'Not provided'}`).join(', ')}`
            : '';

        const systemPrompt = `You are a creative storyteller. Generate a detailed story (5-6 scenes) based on the user's prompt and characters.
Aim for a total duration of approximately 1 minute. Each scene should have descriptive narration (approx 20-30 words each).
IMPORTANT: The story (narration and title) MUST be in Hindi.
Visual Prompts: Create DALL-E 3 prompts in ENGLISH. Ensure they are cinematic, safe, and do not violate copyright or safety guidelines. Avoid gore, hyper-realism, or controversial themes.
Return ONLY a JSON object with the following structure:
{
  "title": "Hindi Story Title",
  "scenes": [
    {
      "narration": "The detailed spoken text for this scene in Hindi.",
      "voice": "One of: alloy, echo, fable, onyx, nova, shimmer.",
      "visual_prompt": "A safe, cinematic DALL-E 3 prompt in ENGLISH.",
      "duration": 10
    }
  ]
}`;

        console.log("Calling GPT-4o for story generation...");
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Prompt: ${prompt}\n${characterContext}` }
            ],
            response_format: { type: "json_object" }
        });

        const story = JSON.parse(response.choices[0].message.content);
        console.log("Story generated successfully!");
        res.json(story);
    } catch (error) {
        console.error('Error generating story:', error);
        res.status(500).json({ error: error.message || 'Failed to generate story' });
    }
});

// Simple in-memory job tracker
const jobs = {};

// Endpoint to check video status
app.get('/api/video-status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Updated endpoint to generate video (async)
app.post('/api/generate-video', (req, res) => {
    const { scenes } = req.body;
    const jobId = crypto.randomUUID();
    
    // Initialize job
    jobs[jobId] = { status: 'processing', progress: 0 };
    
    // Start background process
    generateVideoBackground(jobId, scenes).catch(err => {
        console.error(`Job ${jobId} failed:`, err);
        jobs[jobId] = { status: 'failed', error: err.message };
    });
    
    // Return jobId immediately to avoid timeout
    res.json({ jobId });
});

async function generateVideoBackground(jobId, scenes) {
    const videoId = jobId;
    const tempDir = path.join(__dirname, 'temp', videoId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
        console.log(`Starting background video generation: ${videoId}`);
        
        // 1. Generate Assets (Images and Audio)
        const sceneAssets = [];
        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            console.log(`Processing scene ${i + 1}/${scenes.length}`);
            jobs[jobId].progress = Math.round((i / (scenes.length * 2)) * 100);

            // Generate Image
            let imageUrl;
            try {
                const imageResponse = await openai.images.generate({
                    model: "dall-e-3",
                    prompt: scene.visual_prompt,
                    n: 1,
                    size: "1024x1024",
                });
                imageUrl = imageResponse.data[0].url;
            } catch (imgError) {
                console.error(`Image generation failed for scene ${i}:`, imgError.message);
                // If it's a safety error, try a generic safe fallback
                const fallbackPrompt = "A beautiful cinematic digital art landscape, soft lighting, peaceful atmosphere";
                const fallbackResponse = await openai.images.generate({
                    model: "dall-e-3",
                    prompt: fallbackPrompt,
                    n: 1,
                    size: "1024x1024",
                });
                imageUrl = fallbackResponse.data[0].url;
            }
            
            const imagePath = path.join(tempDir, `scene_${i}.png`);
            const imgRes = await fetch(imageUrl);
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            fs.writeFileSync(imagePath, imgBuffer);

            // Generate Audio
            const audioPath = path.join(tempDir, `scene_${i}.mp3`);
            const mp3 = await openai.audio.speech.create({
                model: "tts-1",
                voice: scene.voice || "alloy",
                input: scene.narration,
            });
            const audioBuffer = Buffer.from(await mp3.arrayBuffer());
            fs.writeFileSync(audioPath, audioBuffer);

            sceneAssets.push({ image: imagePath, audio: audioPath });
        }

        // 2. Create Scene Videos
        const sceneVideos = [];
        for (let i = 0; i < sceneAssets.length; i++) {
            const asset = sceneAssets[i];
            const sceneVideoPath = path.join(tempDir, `scene_${i}.mp4`);
            jobs[jobId].progress = 50 + Math.round((i / (sceneAssets.length * 2)) * 100);
            
            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(asset.image)
                    .loop(5)
                    .input(asset.audio)
                    .videoFilters([
                        { filter: 'scale', options: 'w=1280:h=720:force_original_aspect_ratio=decrease' },
                        { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2' },
                        { filter: 'zoompan', options: 'z=\'min(zoom+0.0015,1.5)\':d=125:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1280x720' }
                    ])
                    .outputOptions('-shortest')
                    .output(sceneVideoPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            sceneVideos.push(sceneVideoPath);
        }

        // 3. Concatenate
        const finalVideoPath = path.join(__dirname, 'public', 'videos', `${videoId}.mp4`);
        const listFilePath = path.join(tempDir, 'list.txt');
        const listContent = sceneVideos.map(v => `file '${v}'`).join('\n');
        fs.writeFileSync(listFilePath, listContent);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listFilePath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions('-c copy')
                .output(finalVideoPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // Update Job Status
        jobs[jobId] = { 
            status: 'completed', 
            videoUrl: `/videos/${videoId}.mp4`,
            progress: 100 
        };
        console.log(`Job ${jobId} completed successfully`);

    } catch (error) {
        console.error('Background Generation Error:', error);
        jobs[jobId] = { status: 'failed', error: error.message };
    }
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
