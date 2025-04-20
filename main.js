const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const Store = require('electron-store');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const { promisify } = require('util');
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);

// Konfigurationsspeicher initialisieren
const store = new Store();

// Globale Variablen
let mainWindow;
let overlayWindow;
let tray = null;
let recording = false;
let recordingStartTime = 0; // Speichert den Zeitpunkt, wann die Aufnahme gestartet wurde
let recordingProcess;
let recordingFilePath;
let isQuitting = false;
let lastActiveApp = null; // Speichert die zuletzt aktive Anwendung

// Stelle sicher, dass die App nur einmal läuft
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

// App soll NICHT im Dock erscheinen
if (process.platform === 'darwin') {
  app.dock.hide();
  app.setActivationPolicy('accessory'); // Wichtig für macOS-Menüleisten-Apps
}

// Hauptfenster erstellen (Einstellungsfenster)
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/transbuddy_logo.png'),
    show: false, // Initial versteckt, wird über Tray oder Dock geöffnet
    skipTaskbar: true, // Nicht in der Taskleiste anzeigen
  });

  mainWindow.loadFile('src/settings.html');

  // Hauptfenster verstecken statt schließen, wenn Benutzer es schließt
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  mainWindow.on('ready-to-show', () => {
    // Sende gespeicherte Einstellungen an das Renderer-Fenster
    const apiKey = store.get('elevenlabsApiKey', '');
    const apiType = store.get('apiType', 'elevenlabs');
    const audioDevice = store.get('audioDevice', '');
    
    mainWindow.webContents.send('settings-loaded', {
      apiKey,
      apiType,
      audioDevice
    });
  });
}

// Overlay-Fenster erstellen (Aufnahme-UI)
function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  overlayWindow = new BrowserWindow({
    width: 500,
    height: 100,
    x: Math.floor((width - 500) / 2),
    y: Math.floor(height / 4),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: true, // Auf true gesetzt, damit Tastatur-Events (insbesondere ESC) funktionieren
    skipTaskbar: true,
    show: false, // Initial versteckt
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.loadFile('src/overlay.html');
  
  // Fenster kann geschlossen werden
  overlayWindow.on('close', (event) => {
    if (recording) {
      stopRecording();
    }
  });
}

// Tray-Icon erstellen
function createTray() {
  try {
    // Pfad zum Tray-Icon
    const iconPath = path.join(__dirname, 'assets/transbuddy_logo_menu.png');
    
    // Prüfen, ob die Datei existiert
    if (!fs.existsSync(iconPath)) {
      console.error(`Tray-Icon nicht gefunden: ${iconPath}`);
      // Fallback zu einem Standardsymbol
      tray = new Tray(path.join(__dirname, 'assets/transbuddy_logo.png'));
    } else {
      // Template-Image für dunkles/helles Erscheinungsbild in macOS
      tray = new Tray(iconPath);
    }
    
    // Tooltip setzen
    tray.setToolTip('TransBuddy');
    
    // Kontextmenü erstellen
    const contextMenu = Menu.buildFromTemplate([
      { 
        label: 'Transkription starten/stoppen', 
        click: () => { 
          if (recording) {
            stopRecording();
          } else {
            startRecording();
          }
        } 
      },
      { type: 'separator' },
      { label: 'Einstellungen', click: () => { mainWindow.show(); } },
      { type: 'separator' },
      { label: 'Beenden', click: () => { isQuitting = true; app.quit(); } }
    ]);
    
    // Kontextmenü setzen
    tray.setContextMenu(contextMenu);
    
    // Doppelklick auf Tray-Icon öffnet Einstellungen
    tray.on('double-click', () => {
      mainWindow.show();
    });
    
    console.log('Tray erfolgreich erstellt');
  } catch (error) {
    console.error('Fehler beim Erstellen des Tray-Icons:', error);
  }
}

// Verfügbare Audio-Eingabegeräte abrufen
async function getAudioDevices() {
  return new Promise((resolve, reject) => {
    exec('system_profiler SPAudioDataType | grep "Input"', (error, stdout, stderr) => {
      if (error) {
        console.error('Fehler beim Abrufen der Audiogeräte:', error);
        reject(error);
        return;
      }
      
      // Einfache Parsing-Logik für macOS Audio-Geräte
      const lines = stdout.trim().split('\n');
      const devices = lines.map(line => line.trim().replace('Input: ', '')).filter(device => device);
      
      resolve(devices);
    });
  });
}

// Aktive Anwendung vor dem Öffnen des Overlays erfassen
async function captureActiveApplication() {
  return new Promise((resolve) => {
    // Verbesserte AppleScript-Version, die versucht, die richtige aktive App zu erkennen und nicht Electron/TransBuddy selbst
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        
        if frontApp is "Electron" or frontApp contains "TransBuddy" then
          # Wir haben unsere eigene App erkannt, versuche eine andere aktive App zu finden
          tell application "System Events"
            set allVisibleProcesses to name of every process whose visible is true
          end tell
          
          # Filtere Electron/TransBuddy aus der Liste
          set filteredApps to {}
          repeat with appName in allVisibleProcesses
            if appName is not "Electron" and appName does not contain "TransBuddy" and appName is not "Finder" then
              set end of filteredApps to appName
            end if
          end repeat
          
          # Falls andere Apps gefunden wurden, nimm die erste
          if length of filteredApps > 0 then
            return first item of filteredApps
          else
            # Fallback zu TextEdit, wenn nichts Besseres gefunden wurde
            return "TextEdit"
          end if
        else
          # Eine andere App ist bereits aktiv - nutze diese
          return frontApp
        end if
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error('Fehler beim Ermitteln der aktiven Anwendung:', error);
        // Fallback zu TextEdit, falls nichts gefunden wurde
        lastActiveApp = "TextEdit";
        
        // Öffne TextEdit, falls es nicht bereits läuft
        exec('open -a TextEdit', (openError) => {
          if (openError) {
            console.error('Fehler beim Öffnen von TextEdit:', openError);
          }
          resolve(lastActiveApp);
        });
      } else {
        lastActiveApp = stdout.trim();
        
        // Falls die erkannte App Electron oder leer ist, verwende TextEdit als Fallback
        if (lastActiveApp === "Electron" || lastActiveApp.includes("TransBuddy") || !lastActiveApp) {
          lastActiveApp = "TextEdit";
          
          // Öffne TextEdit, falls es nicht bereits läuft
          exec('open -a TextEdit', (openError) => {
            if (openError) {
              console.error('Fehler beim Öffnen von TextEdit:', openError);
            }
            resolve(lastActiveApp);
          });
        } else {
          resolve(lastActiveApp);
        }
      }
    });
  });
}

