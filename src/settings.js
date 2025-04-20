// DOM Elements
const apiTypeSelect = document.getElementById('apiType');
const apiKeyInput = document.getElementById('apiKey');
const showApiKeyBtn = document.getElementById('showApiKey');
const audioDeviceSelect = document.getElementById('audioDevice');
const refreshDevicesBtn = document.getElementById('refreshDevices');
const saveSettingsBtn = document.getElementById('saveSettings');
const statusMessage = document.getElementById('statusMessage');

// Load audio devices
async function loadAudioDevices() {
  try {
    const devices = await window.electronAPI.getAudioDevices();
    
    // Clear and refill dropdown list
    audioDeviceSelect.innerHTML = '';
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default Microphone';
    audioDeviceSelect.appendChild(defaultOption);
    
    // Add available devices
    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device;
      option.textContent = device;
      audioDeviceSelect.appendChild(option);
    });
  } catch (error) {
    showStatus('Error loading audio devices', 'error');
    console.error('Error loading audio devices:', error);
  }
}

// Save settings
async function saveSettings() {
  const settings = {
    apiKey: apiKeyInput.value,
    apiType: apiTypeSelect.value,
    audioDevice: audioDeviceSelect.value
  };
  
  try {
    const result = await window.electronAPI.saveSettings(settings);
    
    if (result.success) {
      showStatus('Settings successfully saved', 'success');
    } else {
      showStatus('Error saving settings', 'error');
    }
  } catch (error) {
    showStatus('Error saving settings', 'error');
    console.error('Error saving:', error);
  }
}

// Show status message
function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = 'status';
  statusMessage.classList.add(type);
  
  // Hide after 3 seconds
  setTimeout(() => {
    statusMessage.className = 'status';
  }, 3000);
}

// Toggle API key visibility
function toggleApiKeyVisibility() {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    showApiKeyBtn.textContent = 'Hide';
  } else {
    apiKeyInput.type = 'password';
    showApiKeyBtn.textContent = 'Show';
  }
}

// Event listeners
window.electronAPI.onSettingsLoaded((settings) => {
  const { apiKey, apiType, audioDevice } = settings;
  
  apiKeyInput.value = apiKey || '';
  apiTypeSelect.value = apiType || 'elevenlabs';
  
  // Load audio devices and then select the saved one
  loadAudioDevices().then(() => {
    if (audioDevice) {
      // Select the saved device after loading
      for (let i = 0; i < audioDeviceSelect.options.length; i++) {
        if (audioDeviceSelect.options[i].value === audioDevice) {
          audioDeviceSelect.selectedIndex = i;
          break;
        }
      }
    }
  });
});

refreshDevicesBtn.addEventListener('click', loadAudioDevices);
showApiKeyBtn.addEventListener('click', toggleApiKeyVisibility);
saveSettingsBtn.addEventListener('click', saveSettings);

// Initially load audio devices
loadAudioDevices();