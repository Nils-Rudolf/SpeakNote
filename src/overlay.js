// DOM-Elemente
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const toggleRecordingButton = document.getElementById('toggleRecording');
const closeButton = document.getElementById('closeButton');
const errorMessage = document.getElementById('errorMessage');
const audioVisualizer = document.getElementById('audioVisualizer');

// Visualisierungs-Kontext
const ctx = audioVisualizer.getContext('2d');
let recording = false;
let recordingStartTime = 0;
let timerInterval = null;
let animationFrame = null;

// Statische vertikale Waveform-Balken - wie im Bild
function generateWaveformBars(count) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    // Abwechselnde Höhen für die Balken, ähnlich wie im Screenshot
    let height;
    
    // Erzeuge ein Muster mit verschiedenen Höhen
    if (i % 12 === 0 || i % 12 === 7) {
      height = 0.95; // Hohe Balken
    } else if (i % 8 === 0 || i % 7 === 0) {
      height = 0.8; // Mittlere Balken
    } else if (i % 3 === 0) {
      height = 0.6; // Kleinere Balken
    } else if (i % 2 === 0) {
      height = 0.4; // Noch kleinere Balken
    } else {
      height = 0.2; // Kleinste Balken
    }
    
    bars.push(height);
  }
  return bars;
}

const waveformBars = generateWaveformBars(50);

// Initialisieren des Visualizers
function initVisualizer() {
  // Canvas-Größe setzen
  function resizeCanvas() {
    const container = audioVisualizer.parentElement;
    audioVisualizer.width = container.clientWidth;
    audioVisualizer.height = container.clientHeight;
  }
  
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // Initial zeichnen
  drawWaveform();
}

// Wellenform zeichnen (vertikale Balken im Stil des Screenshots)
function drawWaveform() {
  const width = audioVisualizer.width;
  const height = audioVisualizer.height;
  
  // Hintergrund löschen
  ctx.clearRect(0, 0, width, height);
  
  const barCount = waveformBars.length;
  const barWidth = 1; // Schmale Balken wie im Bild
  const spacing = 2; // Abstand zwischen Balken
  
  const totalBarWidth = barWidth + spacing;
  const startX = (width - (barCount * totalBarWidth)) / 2;
  
  // Stil für die Balken
  ctx.fillStyle = '#000'; // Schwarze Balken wie im Bild
  
  // Zeichne die vertikalen Balken
  for (let i = 0; i < barCount; i++) {
    const x = startX + (i * totalBarWidth);
    const barHeight = waveformBars[i] * height;
    const y = (height - barHeight) / 2;
    
    ctx.fillRect(x, y, barWidth, barHeight);
  }
}

// Aktualisiere Timer
function updateTimer() {
  if (!recording) return;
  
  const elapsedTime = Date.now() - recordingStartTime;
  const seconds = Math.floor(elapsedTime / 1000) % 60;
  const minutes = Math.floor(elapsedTime / 60000);
  
  timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Aufnahme starten
function startRecording() {
  recording = true;
  recordingStartTime = Date.now();
  
  // UI aktualisieren
  statusText.textContent = 'Aufnahme läuft...';
  toggleRecordingButton.classList.add('recording');
  
  // Timer starten
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer(); // Sofort aktualisieren
  
  // Fehler zurücksetzen
  hideError();
}

// Aufnahme stoppen
function stopRecording() {
  recording = false;
  
  // UI aktualisieren
  statusText.textContent = 'Transkribiere...';
  toggleRecordingButton.classList.remove('recording');
  
  // Timer stoppen
  clearInterval(timerInterval);
}

// Aufnahme wechseln
async function toggleRecording() {
  try {
    const result = await window.electronAPI.toggleRecording();
    
    if (result.recording) {
      startRecording();
    } else {
      stopRecording();
    }
  } catch (error) {
    showError('Fehler beim Starten/Stoppen der Aufnahme');
    console.error('Fehler beim Steuern der Aufnahme:', error);
  }
}

// Fehlermeldung anzeigen
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('visible');
}

// Fehlermeldung ausblenden
function hideError() {
  errorMessage.classList.remove('visible');
}

// Event-Listener
toggleRecordingButton.addEventListener('click', toggleRecording);
closeButton.addEventListener('click', () => {
  if (recording) {
    toggleRecording(); // Erst Aufnahme stoppen
  }
  window.close();
});

// Event-Listener für Aufnahme-Events
window.electronAPI.onRecordingStarted(() => {
  startRecording();
});

window.electronAPI.onRecordingStopped(() => {
  stopRecording();
});

window.electronAPI.onTranscriptionStarted(() => {
  statusText.textContent = 'Transkribiere...';
});

window.electronAPI.onTranscriptionCompleted((data) => {
  statusText.textContent = 'Transkription abgeschlossen';
  setTimeout(() => {
    statusText.textContent = 'Bereit';
  }, 1500);
});

window.electronAPI.onRecordingError((data) => {
  stopRecording();
  showError(data.message || 'Aufnahmefehler');
});

window.electronAPI.onTranscriptionError((data) => {
  statusText.textContent = 'Bereit';
  showError(data.message || 'Transkriptionsfehler');
});

// Visualisierung initialisieren
initVisualizer();