// Aufnahme starten
async function startRecording() {
  // Wenn bereits eine Aufnahme läuft, diese zuerst beenden
  if (recording) {
    await stopRecording();
    // Kurze Pause, um sicherzustellen, dass alle Ressourcen freigegeben sind
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Stellen wir sicher, dass kein sox-Prozess läuft
  if (process.platform === 'darwin') {
    exec('killall sox 2>/dev/null || true', () => {
      // Ignoriere Fehler, falls kein sox-Prozess läuft
    });
  }
  
  // Aktive Anwendung erfassen, bevor das Overlay geöffnet wird
  await captureActiveApplication();
  
  // Prüfen, ob ein API-Key konfiguriert ist
  const apiKey = store.get('elevenlabsApiKey', '');
  if (!apiKey) {
    // Kein API-Key, Fehler anzeigen und Einstellungen öffnen
    createOverlayWindow();
    overlayWindow.webContents.send('recording-error', { 
      message: 'API-Schlüssel fehlt. Bitte in den Einstellungen konfigurieren.' 
    });
    overlayWindow.show();
    
    // Nach kurzer Verzögerung die Einstellungen öffnen
    setTimeout(() => {
      mainWindow.show();
      overlayWindow.hide();
    }, 2000);
    
    return;
  }
  
  const selectedDevice = store.get('audioDevice', '');
  recordingFilePath = path.join(app.getPath('temp'), `transbuddy_recording_${Date.now()}.wav`);
  
  // Stellen wir sicher, dass keine alte Audiodatei existiert
  try {
    if (fs.existsSync(recordingFilePath)) {
      await unlinkAsync(recordingFilePath);
    }
  } catch (error) {
    console.log('Alte Aufnahmedatei konnte nicht gelöscht werden:', error);
    // Nicht kritisch, weitermachen
  }
  
  recording = true;
  recordingStartTime = Date.now(); // Aufnahmebeginn speichern für Mindestaufnahmezeit
  
  // Audio-Aufnahme mit ausgewähltem Gerät starten
  let recordCmd;
  if (selectedDevice && selectedDevice.trim() !== '') {
    // Mit spezifischem Gerät
    recordCmd = `sox -d -r 44100 -c 1 "${recordingFilePath}" trim 0 silence 1 0.1 1%`;
  } else {
    // Mit Standard-Gerät
    recordCmd = `sox -d -r 44100 -c 1 "${recordingFilePath}"`;
  }
  
  try {
    recordingProcess = exec(recordCmd, (error) => {
      if (error && !error.killed) {
        console.error('Fehler bei der Aufnahme:', error);
        recording = false;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('recording-error', { message: `Fehler bei der Aufnahme: ${error.message}` });
        }
      }
    });
    
    // UI aktualisieren
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('recording-started');
      overlayWindow.show();
    } else {
      // Falls das Overlay-Fenster nicht existiert, neu erstellen
      createOverlayWindow();
      setTimeout(() => {
        overlayWindow.webContents.send('recording-started');
        overlayWindow.show();
      }, 100);
    }
  } catch (error) {
    console.error('Fehler beim Starten der Aufnahme:', error);
    recording = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('recording-error', { message: `Fehler beim Starten der Aufnahme: ${error.message}` });
    }
  }
}

