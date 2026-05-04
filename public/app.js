/* ========================================
   AI Story & Video Creator — app.js
   ======================================== */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let characters = [];
let story = null;
let pendingImageUrl = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elStoryPrompt   = document.getElementById('story-prompt');
const elCharName      = document.getElementById('char-name');
const elCharDesc      = document.getElementById('char-desc');
const elCharImgInput  = document.getElementById('char-img-input');
const elCharImgLabel  = document.getElementById('char-img-label');
const elCharList      = document.getElementById('char-list');
const elBtnAddChar    = document.getElementById('btn-add-char');
const elBtnGenStory   = document.getElementById('btn-generate-story');

const elStepPreview   = document.getElementById('step-preview');
const elStoryTitle    = document.getElementById('story-title');
const elScenesList    = document.getElementById('scenes-list');
const elBtnMakeVideo  = document.getElementById('btn-make-video');

const elStepVideo     = document.getElementById('step-video');
const elProgressFill  = document.getElementById('progress-fill');
const elProgressText  = document.getElementById('progress-text');
const elResultVideo   = document.getElementById('result-video');
const elDownloadBtn   = document.getElementById('download-btn');

// ─── Character image upload ───────────────────────────────────────────────────
elCharImgInput.addEventListener('change', async () => {
    const file = elCharImgInput.files[0];
    if (!file) return;

    elCharImgLabel.textContent = '⏳ अपलोड...';
    elCharImgLabel.classList.remove('ready');

    const form = new FormData();
    form.append('image', file);

    try {
        const res = await fetch('/api/upload-character', { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());
        const { imageUrl } = await res.json();
        pendingImageUrl = imageUrl;
        elCharImgLabel.textContent = '✅ तैयार!';
        elCharImgLabel.classList.add('ready');
    } catch (e) {
        console.error('Upload error:', e);
        elCharImgLabel.textContent = '❌ विफल';
        pendingImageUrl = null;
    }
});

// ─── Add character ────────────────────────────────────────────────────────────
elBtnAddChar.addEventListener('click', () => {
    const name = elCharName.value.trim();
    if (!name) { elCharName.focus(); return; }
    characters.push({ name, description: elCharDesc.value.trim(), imageUrl: pendingImageUrl });
    renderChars();
    elCharName.value = '';
    elCharDesc.value = '';
    elCharImgInput.value = '';
    elCharImgLabel.textContent = '📷 फोटो';
    elCharImgLabel.classList.remove('ready');
    pendingImageUrl = null;
});

function renderChars() {
    elCharList.innerHTML = characters.map((c, i) => `
        <div class="char-tag">
            ${c.imageUrl ? `<img src="${c.imageUrl}" class="char-thumb" alt="${c.name}">` : ''}
            <span>${c.name}</span>
            <button onclick="removeChar(${i})" title="हटाएं">×</button>
        </div>`).join('');
}

window.removeChar = i => { characters.splice(i, 1); renderChars(); };

// ─── Generate story ───────────────────────────────────────────────────────────
elBtnGenStory.addEventListener('click', async () => {
    const prompt = elStoryPrompt.value.trim();
    if (!prompt) { elStoryPrompt.focus(); return; }

    elBtnGenStory.disabled = true;
    elBtnGenStory.innerHTML = '<div class="spinner"></div> कहानी लिख रहे हैं...';

    try {
        const res = await fetch('/api/generate-story', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, characters })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

        story = data;
        showStoryPreview();
    } catch (e) {
        alert(`कहानी बनाने में त्रुटि:\n${e.message}`);
        console.error(e);
    } finally {
        elBtnGenStory.disabled = false;
        elBtnGenStory.innerHTML = '<span class="btn-icon">✨</span> कहानी बनाएं';
    }
});

function showStoryPreview() {
    elStoryTitle.textContent = story.title;
    elScenesList.innerHTML = story.scenes.map((s, i) => `
        <div class="scene-card">
            <div class="scene-num">दृश्य ${i + 1} • ${s.voice || 'alloy'}</div>
            <p>${s.narration}</p>
        </div>`).join('');
    elStepPreview.classList.remove('hidden');
    elStepPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Generate video ───────────────────────────────────────────────────────────
elBtnMakeVideo.addEventListener('click', async () => {
    if (!story) return;

    elBtnMakeVideo.disabled = true;
    elBtnMakeVideo.innerHTML = '<div class="spinner"></div> शुरू हो रहा है...';
    elStepVideo.classList.remove('hidden');
    elResultVideo.classList.add('hidden');
    elDownloadBtn.classList.add('hidden');
    setProgress(0, 'वीडियो बनाने की तैयारी...');
    elStepVideo.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
        const res = await fetch('/api/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenes: story.scenes })
        });

        if (!res.ok) {
            const d = await res.json();
            throw new Error(d.error || `Server error ${res.status}`);
        }

        const { jobId } = await res.json();
        if (!jobId) throw new Error('Job ID नहीं मिला');
        pollStatus(jobId);

    } catch (e) {
        alert(`वीडियो शुरू करने में त्रुटि:\n${e.message}`);
        console.error(e);
        elBtnMakeVideo.disabled = false;
        elBtnMakeVideo.innerHTML = '<span class="btn-icon">🎬</span> 1 मिनट का वीडियो बनाएं';
    }
});

// ─── Polling ──────────────────────────────────────────────────────────────────
function pollStatus(jobId) {
    const timer = setInterval(async () => {
        try {
            const res = await fetch(`/api/video-status/${jobId}`);
            const job = await res.json();

            if (job.status === 'completed') {
                clearInterval(timer);
                setProgress(100, '✅ वीडियो तैयार है!');
                elResultVideo.src = job.videoUrl;
                elResultVideo.classList.remove('hidden');
                elDownloadBtn.href = job.videoUrl;
                elDownloadBtn.download = 'ai-kahani.mp4';
                elDownloadBtn.classList.remove('hidden');
                elBtnMakeVideo.disabled = false;
                elBtnMakeVideo.innerHTML = '<span class="btn-icon">🎬</span> दोबारा बनाएं';

            } else if (job.status === 'failed') {
                clearInterval(timer);
                alert(`वीडियो बनाने में त्रुटि:\n${job.error}`);
                setProgress(0, '❌ त्रुटि हुई');
                elBtnMakeVideo.disabled = false;
                elBtnMakeVideo.innerHTML = '<span class="btn-icon">🎬</span> फिर कोशिश करें';

            } else {
                setProgress(job.progress || 0, job.message || 'प्रक्रिया चल रही है...');
            }
        } catch (e) {
            console.error('Polling error:', e);
        }
    }, 3000);
}

function setProgress(pct, msg) {
    elProgressFill.style.width = `${pct}%`;
    elProgressText.textContent = msg;
}
