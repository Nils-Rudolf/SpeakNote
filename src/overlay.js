// DOM-Elemente
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const toggleRecordingButton = document.getElementById('toggleRecording');
const closeButton = document.getElementById('closeButton');
const closeWindowButton = document.getElementById('closeWindowButton');
const errorMessage = document.getElementById('errorMessage');
const audioVisualizer = document.getElementById('audioVisualizer');

// Visualisierungs-Kontext
const ctx = audioVisualizer.getContext('2d');
let recording = false;
let recordingStartTime = 0;
let timerInterval = null;
let animationFrame = null;

// Audio-Analyse-Variablen
let audioContext = null;
let analyser = null;
let microphone = null;
let dataArray = null;
let bufferLength = 0;

// Visualisierungs-Variablen
const visualizationHistory = [];
const maxVisualBars = 60; // Wie viele Balken sollen maximal angezeigt werden
const visualizationRate = 100; // 10 Balken pro Sekunde (100ms Intervall)
let visualizationInterval = null;

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
  
  // Initial zeichnen (statisches Muster für den Anfang)
  drawStaticWaveform();
}

// Statische Wellenform zeichnen (wird nur angezeigt, wenn keine Aufnahme läuft)
function drawStaticWaveform() {
  const width = audioVisualizer.width;
  const height = audioVisualizer.height;
  
  // Hintergrund löschen
  ctx.clearRect(0, 0, width, height);
  
  // Statt einer einzelnen Linie zeichnen wir feine, schwach sichtbare vertikale Linien
  // als Platzhalter für die aktive Visualisierung
  const barCount = maxVisualBars;
  const barWidth = 1;
  const spacing = Math.floor((width - (barCount * barWidth)) / (barCount - 1));
  const totalBarWidth = barWidth + spacing;
  
  // Stil für die statischen Linien
  ctx.fillStyle = '#cccccc'; // Hellgrauer Farbton für die inaktiven Linien
  
  // Zeichne die vertikalen Linien über die gesamte Breite
  for (let i = 0; i < barCount; i++) {
    const x = i * totalBarWidth;
    const barHeight = height * 0.2; // 20% der Höhe
    const y = (height - barHeight) / 2; // Zentriert
    
    ctx.fillRect(x, y, barWidth, barHeight);
  }
}

// Echte Audio-Visualisierung mit Web Audio API
async function setupAudioVisualization() {
  try {
    // Falls bereits initialisiert, zurücksetzen
    if (audioContext) {
      await stopAudioAnalysis();
    }
    
    // Audio-Kontext erstellen
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    
    // FFT-Größe für die Frequenzanalyse einstellen
    analyser.fftSize = 256;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    // Mikrofon-Stream anfordern
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Mikrofon mit Audio-Kontext verbinden
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    
    // Animation starten
    drawVisualization();
    
    // Starte regelmäßige Aktualisierung der Audiodaten
    startVisualizationTimer();
    
    return true;
  } catch (error) {
    console.error('Audio-Visualisierung konnte nicht initialisiert werden:', error);
    showError('Mikrofon-Zugriff verweigert oder nicht verfügbar');
    return false;
  }
}

// Audio-Analyse stoppen
async function stopAudioAnalysis() {
  if (!audioContext) return;
  
  cancelAnimationFrame(animationFrame);
  
  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }
  
  if (audioContext.state !== 'closed') {
    await audioContext.close();
  }
  
  audioContext = null;
  analyser = null;
  dataArray = null;
  
  // Statisches Muster anzeigen
  drawStaticWaveform();
  
  // Stoppe die regelmäßige Aktualisierung
  stopVisualizationTimer();
}

// Animationsfunktion für die Mikrofon-Visualisierung
function animateMicrophone() {
  if (!analyser || !recording) return;
  
  animationFrame = requestAnimationFrame(animateMicrophone);
  
  // Frequenzdaten abrufen
  analyser.getByteFrequencyData(dataArray);
  
  // Durchschnittliche Amplitude berechnen (vereinfacht)
  let sum = 0;
  const sampleSize = Math.min(bufferLength, 32); // Wir verwenden nur einen Teil des Spektrums
  for (let i = 0; i < sampleSize; i++) {
    sum += dataArray[i];
  }
  const averageAmplitude = sum / sampleSize / 255; // Normalisieren auf 0-1
  
  drawVisualization();
}