// Aufnahme stoppen und transkribieren
async function stopRecording() {
  if (!recording) return;
  
  recording = false;
  
  // Überprüfen der Mindestaufnahmezeit (1000ms = 1 Sekunde)
  const minRecordingTime = 1000; // 1 Sekunde als Minimalwert für die API
  const recordingDuration = Date.now() - recordingStartTime;
  
  // Aufnahmeprozess sicher beenden
  if (recordingProcess) {
    try {
      // Kill-Signal senden und auf Prozessende warten
      recordingProcess.kill('SIGTERM');
      
      // Zusätzlich sicherstellen, dass der Prozess wirklich beendet wird
      if (process.platform === 'darwin') {
        // Auf macOS: Killall sox ausführen, um sicherzustellen, dass der Prozess beendet wird
        exec('killall sox', (error) => {
          if (error && !error.message.includes('No matching processes')) {
            console.error('Fehler beim Beenden des Sox-Prozesses:', error);
          }
        });
      }
      
      // Prozess-Referenz zurücksetzen
      recordingProcess = null;
    } catch (error) {
      console.error('Fehler beim Beenden des Aufnahmeprozesses:', error);
    }
  }
  
  // Sicherstellen, dass das overlayWindow noch existiert
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording-stopped');
    
    // Wenn die Aufnahme zu kurz war, zeigen wir eine Fehlermeldung und brechen ab
    if (recordingDuration < minRecordingTime) {
      console.log(`Aufnahme zu kurz (${recordingDuration}ms). Mindestlänge: ${minRecordingTime}ms`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { 
          message: 'Aufnahme zu kurz. Bitte halte F5 länger gedrückt.'
        });
      }
      
      // Temp-Datei löschen, wenn sie existiert
      try {
        if (recordingFilePath && fs.existsSync(recordingFilePath)) {
          await unlinkAsync(recordingFilePath);
          console.log('Zu kurze Aufnahme-Datei wurde gelöscht.');
        }
      } catch (error) {
        console.error('Fehler beim Löschen der temporären Datei:', error);
      }
      
      return;
    }
    
    try {
      // Transkription starten
      overlayWindow.webContents.send('transcription-started');
      
      const transcribedText = await transcribeAudio(recordingFilePath);
      
      // Transkription erfolgreich - erneut prüfen, ob Window noch existiert
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-completed', { text: transcribedText });
        
        // Text an Cursor einfügen
        await insertTextAtCursor(transcribedText);
        
        try {
          // Temp-Datei löschen, wenn sie existiert
          if (fs.existsSync(recordingFilePath)) {
            await unlinkAsync(recordingFilePath);
          }
        } catch (fileError) {
          console.error('Fehler beim Löschen der temporären Audiodatei:', fileError);
          // Nicht kritisch, weitermachen
        }
        
        // Overlay nach kurzer Verzögerung schließen
        setTimeout(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
          }
        }, 2000);
      }
    } catch (error) {
      console.error('Fehler bei der Transkription:', error);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { message: error.message });
      }
    }
  }
}

