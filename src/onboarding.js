// Onboarding process for SpeakNote
document.addEventListener('DOMContentLoaded', () => {
    let currentStep = 1;
    const totalSteps = 4;
    
    const nextBtn = document.getElementById('next-btn');
    const prevBtn = document.getElementById('prev-btn');
    const openAccessibilityBtn = document.getElementById('open-accessibility');
    const openMicSettingsBtn = document.getElementById('open-mic-settings');
    const apiTypeSelect = document.getElementById('apiType');
    
    // Access API via preload script
    const { onboarding, setAPIKey, getAPIOptions } = window.electronAPI;
    
    // Initialize API types
    initAPIOptions();
    
    // Open microphone settings when button is clicked
    openMicSettingsBtn.addEventListener('click', () => {
        onboarding.openMicrophoneSettings();
    });
    
    // Get API options from main process and populate select
    async function initAPIOptions() {
        try {
            const apiOptions = await getAPIOptions();
            // Clear existing options
            apiTypeSelect.innerHTML = '';
            
            // Add options to select
            apiOptions.forEach(option => {
                const optElement = document.createElement('option');
                optElement.value = option.value;
                optElement.textContent = option.name;
                optElement.selected = option.default || false;
                apiTypeSelect.appendChild(optElement);
            });
        } catch (error) {
            console.error('Failed to load API options:', error);
            // Fallback options if loading fails
            apiTypeSelect.innerHTML = `
                <option value="openai" selected>OpenAI Whisper</option>
            `;
        }
    }
    
    // Open accessibility settings
    openAccessibilityBtn.addEventListener('click', () => {
        onboarding.openAccessibilitySettings();
    });
    
    // Navigate to next step
    nextBtn.addEventListener('click', async () => {
        // Specific actions based on current step
        if (currentStep === 3) {
            // Save API settings
            const apiType = apiTypeSelect.value;
            const apiKey = document.getElementById('apiKey').value;
            
            if (apiKey.trim() !== '') {
                setAPIKey({
                    apiType,
                    apiKey
                });
            }
        } else if (currentStep === totalSteps) {
            // On last step, finish onboarding
            onboarding.finishOnboarding();
            return;
        }
        
        // Move to next step
        if (currentStep < totalSteps) {
            updateStep(currentStep + 1);
        }
    });
    
    // Navigate to previous step
    prevBtn.addEventListener('click', () => {
        if (currentStep > 1) {
            updateStep(currentStep - 1);
        }
    });
    
    // Update UI based on current step
    function updateStep(step) {
        // Hide active step
        document.getElementById(`step${currentStep}`).classList.remove('active');
        
        // Show new step
        currentStep = step;
        document.getElementById(`step${currentStep}`).classList.add('active');
        
        // Show/hide back button
        prevBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
        
        // Change next button text on last step
        nextBtn.textContent = currentStep === totalSteps ? 'Finish' : 'Next';
        
        // Update progress dots
        document.querySelectorAll('.dot').forEach((dot, index) => {
            dot.classList.toggle('active', index + 1 === currentStep);
        });
    }
});