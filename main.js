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

// API-Optionen zentral definieren
const apiOptions = [
  { value: 'openai', name: 'OpenAI Whisper', default: true },
  { value: 'elevenlabs', name: 'ElevenLabs Scribe' },
  // Weitere APIs können hier hinzugefügt werden
];

// Konfigurationsspeicher initialisieren
const store = new Store();

// Pfad zur Sox-Binärdatei ermitteln (unterschiedlich für Entwicklung und Production)
let soxPath = 'sox'; // Standard-Wert für Entwicklung

// Wenn die App gepackt ist, verwenden wir die eingebettete Sox-Binärdatei
if (app.isPackaged) {
  // In der gepackten App ist Sox im Resources-Verzeichnis
  soxPath = path.join(process.resourcesPath, 'sox');
  console.log('Verwende eingebettete Sox-Binärdatei:', soxPath);
  
  // Stelle sicher, dass die Sox-Binärdatei ausführbar ist
  try {
    fs.chmodSync(soxPath, '755');
  } catch (error) {
    console.error('Fehler beim Setzen der Ausführungsrechte für Sox:', error);
  }
}

// Globale Variablen
let mainWindow;
let overlayWindow;
let onboardingWindow = null; // Neues Fenster für Onboarding
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

// Onboarding-Fenster erstellen (nur beim ersten Start anzeigen)
function createOnboardingWindow() {
  onboardingWindow = new BrowserWindow({
    width: 700,
    height: 650,
    resizable: true,
    minimizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    center: true,
    // Standard-Titelleiste verwenden, aber im CSS ausblenden
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#f5f5f7'
  });

  onboardingWindow.loadFile('src/onboarding.html');
  
  onboardingWindow.on('close', () => {
    onboardingWindow = null;
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
  console.log('[DEBUG] startRecording aufgerufen');
  
  // Wenn bereits eine Aufnahme läuft, diese zuerst beenden
  if (recording) {
    console.log('[DEBUG] Bereits laufende Aufnahme wird gestoppt');
    await stopRecording();
    // Längere Pause, um sicherzustellen, dass alle Ressourcen freigegeben sind
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Prüfen, ob ein Abbruch kürzlich stattgefunden hat
  const lastCancelTimeKey = 'lastCancelTime';
  const lastCancelTime = global[lastCancelTimeKey] || 0;
  const now = Date.now();
  const timeSinceCancel = now - lastCancelTime;
  
  // Wenn Abbruch weniger als 1500ms her ist, warten wir
  if (timeSinceCancel < 1500) {
    console.log(`[DEBUG] Zu schnell nach Abbruch (${timeSinceCancel}ms), verzögere Start um ${1500-timeSinceCancel}ms`);
    await new Promise(resolve => setTimeout(resolve, 1500 - timeSinceCancel));
    console.log('[DEBUG] Verzögerung nach Abbruch abgeschlossen');
  }
  
  // Stellen wir sicher, dass kein sox-Prozess läuft
  if (process.platform === 'darwin') {
    try {
      console.log('[DEBUG] Stelle sicher, dass keine Sox-Prozesse laufen');
      await new Promise((resolve) => {
        exec('killall sox 2>/dev/null || true', () => resolve());
      });
      // Kurze Pause für Audio-System-Stabilität
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (e) {
      console.log('[DEBUG] Sox-Beendigung nicht kritisch:', e);
    }
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
  console.log('[DEBUG] Neue Aufnahme-Datei:', recordingFilePath);
  
  // Stellen wir sicher, dass keine alte Audiodatei existiert
  try {
    if (fs.existsSync(recordingFilePath)) {
      await unlinkAsync(recordingFilePath);
      console.log('[DEBUG] Alte Aufnahmedatei gelöscht');
    }
  } catch (error) {
    console.log('[DEBUG] Alte Aufnahmedatei konnte nicht gelöscht werden:', error);
    // Nicht kritisch, weitermachen
  }
  
  recording = true;
  recordingStartTime = Date.now(); // Aufnahmebeginn speichern für Mindestaufnahmezeit
  console.log('[DEBUG] Aufnahme-Status auf true gesetzt, Start-Zeit:', recordingStartTime);
  
  // Audio-Aufnahme mit ausgewähltem Gerät starten
  let recordCmd;
  if (selectedDevice && selectedDevice.trim() !== '') {
    // Mit spezifischem Gerät
    recordCmd = `${soxPath} -d -r 44100 -c 1 "${recordingFilePath}" trim 0 silence 1 0.1 1%`;
  } else {
    // Mit Standard-Gerät
    recordCmd = `${soxPath} -d -r 44100 -c 1 "${recordingFilePath}"`;
  }
  
  console.log('[DEBUG] Starte Aufnahme mit Befehl:', recordCmd);
  
  try {
    recordingProcess = exec(recordCmd, (error) => {
      if (error && !error.killed) {
        console.error('[DEBUG] Fehler bei der Aufnahme:', error);
        recording = false;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('recording-error', { message: `Fehler bei der Aufnahme: ${error.message}` });
        }
      }
    });
    
    // UI aktualisieren
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      console.log('[DEBUG] Sende recording-started an Overlay');
      overlayWindow.webContents.send('recording-started');
      overlayWindow.show();
    } else {
      // Falls das Overlay-Fenster nicht existiert, neu erstellen
      createOverlayWindow();
      setTimeout(() => {
        console.log('[DEBUG] Sende recording-started an neu erstelltes Overlay');
        overlayWindow.webContents.send('recording-started');
        overlayWindow.show();
      }, 300);
    }
  } catch (error) {
    console.error('[DEBUG] Fehler beim Starten der Aufnahme:', error);
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
  console.log('[DEBUG] cancelRecordingProcess aufgerufen, Status recording:', recording);
  
  if (!recording) {
    console.log('[DEBUG] Keine Aufnahme läuft, nichts abzubrechen');
    return { success: true };
  }
  
  console.log('[DEBUG] Aufnahme wird explizit abgebrochen...');
  recording = false;
  
  // Wichtig: Zeitstempel des Abbruchs speichern für Schutz vor zu schnellen Neustarts
  const lastCancelTimeKey = 'lastCancelTime';
  global[lastCancelTimeKey] = Date.now();
  console.log(`[DEBUG] Letzter Abbruch-Zeitstempel gesetzt: ${global[lastCancelTimeKey]}`);
  
  // Sofortiges Beenden der Aufnahmeressourcen
  try {
    if (recordingProcess) {
      try {
        console.log('[DEBUG] Beende Aufnahmeprozess mit SIGKILL');
        recordingProcess.kill('SIGKILL');
      } catch (error) {
        console.error('[DEBUG] Fehler beim Beenden des Aufnahmeprozesses:', error);
      } finally {
        recordingProcess = null;
      }
    }
    
    console.log('[DEBUG] Beende Audio-Prozesse');
    
    // Verbesserte, reihenfolgesensitive Methode zum Beenden von Audio-Prozessen
    if (process.platform === 'darwin') {
      // Erst versuchen wir es mit weniger aggressiven Methoden
      try {
        await new Promise((resolve) => {
          exec('killall sox 2>/dev/null || true', () => resolve());
        });
        
        // Kurz warten
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Dann aggressiver werden, aber ohne Fehler auszugeben, wenn keine Prozesse gefunden werden
        await new Promise((resolve) => {
          exec('killall -9 sox 2>/dev/null || true', (error) => {
            if (error) {
              // Error ignorieren, da dies normal ist, wenn keine Prozesse laufen
              console.log('[DEBUG] Sox-Prozesse wurden bereits beendet');
            } else {
              console.log('[DEBUG] Sox-Prozesse mit SIGKILL beendet');
            }
            resolve();
          });
        });
        
        // Direkte Methode für Audio-Schnittstellen-Reset ohne OS-Fehlermeldungen
        console.log('[DEBUG] Audio-System-Reset wird durchgeführt');
        await new Promise((resolve) => {
          exec('osascript -e "set volume input volume 0" && sleep 0.2 && osascript -e "set volume input volume 100"', 
            (error) => {
              if (error) console.log('[DEBUG] Audio-Reset Warnung (nicht kritisch):', error.message);
              resolve();
            }
          );
        });
      } catch (e) {
        console.log('[DEBUG] Audio-Reset nicht-kritischer Fehler:', e);
        // Fehler werden ignoriert, da sie die Hauptfunktion nicht blockieren sollen
      }
    } else if (process.platform === 'win32') {
      // Windows-spezifischer Code
      await new Promise((resolve) => {
        exec('taskkill /F /IM sox.exe /T', () => resolve());
      });
    } else {
      // Linux-spezifischer Code
      await new Promise((resolve) => {
        exec('pkill -9 -f sox || true', () => resolve());
      });
    }
  } catch (error) {
    console.error('[DEBUG] Allgemeiner Fehler beim Beenden des Audiosystems:', error);
  }
  
  // Overlay-Fenster über den Cancel-Vorgang informieren, aber NICHT schließen
  console.log('[DEBUG] Overlay über Abbruch informieren');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('cancel-recording-direct');
    } catch (error) {
      console.error('[DEBUG] Fehler beim Senden an Overlay:', error);
    }
  }
  
  // Aufnahmedatei löschen
  if (recordingFilePath && fs.existsSync(recordingFilePath)) {
    try {
      console.log('[DEBUG] Lösche temporäre Aufnahmedatei:', recordingFilePath);
      fs.unlinkSync(recordingFilePath);
      console.log('[DEBUG] Temporäre Aufnahmedatei gelöscht.');
    } catch (error) {
      console.error('[DEBUG] Fehler beim Löschen der temporären Datei:', error);
    }
  }
  
  console.log('[DEBUG] Abbruch der Aufnahme abgeschlossen');
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
  console.log('[DEBUG] transcribeAudio aufgerufen mit Datei:', filePath);
  
  // Prüfen, ob die Datei existiert, bevor wir fortfahren
  if (!fs.existsSync(filePath)) {
    console.error(`[DEBUG] Fehler: Audiodatei existiert nicht: ${filePath}`);
    throw new Error('Die Aufnahmedatei wurde nicht gefunden. Möglicherweise wurde die Aufnahme abgebrochen.');
  }
  
  const apiType = store.get('apiType', 'elevenlabs');
  const apiKey = store.get('elevenlabsApiKey', '');
  
  if (!apiKey) {
    throw new Error('API-Schlüssel fehlt. Bitte in den Einstellungen konfigurieren.');
  }
  
  try {
    console.log('[DEBUG] Lese Audiodatei:', filePath);
    const audioData = await readFileAsync(filePath);
    console.log(`[DEBUG] Audiodatei gelesen, Größe: ${audioData.length} Bytes`);
    
    if (audioData.length < 1000) {
      console.error('[DEBUG] Audiodatei ist zu klein/leer');
      throw new Error('Die Aufnahme ist zu kurz oder leer. Bitte versuche es erneut.');
    }
    
    if (apiType === 'elevenlabs') {
      // 11Labs API
      console.log('[DEBUG] Sende Anfrage an ElevenLabs API');
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
        console.error(`[DEBUG] ElevenLabs API-Fehler: ${response.status} ${response.statusText}`);
        throw new Error(`11Labs API-Fehler: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log('[DEBUG] ElevenLabs API-Antwort erhalten');
      return data.text || '';
    } else if (apiType === 'openai') {
      // OpenAI API
      console.log('[DEBUG] Sende Anfrage an OpenAI API');
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
        console.error(`[DEBUG] OpenAI API-Fehler: ${response.status} ${response.statusText}`);
        throw new Error(`OpenAI API-Fehler: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log('[DEBUG] OpenAI API-Antwort erhalten');
      return data.text || '';
    } else {
      throw new Error('Ungültiger API-Typ ausgewählt');
    }
  } catch (error) {
    console.error('[DEBUG] Fehler in transcribeAudio:', error);
    throw error; // Fehler weitergeben
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

// Handler zum Abrufen der API-Optionen
ipcMain.handle('get-api-options', () => {
  return apiOptions;
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

// Handler für Onboarding-Prozess
ipcMain.handle('open-accessibility-settings', async () => {
  // macOS-spezifischer Code für Bedienungshilfen-Einstellungen
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', (error) => {
      if (error) {
        console.error('Fehler beim Öffnen der Bedienungshilfen-Einstellungen:', error);
      }
    });
  }
  return { success: true };
});

// Neuer Handler für Mikrofoneinstellungen
ipcMain.handle('open-microphone-settings', async () => {
  // macOS-spezifischer Code für Mikrofoneinstellungen
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"', (error) => {
      if (error) {
        console.error('Fehler beim Öffnen der Mikrofoneinstellungen:', error);
      }
    });
  }
  return { success: true };
});

ipcMain.handle('check-accessibility-permission', async () => {
  // Prüft, ob die App Bedienungshilfen-Berechtigungen hat
  // Diese Überprüfung ist kompliziert und nicht direkt möglich in Electron
  // Wir verwenden einen Testversuch, um zu sehen, ob AppleScript ausgeführt werden kann
  try {
    await new Promise((resolve, reject) => {
      const testScript = `
        tell application "System Events"
          display dialog "Test" buttons {"OK"} default button "OK" with hidden after 0.1
        end tell
      `;
      
      exec(`osascript -e '${testScript}'`, (error) => {
        if (error) {
          // Wenn ein Fehler auftritt, hat die App wahrscheinlich keine Bedienungshilfen-Berechtigungen
          reject(new Error('Keine Bedienungshilfen-Berechtigung'));
        } else {
          resolve();
        }
      });
    });
    
    return { hasPermission: true };
  } catch (error) {
    return { hasPermission: false };
  }
});

ipcMain.handle('set-api-key', async (event, apiSettings) => {
  const { apiType, apiKey } = apiSettings;
  
  // API-Schlüssel speichern
  store.set('elevenlabsApiKey', apiKey);
  store.set('apiType', apiType);
  
  return { success: true };
});

ipcMain.handle('finish-onboarding', () => {
  // Onboarding als abgeschlossen markieren
  store.set('onboardingCompleted', true);
  
  // Onboarding-Fenster schließen
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }
  
  return { success: true };
});