// Explizit die Aufnahme abbrechen ohne Transkription
async function cancelRecordingProcess() {
  if (!recording) return { success: true };
  
  console.log('Aufnahme wird explizit abgebrochen...');
  recording = false;
  
  // Aufnahmeprozess schrittweise und sicherer beenden
  if (recordingProcess) {
    try {
      // Zuerst mit SIGTERM versuchen (sanfter)
      recordingProcess.kill('SIGTERM');
      
      // Warten, damit der Prozess eine Chance hat, sauber zu beenden
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Überprüfen, ob der Prozess noch läuft und ggf. härter beenden
      if (recordingProcess) {
        try {
          // SIGINT (Ctrl+C) senden
          recordingProcess.kill('SIGINT');
          
          // Nochmals warten
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          console.log('SIGINT-Signal konnte nicht gesendet werden:', e);
        }
      }
      
      // Auf macOS: SoX-Prozesse eleganter beenden mit geordneten Befehlen
      if (process.platform === 'darwin') {
        // Verwende pkill mit -2 (SIGINT), was ein freundlicherer Befehl ist als -9 (SIGKILL)
        try {
          // Mehrere Befehle nacheinander, um sicherzustellen, dass alle SoX-Prozesse beendet werden
          exec('pkill -2 -f sox', () => {});
          await new Promise(resolve => setTimeout(resolve, 100));
          exec('pkill -2 -f rec', () => {});
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Nur als letzten Ausweg killall verwenden
          exec('killall -2 sox 2>/dev/null || true', () => {});
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
          console.error('Fehler beim sauberen Beenden der SoX-Prozesse:', e);
        }
      } else if (process.platform === 'win32') {
        exec('taskkill /IM sox.exe', () => {}); // Zuerst ohne /F versuchen
        await new Promise(resolve => setTimeout(resolve, 300));
        exec('taskkill /F /IM sox.exe /T', () => {}); // Falls nötig mit /F (force)
      } else {
        exec('pkill -2 -f sox', () => {}); // SIGINT statt SIGKILL
        await new Promise(resolve => setTimeout(resolve, 200));
        exec('pkill -f sox', () => {});
      }
      
      // Aufnahme-Callback benachrichtigen
      recordingProcess = null;
    } catch (error) {
      console.error('Fehler beim Beenden des Aufnahmeprozesses:', error);
    }
  }
  
  // Overlay-Fenster benachrichtigen - direkt mit "Cancelled" statt als recording-stopped
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('cancel-recording-direct');
  }
  
  // Aufnahmedatei löschen, wenn vorhanden
  try {
    if (recordingFilePath && fs.existsSync(recordingFilePath)) {
      await unlinkAsync(recordingFilePath);
      console.log('Temporäre Aufnahmedatei gelöscht.');
    }
  } catch (error) {
    console.error('Fehler beim Löschen der temporären Datei:', error);
  }
  
  return { success: true };
}

// Text an der Cursorposition einfügen (macOS-spezifisch)
async function insertTextAtCursor(text) {
  // Prüfen, ob eine aktive Anwendung gespeichert wurde
  if (!lastActiveApp) {
    console.error('Keine aktive Anwendung gefunden');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-error', { 
        message: 'Fehler: Keine aktive Anwendung gefunden. Text konnte nicht eingefügt werden.' 
      });
    }
    return;
  }
  
  // Sichere Variante: Text in eine temporäre Datei schreiben und dann einlesen
  const tempTextFilePath = path.join(app.getPath('temp'), `transbuddy_text_${Date.now()}.txt`);
  
  try {
    // Text direkt als Datei speichern, statt zu versuchen, ihn im AppleScript zu escapen
    await writeFileAsync(tempTextFilePath, text);
    
    // AppleScript verbessern, um mit möglichen Listen von Anwendungsnamen umzugehen
    let appName = lastActiveApp;
    
    // Wenn lastActiveApp mehrere Anwendungen enthält, nehmen wir nur die erste
    if (appName.includes(',')) {
      appName = appName.split(',')[0].trim();
      console.log(`Mehrere Anwendungen erkannt, verwende die erste: ${appName}`);
    }
    
    // Entferne eventuelle "item X of" Ausdrücke
    if (appName.includes('item')) {
      appName = appName.replace(/item \d+ of /g, '').trim();
      console.log(`"item X of" entfernt, verwende: ${appName}`);
    }
    
    // Zwischenablage-basierte Methode zum Einfügen des Textes
    const clipboardScript = `
      set theText to (do shell script "cat '${tempTextFilePath}'")
      set the clipboard to theText
      
      tell application "${appName}"
        activate
        delay 0.5
      end tell
      
      tell application "System Events"
        keystroke "v" using {command down}
      end tell
    `;
    
    const tmpScriptPath = path.join(app.getPath('temp'), `transbuddy_script_${Date.now()}.scpt`);
    await writeFileAsync(tmpScriptPath, clipboardScript);
    
    try {
      await new Promise((resolve, reject) => {
        exec(`osascript "${tmpScriptPath}"`, (error, stdout, stderr) => {
          try { fs.unlinkSync(tmpScriptPath); } catch (e) {}
          
          if (error || stderr) {
            console.error('Fehler bei der Texteingabe mit Zwischenablage:', error || stderr);
            reject(error || new Error(stderr));
          } else {
            resolve();
          }
        });
      });
      
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('text-inserted');
      }
    } catch (error) {
      console.error('Texteingabe fehlgeschlagen:', error);
      // Keine Fallback-Methode mehr verwenden, wie gewünscht
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { 
          message: 'Text konnte nicht eingefügt werden: ' + error.message
        });
      }
    }
  } catch (error) {
    console.error('Fehler beim Schreiben der temporären Textdatei:', error);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-error', { 
        message: 'Text konnte nicht verarbeitet werden.' 
      });
    }
  } finally {
    // Temporäre Textdatei aufräumen
    try {
      if (fs.existsSync(tempTextFilePath)) {
        fs.unlinkSync(tempTextFilePath);
      }
    } catch (e) {
      console.error('Konnte temporäre Textdatei nicht löschen:', e);
    }
  }
}