// Die Visualisierung der Audioamplitude zeichnen
function drawVisualization() {
  const width = audioVisualizer.width;
  const height = audioVisualizer.height;
  
  // Hintergrund löschen
  ctx.clearRect(0, 0, width, height);
  
  // Parameter für die visuelle Darstellung
  const barWidth = 2;
  const spacing = 3;
  const totalBarWidth = barWidth + spacing;
  const startX = 0;
  
  // Zeichne die vertikalen Balken von rechts nach links
  ctx.fillStyle = '#000000'; // Schwarze Balken
  
  for (let i = 0; i < visualizationHistory.length; i++) {
    // Jeder Balken ist eine vertikale Linie, deren Höhe der 
    // aufgenommenen Amplitude zu diesem Zeitpunkt entspricht
    const barHeight = visualizationHistory[i] * height * 0.8; // 80% der maximalen Höhe
    
    // X-Position: von rechts nach links
    const x = startX + i * totalBarWidth;
    
    // Y-Position: zentriert vertikal
    const y = (height - barHeight) / 2;
    
    // Zeichne den Balken
    ctx.fillRect(x, y, barWidth, barHeight);
  }
  
  // Fülle den restlichen Raum mit den statischen Linien
  if (visualizationHistory.length < maxVisualBars) {
    const remainingBars = maxVisualBars - visualizationHistory.length;
    const offsetX = visualizationHistory.length * totalBarWidth;
    
    ctx.fillStyle = '#cccccc'; // Hellgrau für statische Balken
    
    for (let i = 0; i < remainingBars; i++) {
      const x = offsetX + i * totalBarWidth;
      const barHeight = height * 0.2; // 20% Höhe für statische Balken
      const y = (height - barHeight) / 2;
      
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }
  
  // Animation fortsetzen
  if (recording) {
    animationFrame = requestAnimationFrame(drawVisualization);
  }
}

// Starte regelmäßige Aktualisierung der Audiodaten
function startVisualizationTimer() {
  // Verlauf zurücksetzen und vorherige Timer stoppen
  visualizationHistory.length = 0;
  
  // Sicherstellen, dass kein vorheriger Timer noch läuft
  stopVisualizationTimer();
  
  // Regelmäßig Audioamplitude erfassen (10 Mal pro Sekunde)
  visualizationInterval = setInterval(() => {
    if (!analyser || !recording) return;
    
    // Frequenzdaten abrufen
    analyser.getByteFrequencyData(dataArray);
    
    // Durchschnittliche Amplitude berechnen
    let sum = 0;
    const sampleSize = Math.min(bufferLength, 32);
    for (let i = 0; i < sampleSize; i++) {
      sum += dataArray[i];
    }
    const averageAmplitude = sum / sampleSize / 255;
    
    // Neue Amplitude zum Verlauf hinzufügen (von rechts)
    visualizationHistory.unshift(averageAmplitude);
    if (visualizationHistory.length > maxVisualBars) {
      visualizationHistory.pop();
    }
  }, visualizationRate); // 100ms = 10 Updates pro Sekunde
}

// Stoppe die regelmäßige Aktualisierung
function stopVisualizationTimer() {
  if (visualizationInterval) {
    clearInterval(visualizationInterval);
    visualizationInterval = null;
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
async function startRecording() {
  recording = true;
  recordingStartTime = Date.now();
  
  // UI aktualisieren
  statusText.textContent = 'Recording';
  toggleRecordingButton.classList.add('recording');
  
  // Audio-Visualisierung starten
  await setupAudioVisualization();
  
  // Timer starten
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer(); // Sofort aktualisieren
  
  // Fehler zurücksetzen
  hideError();
}

// Aufnahme stoppen
async function stopRecording() {
  recording = false;
  
  // UI aktualisieren
  statusText.textContent = 'Transcribing';
  toggleRecordingButton.classList.remove('recording');
  
  // Timer stoppen
  clearInterval(timerInterval);
  
  // Audio-Analyse stoppen
  await stopAudioAnalysis();
}

// Zurücksetzen aller UI-Elemente in den Ausgangszustand
function resetUI() {
  // Timer zurücksetzen
  timer.textContent = '0:00';
  
  // Status zurücksetzen
  statusText.textContent = 'Start Recording';
  
  // Aufnahme-Status zurücksetzen
  recording = false;
  toggleRecordingButton.classList.remove('recording');
  
  // Fehler ausblenden
  hideError();
  
  // Statische Wellenform zeichnen
  drawStaticWaveform();
}

// Fenster schließen
function closeWindow() {
  window.electronAPI.closeOverlay();
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
    showError('Error starting/stopping recording');
    console.error('Error controlling recording:', error);
  }
}

// Fehlermeldung anzeigen
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('visible');
  statusText.style.opacity = '0'; // Status-Text ausblenden, wenn Fehler angezeigt wird
}

// Fehlermeldung ausblenden
function hideError() {
  errorMessage.classList.remove('visible');
  statusText.style.opacity = '1'; // Status-Text wieder einblenden
}

// Event-Listener
toggleRecordingButton.addEventListener('click', toggleRecording);

// Abbrechen-Button stoppt die Aufnahme, aber schließt das Fenster nicht
closeButton.addEventListener('click', async () => {
  if (recording) {
    try {
      // Vor dem Senden des Cancel-Befehls direkt UI aktualisieren
      statusText.textContent = 'Start Recording';
      
      // Timer sofort stoppen
      clearInterval(timerInterval);
      timerInterval = null;
      
      // Aufnahme-Status sofort zurücksetzen
      recording = false;
      toggleRecordingButton.classList.remove('recording');
      
      // Audio-Analyse sofort stoppen
      await stopAudioAnalysis();
      
      // Über IPC an den Hauptprozess senden, dass Aufnahme abgebrochen wurde
      await window.electronAPI.cancelRecording();
      
      // Timer sofort zurücksetzen (nicht warten)
      timer.textContent = '0:00';
      
      // Nach kurzer Zeit den Status zurücksetzen
      setTimeout(() => {
        resetUI();
      }, 2000);
    } catch (error) {
      console.error('Fehler beim Abbrechen der Aufnahme:', error);
      showError('Failed to cancel recording');
    }
  } else {
    // Wenn keine Aufnahme läuft, sofort in den Ausgangszustand zurückkehren
    resetUI();
  }
});

// Apple-Style X-Button schließt das Fenster
closeWindowButton.addEventListener('click', () => {
  // Aufnahme stoppen, falls aktiv
  if (recording) {
    window.electronAPI.cancelRecording().then(() => {
      closeWindow();
    }).catch(error => {
      console.error('Fehler beim Beenden der Aufnahme:', error);
      closeWindow();
    });
  } else {
    closeWindow();
  }
});

// ESC-Taste zum Schließen des Fensters
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Aufnahme stoppen, falls aktiv
    if (recording) {
      window.electronAPI.cancelRecording().then(() => {
        closeWindow();
      }).catch(error => {
        console.error('Fehler beim Beenden der Aufnahme:', error);
        closeWindow();
      });
    } else {
      closeWindow();
    }
  }
});

