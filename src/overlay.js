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

// Neue Flags für besseres State-Management
let isUIFrozen = false; // Erkennt, ob die UI eingefroren ist
let isRecoveryMode = false; // Flag für den Wiederherstellungsmodus
let lastCancelTime = 0; // Zeitpunkt des letzten Abbruchs

// Audio-Analyse-Variablen
let audioContext = null;
let analyser = null;
let microphone = null;
let dataArray = null;
let bufferLength = 0;
let audioStream = null; // Neue Variable zum Speichern des Medienstreams

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
    audioStream = stream; // Speichere den Stream für späteres Stoppen
    
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

// Audio-Analyse stoppen - mit zusätzlichem Force-Option für Notfall-Reset
async function stopAudioAnalysis(force = false) {
  // Wenn force aktiviert ist, setzen wir alle Flags zurück
  if (force) {
    isUIFrozen = false;
    isRecoveryMode = false;
  }
  
  try {
    // Sofort die Animation beenden
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    
    // Sofort alle Timer beenden
    stopVisualizationTimer();
    
    if (microphone) {
      try {
        microphone.disconnect();
      } catch (e) {
        console.log('Fehler beim Trennen des Mikrofons:', e);
      }
      microphone = null;
    }
    
    // Sofort alle Tracks im MediaStream beenden
    if (audioStream) {
      try {
        const tracks = audioStream.getTracks();
        for (const track of tracks) {
          track.stop();
        }
      } catch (e) {
        console.log('Fehler beim Stoppen der Audio-Tracks:', e);
      }
      audioStream = null;
    }
    
    // Audio-Kontext mit höherer Priorität schließen
    if (audioContext) {
      try {
        // Im Force-Modus, schließen wir ohne auf Promises zu warten
        if (force) {
          try {
            audioContext.close();
          } catch (e) {}
          audioContext = null;
        } else {
          // Normale Methode mit Promise
          await audioContext.close().catch(e => console.error('Audio-Kontext-Fehler:', e));
          audioContext = null;
        }
      } catch (error) {
        console.error('Fehler beim Schließen des Audio-Kontexts:', error);
        audioContext = null;
      }
    }
    
    analyser = null;
    dataArray = null;
    
    // Sofort die Visualisierung zurücksetzen
    visualizationHistory.length = 0;
    drawStaticWaveform();
  } catch (e) {
    console.error('Fehler beim Stoppen der Audio-Analyse:', e);
    // Bei Fehler im Force-Modus alle Referenzen hart zurücksetzen
    if (force) {
      microphone = null;
      audioStream = null;
      audioContext = null;
      analyser = null;
      dataArray = null;
      animationFrame = null;
      visualizationHistory.length = 0;
      drawStaticWaveform();
    }
  }
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
  // Überprüfen, ob wir uns gerade im Recovery-Modus befinden oder ob Zeit seit letztem Abbruch zu kurz ist
  const timeSinceLastCancel = Date.now() - lastCancelTime;
  const needsCooldown = timeSinceLastCancel < 800;
  
  if (isRecoveryMode || needsCooldown) {
    console.log('Starte nicht sofort nach Abbruch - Cool-down aktiv');
    // Kurze Verzögerung einfügen, damit die Audio-Ressourcen freigegeben werden können
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Vor dem Neustart sicherstellen, dass alle Audio-Ressourcen wirklich freigegeben wurden
    await stopAudioAnalysis(true);
  }
  
  // Jetzt erst alle Status-Flags setzen
  recording = true;
  isUIFrozen = false;
  recordingStartTime = Date.now();
  
  // UI aktualisieren
  statusText.textContent = 'Recording';
  toggleRecordingButton.classList.add('recording');
  
  try {
    // Audio-Visualisierung starten - mit Fehlerbehandlung
    const visualizationSuccess = await setupAudioVisualization();
    if (!visualizationSuccess) {
      console.error('Audio-Visualisierung konnte nicht initialisiert werden');
      // Trotzdem weitermachen, aber Flag setzen, dass wir Probleme haben könnten
      isUIFrozen = true;
    }
    
    // Timer starten
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer(); // Sofort aktualisieren
    
    // Fehler zurücksetzen
    hideError();
  } catch (error) {
    console.error('Fehler beim Starten der Aufnahme (UI):', error);
    // Zur Sicherheit in einen "gefrorenen" Zustand übergehen, damit der Notfall-Reset funktioniert
    isUIFrozen = true;
  }
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

// Abbrechen-Button stoppt die Aufnahme, aber schließt das Fenster NICHT
closeButton.addEventListener('click', async () => {
  console.log('[DEBUG] Abbrechen-Button geklickt');
  
  try {
    // Status sofort ändern und UI aktualisieren
    recording = false;
    statusText.textContent = 'Abgebrochen';
    console.log('[DEBUG] Status auf "Abgebrochen" gesetzt');
    
    // Sofort Timer und Visualisierung stoppen
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      console.log('[DEBUG] Timer gestoppt');
    }
    
    // Alle Timer und Animationen stoppen
    stopVisualizationTimer();
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      console.log('[DEBUG] Animationen gestoppt');
    }
    
    // Audio-Analyse komplett beenden
    if (audioStream) {
      try {
        const tracks = audioStream.getTracks();
        tracks.forEach(track => track.stop());
        console.log('[DEBUG] Audio-Tracks gestoppt: ' + tracks.length);
      } catch (e) {
        console.error('[DEBUG] Fehler beim Stoppen der Audio-Tracks:', e);
      }
      audioStream = null;
    }
    
    if (audioContext) {
      try {
        await audioContext.close();
        console.log('[DEBUG] AudioContext geschlossen');
      } catch (e) {
        console.error('[DEBUG] Fehler beim Schließen des AudioContext:', e);
      }
      audioContext = null;
    }
    
    microphone = null;
    analyser = null;
    
    // UI zurücksetzen
    drawStaticWaveform();
    toggleRecordingButton.classList.remove('recording');
    timer.textContent = '0:00';
    
    // Den Abbruch an den Hauptprozess senden
    console.log('[DEBUG] Sende cancelRecording an Hauptprozess');
    const result = await window.electronAPI.cancelRecording();
    console.log('[DEBUG] Ergebnis von cancelRecording:', result);
    
    // Nach kurzer Zeit UI zurücksetzen, aber Fenster NICHT schließen
    setTimeout(() => {
      resetUI();
      console.log('[DEBUG] UI zurückgesetzt nach Abbruch');
    }, 1000);
  } catch (error) {
    console.error('[DEBUG] Fehler beim Abbrechen:', error);
    // Trotz Fehler UI zurücksetzen
    resetUI();
  }
});

