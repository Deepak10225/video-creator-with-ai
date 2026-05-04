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
        
        // Analyze character images if they exist
        const analyzedCharacters = await Promise.all(characters.map(async (char) => {
            if (char.imageUrl) {
                console.log(`Analyzing character image for ${char.name}...`);
                const imagePath = path.join(__dirname, 'public', char.imageUrl);
                const base64Image = fs.readFileSync(imagePath).toString('base64');
                
                const visionResponse = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Describe this character's appearance in detail for an image generation prompt. Focus on hair, clothes, facial features, and style. Keep it concise." },
                                {
                                    type: "image_url",
                                    image_url: { url: `data:image/png;base64,${base64Image}` }
                                }
                            ],
                        },
                    ],
                });
                char.visualDescription = visionResponse.choices[0].message.content;
            }
            return char;
        }));

        const characterContext = analyzedCharacters && analyzedCharacters.length > 0 
            ? `Characters: ${analyzedCharacters.map(c => `${c.name} (${c.description}). Visual Description: ${c.visualDescription || 'Not provided'}`).join(', ')}`
            : '';

        const systemPrompt = `You are a creative storyteller. Generate a long, detailed story (10-12 scenes) based on the user's prompt and characters.
Aim for a total duration of approximately 2 minutes. Each scene should have descriptive, lengthy narration (approx 30-40 words each).
IMPORTANT: The story (narration and title) MUST be in Hindi.
Return ONLY a JSON object with the following structure:
{
  "title": "Hindi Story Title",
  "scenes": [
    {
      "narration": "The detailed spoken text for this scene in Hindi (at least 2-3 sentences).",
      "voice": "One of: alloy, echo, fable, onyx, nova, shimmer.",
      "visual_prompt": "A detailed DALL-E 3 prompt in ENGLISH to generate a cinematic, high-quality image for this scene. Include character visual descriptions to keep them consistent.",
      "duration": 10
    }
  ]
}
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Prompt: ${prompt}\n${characterContext}` }
            ],
            response_format: { type: "json_object" }
        });

        const story = JSON.parse(response.choices[0].message.content);
        res.json(story);
    } catch (error) {
        console.error('Error generating story:', error);
        res.status(500).json({ error: 'Failed to generate story' });
    }
});

// Endpoint to generate video
app.post('/api/generate-video', async (req, res) => {
    const { scenes } = req.body;
    const videoId = crypto.randomUUID();
    const tempDir = path.join(__dirname, 'temp', videoId);
    fs.mkdirSync(tempDir);

    try {
        console.log(`Starting video generation: ${videoId}`);
        
        // 1. Generate Assets (Images and Audio)
        const sceneAssets = [];
        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            console.log(`Processing scene ${i + 1}/${scenes.length}`);

            // Generate Image
            const imageResponse = await openai.images.generate({
                model: "dall-e-3",
                prompt: scene.visual_prompt,
                n: 1,
                size: "1024x1024",
            });
            const imageUrl = imageResponse.data[0].url;
            const imagePath = path.join(tempDir, `scene_${i}.png`);
            
            // Download image
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

        // 2. Create Scene Videos (Image + Audio)
        const sceneVideos = [];
        for (let i = 0; i < sceneAssets.length; i++) {
            const asset = sceneAssets[i];
            const sceneVideoPath = path.join(tempDir, `scene_${i}.mp4`);
            
            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(asset.image)
                    .loop(5) // Default duration if audio fails, but we'll sync with audio
                    .input(asset.audio)
                    .videoFilters([
                        {
                            filter: 'scale',
                            options: 'w=1280:h=720:force_original_aspect_ratio=decrease'
                        },
                        {
                            filter: 'pad',
                            options: '1280:720:(ow-iw)/2:(oh-ih)/2'
                        },
                        // Ken Burns Effect (Zoom)
                        {
                            filter: 'zoompan',
                            options: 'z=\'min(zoom+0.0015,1.5)\':d=125:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1280x720'
                        }
                    ])
                    .outputOptions('-shortest') // Sync video length to audio length
                    .output(sceneVideoPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            sceneVideos.push(sceneVideoPath);
        }

        // 3. Concatenate Scene Videos
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

        // Cleanup temp files (optional, maybe keep for debug)
        // fs.rmSync(tempDir, { recursive: true, force: true });

        res.json({ videoUrl: `/videos/${videoId}.mp4` });
    } catch (error) {
        console.error('Video Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate video' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
