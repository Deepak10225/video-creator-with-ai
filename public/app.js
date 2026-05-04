let characters = [];
let currentStory = null;

const charNameInput = document.getElementById('char-name');
const charDescInput = document.getElementById('char-desc');
const charImageInput = document.getElementById('char-image');
const charImageLabel = document.querySelector('.file-label');
const addCharBtn = document.getElementById('btn-add-char');
const charList = document.getElementById('character-list');
const storyPrompt = document.getElementById('story-prompt');
const generateStoryBtn = document.getElementById('btn-generate-story');
const storyPreview = document.getElementById('story-preview');
const previewTitle = document.getElementById('preview-title');
const scenesContainer = document.getElementById('scenes-container');
const createVideoBtn = document.getElementById('btn-create-video');
const videoSection = document.getElementById('video-section');
const videoLoader = document.getElementById('video-loader');
const finalVideo = document.getElementById('final-video');
const downloadLink = document.getElementById('download-link');

let uploadedImageUrl = null;

// Handle image upload change
charImageInput.addEventListener('change', async () => {
    const file = charImageInput.files[0];
    if (!file) return;

    charImageLabel.innerText = 'Uploading...';
    
    const formData = new FormData();
    formData.append('image', file);

    try {
        const response = await fetch('/api/upload-character', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        uploadedImageUrl = data.imageUrl;
        charImageLabel.innerText = 'Image Ready!';
        charImageLabel.classList.add('uploaded');
    } catch (error) {
        console.error(error);
        charImageLabel.innerText = 'Upload Failed';
    }
});

// Character Management
addCharBtn.addEventListener('click', () => {
    const name = charNameInput.value.trim();
    const desc = charDescInput.value.trim();
    if (name) {
        characters.push({ 
            name, 
            description: desc, 
            imageUrl: uploadedImageUrl 
        });
        renderCharacters();
        // Reset
        charNameInput.value = '';
        charDescInput.value = '';
        charImageInput.value = '';
        charImageLabel.innerText = 'Upload Image';
        charImageLabel.classList.remove('uploaded');
        uploadedImageUrl = null;
    }
});

function renderCharacters() {
    charList.innerHTML = characters.map((c, i) => `
        <div class="char-tag">
            ${c.imageUrl ? `<img src="${c.imageUrl}" class="char-thumb">` : ''}
            ${c.name} 
            <button onclick="removeChar(${i})">&times;</button>
        </div>
    `).join('');
}

window.removeChar = (index) => {
    characters.splice(index, 1);
    renderCharacters();
};

// Generate Story
generateStoryBtn.addEventListener('click', async () => {
    const prompt = storyPrompt.value.trim();
    if (!prompt) return alert('Please enter a story prompt!');

    generateStoryBtn.disabled = true;
    generateStoryBtn.innerText = 'Consulting the Oracle...';

    try {
        const response = await fetch('/api/generate-story', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, characters })
        });
        
        currentStory = await response.json();
        renderStoryPreview();
    } catch (error) {
        console.error(error);
        alert('Failed to generate story. Check console.');
    } finally {
        generateStoryBtn.disabled = false;
        generateStoryBtn.innerText = 'Generate Story Concept';
    }
});

function renderStoryPreview() {
    storyPreview.classList.remove('hidden');
    previewTitle.innerText = currentStory.title;
    scenesContainer.innerHTML = currentStory.scenes.map((scene, i) => `
        <div class="scene-item">
            <h4>Scene ${i + 1}</h4>
            <p>${scene.narration}</p>
        </div>
    `).join('');
    
    // Smooth scroll to preview
    storyPreview.scrollIntoView({ behavior: 'smooth' });
}

// Create Video
createVideoBtn.addEventListener('click', async () => {
    if (!currentStory) return;

    videoSection.classList.remove('hidden');
    videoLoader.classList.remove('hidden');
    finalVideo.classList.add('hidden');
    downloadLink.classList.add('hidden');
    
    videoSection.scrollIntoView({ behavior: 'smooth' });

    try {
        const response = await fetch('/api/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenes: currentStory.scenes })
        });
        
        const data = await response.json();
        if (data.videoUrl) {
            finalVideo.src = data.videoUrl;
            finalVideo.classList.remove('hidden');
            videoLoader.classList.add('hidden');
            downloadLink.href = data.videoUrl;
            downloadLink.classList.remove('hidden');
        } else {
            throw new Error('No video URL returned');
        }
    } catch (error) {
        console.error(error);
        alert('Video generation failed. It might be due to API timeouts (DALL-E can be slow). Check server logs.');
        videoLoader.classList.add('hidden');
    }
});
