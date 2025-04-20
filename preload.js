const { contextBridge, ipcRenderer } = require('electron');

// API für den Renderer-Prozess verfügbar machen
contextBridge.exposeInMainWorld('electronAPI', {
  // Audio-Geräte
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
  
  // Einstellungen
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  
  // Aufnahme-Steuerung
  toggleRecording: () => ipcRenderer.invoke('toggle-recording'),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording'), // Neue Funktion zum Abbrechen
  
  // Overlay schließen
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  
  // Event-Listener
  onSettingsLoaded: (callback) => {
    ipcRenderer.on('settings-loaded', (_, data) => callback(data));
  },
  onRecordingStarted: (callback) => {
    ipcRenderer.on('recording-started', () => callback());
  },
  onRecordingStopped: (callback) => {
    ipcRenderer.on('recording-stopped', () => callback());
  },
  onCancelRecordingDirect: (callback) => {
    ipcRenderer.on('cancel-recording-direct', () => callback());
  }, // Neuer Event
  onTranscriptionStarted: (callback) => {
    ipcRenderer.on('transcription-started', () => callback());
  },
  onTranscriptionCompleted: (callback) => {
    ipcRenderer.on('transcription-completed', (_, data) => callback(data));
  },
  onRecordingError: (callback) => {
    ipcRenderer.on('recording-error', (_, data) => callback(data));
  },
  onTranscriptionError: (callback) => {
    ipcRenderer.on('transcription-error', (_, data) => callback(data));
  },
  onTextInserted: (callback) => {
    ipcRenderer.on('text-inserted', (_, data) => callback(data || {}));
  }
});