// App-Events
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();
  
  // Prüfen, ob das Onboarding bereits abgeschlossen wurde
  const onboardingCompleted = store.get('onboardingCompleted', false); //To reset onboarding status: open ~/Library/Application\ Support/transbuddy/config.json
  //const onboardingCompleted = false;
  
  // Beim ersten Start das Onboarding anzeigen
  if (!onboardingCompleted) {
    createOnboardingWindow();
  }
  
  // Variable zum Überwachen schneller Wiederholungen von F5 hinzufügen
  let lastF5Time = 0;
  let isProcessing = false;
  
  // F5 als globalen Shortcut registrieren
  const success = globalShortcut.register('f5', async () => {
    // Debouncing-Mechanismus: Zu schnelle Aufrufe filtern (innerhalb von 800ms)
    const now = Date.now();
    if (now - lastF5Time < 800) {
      console.log('F5 wurde zu schnell hintereinander gedrückt, ignoriere...');
      return;
    }
    
    // Verarbeitung läuft bereits - blockieren
    if (isProcessing) {
      console.log('Bereits eine F5-Aktion in Bearbeitung, ignoriere...');
      return;
    }
    
    lastF5Time = now;
    isProcessing = true;
    
    try {
      // Statusüberprüfung und entsprechende Aktion
      if (recording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      console.error('Fehler bei der F5-Verarbeitung:', error);
    } finally {
      // Nach einer kurzen Verzögerung wieder aktivieren (verhindert Mehrfach-Auslösung)
      setTimeout(() => {
        isProcessing = false;
      }, 500);
    }
  });
  
  if (!success) {
    console.error('Globaler Shortcut F5 konnte nicht registriert werden');
    // Alternativ-Shortcut versuchen
    const altSuccess = globalShortcut.register('CommandOrControl+5', async () => {
      // Gleicher Debouncing-Mechanismus wie für F5
      const now = Date.now();
      if (now - lastF5Time < 800 || isProcessing) {
        return;
      }
      
      lastF5Time = now;
      isProcessing = true;
      
      try {
        if (recording) {
          await stopRecording();
        } else {
          await startRecording();
        }
      } catch (error) {
        console.error('Fehler bei CommandOrControl+5-Verarbeitung:', error);
      } finally {
        setTimeout(() => {
          isProcessing = false;
        }, 500);
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