// Audio an API senden und Transkription abrufen
async function transcribeAudio(filePath) {
  const apiType = store.get('apiType', 'elevenlabs');
  const apiKey = store.get('elevenlabsApiKey', '');
  
  if (!apiKey) {
    throw new Error('API-Schlüssel fehlt. Bitte in den Einstellungen konfigurieren.');
  }
  
  const audioData = await readFileAsync(filePath);
  
  if (apiType === 'elevenlabs') {
    // 11Labs API
    const form = new FormData();
    form.append('audio', audioData, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey
      },
      body: form
    });
    
    if (!response.ok) {
      throw new Error(`11Labs API-Fehler: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.text || '';
  } else if (apiType === 'openai') {
    // OpenAI API
    const form = new FormData();
    form.append('file', audioData, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    form.append('model', 'whisper-1');
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: form
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API-Fehler: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.text || '';
  } else {
    throw new Error('Ungültiger API-Typ ausgewählt');
  }
}

// IPC-Handlers für die Kommunikation mit dem Renderer-Prozess
ipcMain.handle('get-audio-devices', async () => {
  try {
    const devices = await getAudioDevices();
    return devices;
  } catch (error) {
    console.error('Fehler beim Abrufen der Audiogeräte:', error);
    return [];
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  const { apiKey, apiType, audioDevice } = settings;
  
  // Einstellungen speichern
  store.set('elevenlabsApiKey', apiKey);
  store.set('apiType', apiType);
  store.set('audioDevice', audioDevice);
  
  return { success: true };
});

ipcMain.handle('toggle-recording', async () => {
  if (recording) {
    await stopRecording();
    return { recording: false };
  } else {
    await startRecording();
    return { recording: true };
  }
});

// Neuer Handler zum Abbrechen der Aufnahme ohne Transkription
ipcMain.handle('cancel-recording', async () => {
  return await cancelRecordingProcess();
});

// Handler zum Schließen des Overlays
ipcMain.handle('close-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (recording) {
      stopRecording();
    } else {
      overlayWindow.hide();
    }
  }
  return { success: true };
});

// App-Events
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();
  
  // F5 als globalen Shortcut registrieren (ohne modifier)
  // macOS-Shortcut: falls F5 nicht funktioniert, könnte "f5" direkt verwendet werden
  const success = globalShortcut.register('f5', () => {
    // Direkt die toggle-Funktion aufrufen statt über IPC-Handler
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
  
  if (!success) {
    console.error('Globaler Shortcut F5 konnte nicht registriert werden');
    // Alternativ-Shortcut versuchen
    const altSuccess = globalShortcut.register('CommandOrControl+5', () => {
      if (recording) {
        stopRecording();
      } else {
        startRecording();
      }
    });
    
    if (altSuccess) {
      console.log('Alternativer Shortcut CommandOrControl+5 registriert');
    }
  } else {
    console.log('Globaler Shortcut F5 erfolgreich registriert');
  }
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createOverlayWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Shortcut beim Beenden deaktivieren
  globalShortcut.unregisterAll();
  
  // Aufnahme beenden, falls aktiv
  if (recording) {
    stopRecording();
  }
});