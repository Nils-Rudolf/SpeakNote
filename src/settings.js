// DOM-Elemente
const apiTypeSelect = document.getElementById('apiType');
const apiKeyInput = document.getElementById('apiKey');
const showApiKeyBtn = document.getElementById('showApiKey');
const audioDeviceSelect = document.getElementById('audioDevice');
const refreshDevicesBtn = document.getElementById('refreshDevices');
const saveSettingsBtn = document.getElementById('saveSettings');
const statusMessage = document.getElementById('statusMessage');

// Audio-Geräte laden
async function loadAudioDevices() {
  try {
    const devices = await window.electronAPI.getAudioDevices();
    
    // Dropdown-Liste leeren und neu befüllen
    audioDeviceSelect.innerHTML = '';
    
    // Standardoption hinzufügen
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Standard-Mikrofon';
    audioDeviceSelect.appendChild(defaultOption);
    
    // Verfügbare Geräte hinzufügen
    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device;
      option.textContent = device;
      audioDeviceSelect.appendChild(option);
    });
  } catch (error) {
    showStatus('Fehler beim Laden der Audio-Geräte', 'error');
    console.error('Fehler beim Laden der Audio-Geräte:', error);
  }
}

// Einstellungen speichern
async function saveSettings() {
  const settings = {
    apiKey: apiKeyInput.value,
    apiType: apiTypeSelect.value,
    audioDevice: audioDeviceSelect.value
  };
  
  try {
    const result = await window.electronAPI.saveSettings(settings);
    
    if (result.success) {
      showStatus('Einstellungen erfolgreich gespeichert', 'success');
    } else {
      showStatus('Fehler beim Speichern der Einstellungen', 'error');
    }
  } catch (error) {
    showStatus('Fehler beim Speichern der Einstellungen', 'error');
    console.error('Fehler beim Speichern:', error);
  }
}

// Statusmeldung anzeigen
function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = 'status';
  statusMessage.classList.add(type);
  
  // Nach 3 Sekunden ausblenden
  setTimeout(() => {
    statusMessage.className = 'status';
  }, 3000);
}

// API-Schlüssel ein-/ausblenden
function toggleApiKeyVisibility() {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    showApiKeyBtn.textContent = 'Verbergen';
  } else {
    apiKeyInput.type = 'password';
    showApiKeyBtn.textContent = 'Anzeigen';
  }
}

// Event-Listener
window.electronAPI.onSettingsLoaded((settings) => {
  const { apiKey, apiType, audioDevice } = settings;
  
  apiKeyInput.value = apiKey || '';
  apiTypeSelect.value = apiType || 'elevenlabs';
  
  // Audio-Geräte laden und dann das gespeicherte auswählen
  loadAudioDevices().then(() => {
    if (audioDevice) {
      // Nach dem Laden der Geräte das gespeicherte auswählen
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

// Initial Audio-Geräte laden
loadAudioDevices();