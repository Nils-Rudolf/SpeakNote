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
    focusable: false, // Auf false setzen, da wir die ESC-Taste nicht mehr benötigen
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
  if (recording) return;
  
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
  
  recording = true;
  
  // Audio-Aufnahme mit ausgewähltem Gerät starten
  // Korrigierter SoX-Befehl für macOS Audio-Aufnahme mit korrektem Eingabe-/Ausgabeformat
  let recordCmd;
  if (selectedDevice && selectedDevice.trim() !== '') {
    // Mit spezifischem Gerät
    recordCmd = `sox -d -r 44100 -c 1 "${recordingFilePath}" trim 0 silence 1 0.1 1%`;
  } else {
    // Mit Standard-Gerät
    recordCmd = `sox -d -r 44100 -c 1 "${recordingFilePath}"`;
  }
  
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
  overlayWindow.webContents.send('recording-started');
  overlayWindow.show();
}

// Aufnahme stoppen und transkribieren
async function stopRecording() {
  if (!recording) return;
  
  recording = false;
  
  // Aufnahmeprozess beenden
  if (recordingProcess) {
    recordingProcess.kill();
  }
  
  // Sicherstellen, dass das overlayWindow noch existiert
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording-stopped');
    
    try {
      // Transkription starten
      overlayWindow.webContents.send('transcription-started');
      
      const transcribedText = await transcribeAudio(recordingFilePath);
      
      // Transkription erfolgreich - erneut prüfen, ob Window noch existiert
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-completed', { text: transcribedText });
        
        // Text an Cursor einfügen
        await insertTextAtCursor(transcribedText);
        
        // Temp-Datei löschen
        await unlinkAsync(recordingFilePath);
        
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
  
  // Escape-Zeichen behandeln: Anführungszeichen und Backslashes für AppleScript escapen
  const escapedText = text
    .replace(/\\/g, '\\\\')    // Backslashes verdoppeln
    .replace(/"/g, '\\"')      // Doppelte Anführungszeichen escapen
    .replace(/\n/g, '\\n')     // Zeilenumbrüche als \n kodieren
    .replace(/\r/g, '\\r')     // Carriage returns als \r kodieren
    .replace(/\t/g, '\\t');    // Tabs als \t kodieren
  
  // Spezielle Behandlung für TextEdit - erstelle ein neues Dokument
  if (lastActiveApp === "TextEdit") {
    const textEditScript = `
      tell application "TextEdit"
        activate
        make new document
        delay 0.5
        set the text of the front document to "${escapedText}"
      end tell
    `;
    
    return new Promise((resolve, reject) => {
      exec(`osascript -e '${textEditScript}'`, (error, stderr) => {
        if (error || stderr) {
          console.error('Fehler beim Einfügen in TextEdit:', error || stderr);
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('transcription-error', { 
              message: 'Text konnte nicht in TextEdit eingefügt werden.' 
            });
          }
          reject(error || new Error(stderr));
        } else {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('text-inserted');
          }
          resolve();
        }
      });
    });
  }
  
  // Für andere Anwendungen: Direkte Texteingabe ohne Zwischenablage
  const script = `
    on isRunning(appName)
      tell application "System Events" to (name of processes) contains appName
    end isRunning
    
    set targetApp to "${lastActiveApp}"
    
    if isRunning(targetApp) then
      tell application targetApp
        activate
      end tell
      
      delay 0.5
      
      try
        tell application "System Events"
          # Direkte Texteingabe ohne Zwischenablage
          keystroke "${escapedText}"
        end tell
      on error errMsg
        return "Fehler bei Texteingabe: " & errMsg
      end try
    else
      return "Fehler: Anwendung " & targetApp & " ist nicht geöffnet."
    end if
  `;
  
  return new Promise((resolve, reject) => {
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error || stderr || stdout.includes('Fehler')) {
        // Bei Fehler: Fallback zu TextEdit
        const textEditFallbackScript = `
          tell application "TextEdit"
            activate
            make new document
            delay 0.5
            set the text of the front document to "${escapedText}"
          end tell
        `;
        
        exec(`osascript -e '${textEditFallbackScript}'`, (teError, teStdout, teStderr) => {
          if (teError || teStderr) {
            console.error('TextEdit-Fallback fehlgeschlagen:', teError || teStderr);
            
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('transcription-error', { 
                message: 'Text konnte nicht eingefügt werden. Versuche, die App-Berechtigungen zu überprüfen.' 
              });
            }
            
            reject(new Error(`Texteingabe-Methoden fehlgeschlagen`));
          } else {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('text-inserted', { usedFallback: true });
            }
            resolve();
          }
        });
      } else {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('text-inserted');
        }
        resolve();
      }
    });
  });
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