// Apple-Style X-Button schließt das Fenster
closeWindowButton.addEventListener('click', async () => {
  // Aufnahme stoppen, falls aktiv
  if (recording) {
    try {
      // UI sofort aktualisieren
      recording = false;
      statusText.textContent = 'Beendet';
      
      // Alle Audio-Ressourcen sofort freigeben
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      
      stopVisualizationTimer();
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      
      // Audio-Stream stoppen
      if (audioStream) {
        const tracks = audioStream.getTracks();
        tracks.forEach(track => track.stop());
        audioStream = null;
      }
      
      if (audioContext) {
        try {
          await audioContext.close();
        } catch (e) {}
        audioContext = null;
      }
      
      microphone = null;
      analyser = null;
      
      // Erst jetzt den Hauptprozess benachrichtigen
      await window.electronAPI.cancelRecording();
      
      // Direkt schließen
      window.electronAPI.closeOverlay();
    } catch (error) {
      console.error('Fehler beim Schließen mit X:', error);
      // Im Fehlerfall trotzdem schließen
      window.electronAPI.closeOverlay();
    }
  } else {
    // Wenn keine Aufnahme läuft, einfach schließen
    window.electronAPI.closeOverlay();
  }
});

// ESC-Taste zum Schließen des Fensters
document.addEventListener('keydown', (event) => {
  console.log('Taste gedrückt:', event.key); // Debug-Log hinzugefügt
  if (event.key === 'Escape') {
    console.log('ESC wurde gedrückt! Versuche Fenster zu schließen...'); // Debug-Log
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
  console.log('[DEBUG] cancel-recording-direct Event empfangen');
  
  // Sofortige Maßnahmen zur Fehlerbehebung
  try {
    // Status sofort hart zurücksetzen
    recording = false;
    
    // Timer hart stoppen
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      console.log('[DEBUG] Timer im cancel-direct gestoppt');
    }
    
    // Animation sofort beenden
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      console.log('[DEBUG] Animation im cancel-direct gestoppt');
    }
    
    // Visualisierungstimer sofort stoppen
    stopVisualizationTimer();
    console.log('[DEBUG] Visualisierungstimer im cancel-direct gestoppt');
    
    // Audiostream direkt beenden
    if (audioStream) {
      const tracks = audioStream.getTracks();
      tracks.forEach(track => {
        try {
          track.stop();
          console.log('[DEBUG] Audiotrack im cancel-direct gestoppt');
        } catch (e) {
          console.error('[DEBUG] Fehler beim Stoppen des Audiotracks:', e);
        }
      });
      audioStream = null;
    }
    
    // Audio-Kontext direkt schließen, ohne auf Promise zu warten
    if (audioContext) {
      try {
        audioContext.close();
        console.log('[DEBUG] AudioContext im cancel-direct geschlossen');
      } catch (e) {
        console.error('[DEBUG] Fehler beim Schließen des AudioContext:', e);
      }
      audioContext = null;
    }
    
    // Andere Audio-Referenzen löschen
    microphone = null;
    analyser = null;
    dataArray = null;
    
    // Visualisierungsverlauf löschen
    visualizationHistory.length = 0;
    
    // Statisches Muster neu zeichnen
    drawStaticWaveform();
    
    // UI-Status aktualisieren
    statusText.textContent = 'Start Recording';
    toggleRecordingButton.classList.remove('recording');
    timer.textContent = '0:00';
    
    console.log('[DEBUG] UI im cancel-direct vollständig zurückgesetzt');
    
    // Nach kurzer Verzögerung UI vollständig zurücksetzen
    setTimeout(() => {
      resetUI();
      console.log('[DEBUG] resetUI nach cancel-direct aufgerufen');
    }, 500);
  } catch (error) {
    console.error('[DEBUG] Fehler im cancel-direct Handler:', error);
    // Trotz Fehler UI zurücksetzen
    resetUI();
  }
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