// Event-Listener für Aufnahme-Events
window.electronAPI.onRecordingStarted(() => {
  startRecording();
});

window.electronAPI.onRecordingStopped(() => {
  stopRecording();
});

window.electronAPI.onCancelRecordingDirect(() => {
  // Direkter Abbruch der Aufnahme ohne Übergang zu "Transcribing"
  recording = false;
  statusText.textContent = 'Start Recording';
  
  // Timer und Aufnahme sofort stoppen
  clearInterval(timerInterval);
  timerInterval = null;
  toggleRecordingButton.classList.remove('recording');
  
  // Audio-Analyse stoppen (ohne await, da wir keinen Status-Wechsel wollen)
  stopAudioAnalysis();
  
  // Timer zurücksetzen
  timer.textContent = '0:00';
  
  // Nach kurzer Verzögerung UI zurücksetzen
  setTimeout(() => {
    resetUI();
  }, 2000);
});

window.electronAPI.onTranscriptionStarted(() => {
  statusText.textContent = 'Transcribing';
});

window.electronAPI.onTranscriptionCompleted(() => {
  statusText.textContent = 'Complete';
  
  // Status nach kurzer Zeit zurücksetzen
  setTimeout(() => {
    resetUI();
  }, 2000);
});

window.electronAPI.onRecordingError((data) => {
  stopRecording();
  showError(data.message || 'Recording error');
  
  // Nach kurzer Zeit in den Ausgangszustand zurückkehren
  setTimeout(() => {
    resetUI();
  }, 3000);
});

window.electronAPI.onTranscriptionError((data) => {
  statusText.textContent = '';
  showError(data.message || 'Transcription error');
  
  // Nach kurzer Zeit in den Ausgangszustand zurückkehren
  setTimeout(() => {
    resetUI();
  }, 3000);
});

// Text-Einfügung
window.electronAPI.onTextInserted(() => {
  statusText.textContent = 'Text inserted';
  
  // Status nach kurzer Zeit zurücksetzen
  setTimeout(() => {
    resetUI();
  }, 2000);
});

// Visualisierung initialisieren
initVisualizer();

// Initialen Timer-Wert setzen und Status anzeigen
resetUI();