const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, dialog } = require('electron');
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

// Define API options centrally
const apiOptions = [
  { value: 'openai', name: 'OpenAI Whisper', default: true },
  // More APIs can be added here by following the format:
  // { value: 'api_id', name: 'API Display Name', default: false }
];

// Initialize configuration store
const store = new Store();

// Determine the path to the Sox binary (different for development and production)
let soxPath = 'sox'; // Default value for development

// If the app is packaged, use the embedded Sox binary
if (app.isPackaged) {
  // In the packaged app, Sox is in the Resources directory
  soxPath = path.join(process.resourcesPath, 'sox');
  console.log('Using embedded Sox binary:', soxPath);
  
  // Make sure the Sox binary is executable
  try {
    fs.chmodSync(soxPath, '755');
  } catch (error) {
    console.error('Error setting execution permissions for Sox:', error);
  }
}

// Global variables
let mainWindow;
let overlayWindow;
let onboardingWindow = null; // New window for onboarding
let tray = null;
let recording = false;
let recordingStartTime = 0; // Stores the timestamp when recording started
let recordingProcess;
let recordingFilePath;
let isQuitting = false;
let lastActiveApp = null; // Stores the last active application

// Ensure that the app only runs once
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

// App should NOT appear in the Dock
if (process.platform === 'darwin') {
  app.dock.hide();
  app.setActivationPolicy('accessory'); // Important for macOS menu bar apps
}

// Create main window (settings window)
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/SpeakNote_dock_logo.png'),
    show: false, // Initially hidden, opened via tray or dock
    skipTaskbar: true, // Don't show in taskbar
  });

  mainWindow.loadFile('src/settings.html');

  // Hide main window instead of closing when user tries to close it
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  mainWindow.on('ready-to-show', () => {
    // Send saved settings to the renderer window
    const apiKey = store.get('apiKey', '');
    const apiType = store.get('apiType', 'openai');
    const audioDevice = store.get('audioDevice', '');
    
    mainWindow.webContents.send('settings-loaded', {
      apiKey,
      apiType,
      audioDevice
    });
  });
}

// Create overlay window (recording UI)
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
    focusable: true, // Set to true to enable keyboard events (especially ESC)
    skipTaskbar: true,
    show: false, // Initially hidden
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.loadFile('src/overlay.html');
  
  // Window can be closed
  overlayWindow.on('close', (event) => {
    if (recording) {
      stopRecording();
    }
  });
}

// Create onboarding window (only shown on first launch)
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
    // Use standard title bar but hide in CSS
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#f5f5f7'
  });

  onboardingWindow.loadFile('src/onboarding.html');
  
  onboardingWindow.on('close', () => {
    onboardingWindow = null;
  });
}

// Create tray icon
function createTray() {
  try {
    // Path to tray icon
    const iconPath = path.join(__dirname, 'assets/IconTemplate.png');
    
    // Check if the file exists
    if (!fs.existsSync(iconPath)) {
      console.error(`Tray icon not found: ${iconPath}`);
      // Fallback to a standard icon
      tray = new Tray(path.join(__dirname, 'assets/SpeakNote_dock_logo.png'));
    } else {
      // Template image for dark/light appearance in macOS
      tray = new Tray(iconPath);
    }
    
    // Set tooltip
    tray.setToolTip('SpeakNote');
    
    // Create context menu
    const contextMenu = Menu.buildFromTemplate([
      { 
        label: 'Start/Stop Transcription', 
        click: () => { 
          if (recording) {
            stopRecording();
          } else {
            startRecording();
          }
        } 
      },
      { type: 'separator' },
      { label: 'Settings', click: () => { mainWindow.show(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    
    // Set context menu
    tray.setContextMenu(contextMenu);
    
    // Double-click on tray icon opens settings
    tray.on('double-click', () => {
      mainWindow.show();
    });
    
    console.log('Tray successfully created');
  } catch (error) {
    console.error('Error creating tray icon:', error);
  }
}

// Get available audio input devices
async function getAudioDevices() {
  return new Promise((resolve, reject) => {
    exec('system_profiler SPAudioDataType -json', (error, stdout, stderr) => {
      if (error) {
        console.error('Error retrieving audio devices:', error);
        reject(error);
        return;
      }
      
      try {
        const parsedData = JSON.parse(stdout);
        const audioDevices = [];
        
        // Extract device names from the JSON response
        if (parsedData && parsedData.SPAudioDataType) {
          parsedData.SPAudioDataType.forEach(device => {
            if (device['_name'] && device['coreaudio_device'] && Array.isArray(device['coreaudio_device'])) {
              device['coreaudio_device'].forEach(coreDevice => {
                if (coreDevice['input_channels'] && coreDevice['input_channels'] > 0) {
                  // Add device name without technical details
                  const deviceName = coreDevice['_name'].replace(/\s*\([^)]*\)\s*/g, '').trim();
                  if (deviceName && !audioDevices.includes(deviceName)) {
                    audioDevices.push(deviceName);
                  }
                }
              });
            }
          });
        }
        
        // If no devices found, try fallback method
        if (audioDevices.length === 0) {
          exec('system_profiler SPAudioDataType | grep "Input Source:"', (error, stdout, stderr) => {
            if (error) {
              console.error('Error in fallback audio device detection:', error);
              resolve([]);
              return;
            }
            
            const lines = stdout.trim().split('\n');
            const devices = lines.map(line => {
              // Extract just the device name after "Input Source:"
              const match = line.match(/Input Source:\s*(.*?)(?:\s*$|\s*:)/);
              return match ? match[1].trim() : null;
            })
            .filter(device => device && device !== 'Default');
            
            // Remove duplicates
            const uniqueDevices = [...new Set(devices)];
            resolve(uniqueDevices);
          });
        } else {
          resolve(audioDevices);
        }
      } catch (parseError) {
        console.error('Error parsing audio device data:', parseError);
        reject(parseError);
      }
    });
  });
}

// Capture active application before opening the overlay
async function captureActiveApplication() {
  return new Promise(async (resolve) => {
    try {
      // Write the AppleScript to a temporary file rather than injecting it into shell command
      // This avoids escaping issues with complex scripts
      const tmpDir = app.getPath('temp');
      const tmpScriptPath = path.join(tmpDir, `SpeakNote_get_app_${Date.now()}.scpt`);
      
      const appDetectionScript = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  return frontApp
end tell
`;
      
      // Write the script to a file
      await writeFileAsync(tmpScriptPath, appDetectionScript);
      
      // Execute the script file
      const frontApp = await new Promise((innerResolve, innerReject) => {
        exec(`osascript "${tmpScriptPath}"`, (err, stdout, stderr) => {
          try { 
            fs.unlinkSync(tmpScriptPath); 
          } catch (e) {
            console.log('[DEBUG] Could not delete temp script:', e);
          }
          
          if (err) {
            console.error('[DEBUG] Error in app detection script:', err);
            innerReject(err);
          } else {
            innerResolve(stdout.trim());
          }
        });
      });
      
      console.log('[DEBUG] Frontmost application detected:', frontApp);
      
      // Handle Finder case (check if desktop or window)
      if (frontApp === "Finder") {
        // Use a separate script file for counting Finder windows
        const finderScriptPath = path.join(tmpDir, `SpeakNote_finder_${Date.now()}.scpt`);
        const finderScript = `
tell application "Finder"
  return count of windows
end tell
`;
        
        await writeFileAsync(finderScriptPath, finderScript);
        
        const windowCount = await new Promise((innerResolve, innerReject) => {
          exec(`osascript "${finderScriptPath}"`, (err, stdout, stderr) => {
            try { 
              fs.unlinkSync(finderScriptPath); 
            } catch (e) {
              console.log('[DEBUG] Could not delete temp script:', e);
            }
            
            if (err) {
              console.error('[DEBUG] Error counting Finder windows:', err);
              innerReject(err);
            } else {
              innerResolve(parseInt(stdout.trim(), 10));
            }
          });
        });
        
        if (windowCount > 0) {
          // Finder window is active, not desktop
          lastActiveApp = "Finder";
          console.log('[DEBUG] Finder window is active');
        } else {
          // Desktop is active (Finder with no windows)
          lastActiveApp = "";
          console.log('[DEBUG] Desktop is active (Finder with no windows)');
          resolve({ 
            success: false, 
            error: 'Desktop is active. Please click in a text field of an application first.',
            isDesktop: true
          });
          return;
        }
      } 
      // Handle SpeakNote or Electron case
      else if (frontApp === "Electron" || frontApp.includes("SpeakNote")) {
        console.log('[DEBUG] SpeakNote itself is frontmost, looking for alternative apps');
        
        // Use a separate script file for detecting visible apps
        const visibleAppsScriptPath = path.join(tmpDir, `SpeakNote_visible_${Date.now()}.scpt`);
        const visibleAppsScript = `
tell application "System Events"
  set visibleProcesses to name of every process whose visible is true
  return visibleProcesses
end tell
`;
        
        await writeFileAsync(visibleAppsScriptPath, visibleAppsScript);
        
        const visibleAppsOutput = await new Promise((innerResolve, innerReject) => {
          exec(`osascript "${visibleAppsScriptPath}"`, (err, stdout, stderr) => {
            try { 
              fs.unlinkSync(visibleAppsScriptPath); 
            } catch (e) {
              console.log('[DEBUG] Could not delete temp script:', e);
            }
            
            if (err) {
              console.error('[DEBUG] Error getting visible apps:', err);
              innerReject(err);
            } else {
              innerResolve(stdout.trim());
            }
          });
        });
        
        // Parse the comma-separated list of apps
        const visibleApps = visibleAppsOutput.split(', ');
        console.log('[DEBUG] Visible apps:', visibleApps);
        
        // Find first non-SpeakNote, non-Electron, non-Finder app
        const otherApp = visibleApps.find(app => 
          app !== "Electron" && 
          !app.includes("SpeakNote") && 
          app !== "Finder"
        );
        
        if (otherApp) {
          lastActiveApp = otherApp;
          console.log('[DEBUG] Found alternative active application:', otherApp);
        } else {
          lastActiveApp = "";
          console.log('[DEBUG] No suitable alternative application found');
          resolve({ 
            success: false, 
            error: 'No target application detected. Try clicking on a text field first.'
          });
          return;
        }
      } else {
        // Another app is frontmost
        lastActiveApp = frontApp;
      }
      
      // Final check before reporting success
      if (!lastActiveApp || lastActiveApp === "") {
        console.log('[DEBUG] No suitable application detected for text insertion');
        resolve({ 
          success: false, 
          error: 'No target application detected. Try clicking on a text field first.' 
        });
      } else {
        console.log('[DEBUG] Active application captured:', lastActiveApp);
        resolve({ success: true, app: lastActiveApp });
      }
      
    } catch (error) {
      console.error('Error determining active application:', error);
      resolve({ success: false, error: 'Could not detect active application' });
    }
  });
}

// Start recording
async function startRecording() {
  console.log('[DEBUG] startRecording called');
  
  // If a recording is already running, stop it first
  if (recording) {
    console.log('[DEBUG] Already recording, stopping current recording');
    await stopRecording();
    // Longer pause to ensure all resources are released
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Check if a cancellation occurred recently
  const lastCancelTimeKey = 'lastCancelTime';
  const lastCancelTime = global[lastCancelTimeKey] || 0;
  const now = Date.now();
  const timeSinceCancel = now - lastCancelTime;
  
  // If cancellation was less than 1500ms ago, we wait
  if (timeSinceCancel < 1500) {
    console.log(`[DEBUG] Too soon after cancellation (${timeSinceCancel}ms), delaying start by ${1500-timeSinceCancel}ms`);
    await new Promise(resolve => setTimeout(resolve, 1500 - timeSinceCancel));
    console.log('[DEBUG] Delay after cancellation completed');
  }
  
  // Make sure no sox process is running
  if (process.platform === 'darwin') {
    try {
      console.log('[DEBUG] Ensuring no Sox processes are running');
      await new Promise((resolve) => {
        exec('killall sox 2>/dev/null || true', () => resolve());
      });
      // Short pause for audio system stability
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (e) {
      console.log('[DEBUG] Sox termination not critical:', e);
    }
  }
  
  // Capture active application before opening the overlay
  const captureResult = await captureActiveApplication();
  
  // Always log the active application attempt when F5 is pressed
  if (captureResult.success) {
    console.log('[DEBUG] Active application captured:', captureResult.app);
  } else {
    // Check if this was a Finder/desktop case
    if (captureResult.error && captureResult.error.includes("Desktop is active")) {
      console.log('[DEBUG] Desktop is active - no suitable text target available');
    } else {
      console.log('[DEBUG] Failed to capture active application:', captureResult.error);
    }
  }
  
  // Check if active application capture was successful
  if (!captureResult.success) {
    console.log('[DEBUG] No suitable target application found:', captureResult.error);
    // Create or ensure overlay window exists
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    
    // Show error in overlay with appropriate styling based on the type of error
    let errorMessage = captureResult.error || 'No target application found for text insertion.';
    
    // Add desktop-specific instructions if applicable
    if (captureResult.isDesktop) {
      errorMessage = `${errorMessage} The desktop cannot receive text input.`;
    }
    
    overlayWindow.webContents.send('recording-error', { message: errorMessage });
    overlayWindow.show();
    return;
  }
  
  // Check if an API key is configured
  const apiKey = store.get('apiKey', '');
  if (!apiKey) {
    // No API key, show error and open settings
    createOverlayWindow();
    overlayWindow.webContents.send('recording-error', { 
      message: 'API key missing. Please configure it in settings.' 
    });
    overlayWindow.show();
    
    // After a short delay, open settings
    setTimeout(() => {
      mainWindow.show();
      overlayWindow.hide();
    }, 2000);
    
    return;
  }
  
  const selectedDevice = store.get('audioDevice', '');
  recordingFilePath = path.join(app.getPath('temp'), `SpeakNote_recording_${Date.now()}.wav`);
  console.log('[DEBUG] New recording file:', recordingFilePath);
  
  // Make sure no old audio file exists
  try {
    if (fs.existsSync(recordingFilePath)) {
      await unlinkAsync(recordingFilePath);
      console.log('[DEBUG] Old recording file deleted');
    }
  } catch (error) {
    console.log('[DEBUG] Could not delete old recording file:', error);
    // Not critical, continue
  }
  
  recording = true;
  recordingStartTime = Date.now(); // Store recording start time for minimum recording duration
  console.log('[DEBUG] Recording status set to true, start time:', recordingStartTime);
  
  // Start audio recording with selected device
  let recordCmd;
  if (selectedDevice && selectedDevice.trim() !== '') {
    // With specific device
    recordCmd = `${soxPath} -d -r 44100 -c 1 "${recordingFilePath}" trim 0 silence 1 0.1 1%`;
  } else {
    // With default device
    recordCmd = `${soxPath} -d -r 44100 -c 1 "${recordingFilePath}"`;
  }
  
  console.log('[DEBUG] Starting recording with command:', recordCmd);
  
  try {
    recordingProcess = exec(recordCmd, (error) => {
      if (error && !error.killed) {
        console.error('[DEBUG] Error during recording:', error);
        recording = false;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('recording-error', { message: `Recording error: ${error.message}` });
        }
      }
    });
    
    // Update UI
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      console.log('[DEBUG] Sending recording-started to overlay');
      overlayWindow.webContents.send('recording-started');
      overlayWindow.show();
    } else {
      // If the overlay window doesn't exist, create it
      createOverlayWindow();
      setTimeout(() => {
        console.log('[DEBUG] Sending recording-started to newly created overlay');
        overlayWindow.webContents.send('recording-started');
        overlayWindow.show();
      }, 300);
    }
  } catch (error) {
    console.error('[DEBUG] Error starting recording:', error);
    recording = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('recording-error', { message: `Error starting recording: ${error.message}` });
    }
  }
}

// Stop recording and transcribe
async function stopRecording() {
  if (!recording) return;
  
  // If there's no lastActiveApp at this point, the recording can't be successful
  if (!lastActiveApp) {
    console.error('Recording stopped with no target application');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-error', { 
        message: 'No target application available for text insertion.'
      });
      // Hide overlay after a delay
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.hide();
        }
      }, 2000);
    }
    recording = false;
    return;
  }
  
  recording = false;
  
  // Check minimum recording time (1000ms = 1 second)
  const minRecordingTime = 1000; // 1 second as minimum value for the API
  const recordingDuration = Date.now() - recordingStartTime;
  
  // Safely terminate recording process
  if (recordingProcess) {
    try {
      // Send kill signal and wait for process to end
      recordingProcess.kill('SIGTERM');
      
      // Additionally ensure that the process is really terminated
      if (process.platform === 'darwin') {
        // On macOS: Run killall sox to ensure the process is terminated
        exec('killall sox', (error) => {
          if (error && !error.message.includes('No matching processes')) {
            console.error('Error terminating Sox process:', error);
          }
        });
      }
      
      // Reset process reference
      recordingProcess = null;
    } catch (error) {
      console.error('Error terminating recording process:', error);
    }
  }
  
  // Make sure the overlayWindow still exists
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording-stopped');
    
    // If the recording was too short, show an error message and abort
    if (recordingDuration < minRecordingTime) {
      console.log(`Recording too short (${recordingDuration}ms). Minimum length: ${minRecordingTime}ms`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { 
          message: 'Recording too short. Please hold F5 longer.' 
        });
      }
      
      // Delete temp file if it exists
      try {
        if (recordingFilePath && fs.existsSync(recordingFilePath)) {
          await unlinkAsync(recordingFilePath);
          console.log('Short recording file was deleted.');
        }
      } catch (error) {
        console.error('Error deleting temporary file:', error);
      }
      
      return;
    }
    
    try {
      // Start transcription
      overlayWindow.webContents.send('transcription-started');
      
      const transcribedText = await transcribeAudio(recordingFilePath);
      
      // Transcription successful - check again if window still exists
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-completed', { text: transcribedText });
        
        // Log the target application before inserting text
        console.log('[DEBUG] Transcription complete, will insert text into target application:', lastActiveApp);
        
        // Insert text at cursor position
        await insertTextAtCursor(transcribedText);
        
        try {
          // Delete temp file if it exists
          if (fs.existsSync(recordingFilePath)) {
            await unlinkAsync(recordingFilePath);
          }
        } catch (fileError) {
          console.error('Error deleting temporary audio file:', fileError);
          // Not critical, continue
        }
        
        // Close overlay after a short delay
        setTimeout(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
          }
        }, 2000);
      }
    } catch (error) {
      console.error('Error during transcription:', error);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { message: error.message });
      }
    }
  }
}

// Explicitly cancel the recording without transcription
async function cancelRecordingProcess() {
  console.log('[DEBUG] cancelRecordingProcess called, recording status:', recording);
  
  if (!recording) {
    console.log('[DEBUG] No recording in progress, nothing to cancel');
    return { success: true };
  }
  
  console.log('[DEBUG] Recording is being explicitly canceled...');
  recording = false;
  
  // Important: Store cancellation timestamp to prevent rapid restarts
  const lastCancelTimeKey = 'lastCancelTime';
  global[lastCancelTimeKey] = Date.now();
  console.log(`[DEBUG] Last cancellation timestamp set: ${global[lastCancelTimeKey]}`);
  
  // Immediately terminate recording resources
  try {
    if (recordingProcess) {
      try {
        console.log('[DEBUG] Terminating recording process with SIGKILL');
        recordingProcess.kill('SIGKILL');
      } catch (error) {
        console.error('[DEBUG] Error terminating recording process:', error);
      } finally {
        recordingProcess = null;
      }
    }
    
    console.log('[DEBUG] Terminating audio processes');
    
    // Enhanced, sequence-sensitive method for terminating audio processes
    if (process.platform === 'darwin') {
      // First try with less aggressive methods
      try {
        await new Promise((resolve) => {
          exec('killall sox 2>/dev/null || true', () => resolve());
        });
        
        // Short wait
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Then be more aggressive, but without reporting errors if no processes are found
        await new Promise((resolve) => {
          exec('killall -9 sox 2>/dev/null || true', (error) => {
            if (error) {
              // Ignore error, this is normal if no processes are running
              console.log('[DEBUG] Sox processes were already terminated');
            } else {
              console.log('[DEBUG] Sox processes terminated with SIGKILL');
            }
            resolve();
          });
        });
        
        // Direct method for audio interface reset without OS error messages
        console.log('[DEBUG] Audio system reset in progress');
        await new Promise((resolve) => {
          exec('osascript -e "set volume input volume 0" && sleep 0.2 && osascript -e "set volume input volume 100"', 
            (error) => {
              if (error) console.log('[DEBUG] Audio reset warning (not critical):', error.message);
              resolve();
            }
          );
        });
      } catch (e) {
        console.log('[DEBUG] Audio reset non-critical error:', e);
        // Errors are ignored as they should not block the main function
      }
    } else if (process.platform === 'win32') {
      // Windows-specific code
      await new Promise((resolve) => {
        exec('taskkill /F /IM sox.exe /T', () => resolve());
      });
    } else {
      // Linux-specific code
      await new Promise((resolve) => {
        exec('pkill -9 -f sox || true', () => resolve());
      });
    }
  } catch (error) {
    console.error('[DEBUG] General error terminating audio system:', error);
  }
  
  // Inform overlay window about the cancellation, but DO NOT close it
  console.log('[DEBUG] Informing overlay about cancellation');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('cancel-recording-direct');
    } catch (error) {
      console.error('[DEBUG] Error sending to overlay:', error);
    }
  }
  
  // Delete recording file
  if (recordingFilePath && fs.existsSync(recordingFilePath)) {
    try {
      console.log('[DEBUG] Deleting temporary recording file:', recordingFilePath);
      fs.unlinkSync(recordingFilePath);
      console.log('[DEBUG] Temporary recording file deleted.');
    } catch (error) {
      console.error('[DEBUG] Error deleting temporary file:', error);
    }
  }
  
  console.log('[DEBUG] Recording cancellation completed');
  return { success: true };
}

// Insert text at cursor position (macOS-specific)
async function insertTextAtCursor(text) {
  console.log('[DEBUG] insertTextAtCursor called');
  
  // Check if an active application was saved
  if (!lastActiveApp) {
    console.error('No active application found');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-error', { 
        message: 'Error: No active application found. Text could not be inserted.' 
      });
    }
    return;
  }
  
  console.log('[DEBUG] Attempting to insert text into application:', lastActiveApp);
  
  const tmpDir = app.getPath('temp');
  
  try {
    // Sanitize app name to ensure proper functioning
    let appName = lastActiveApp.trim();
    
    // If lastActiveApp contains multiple applications, take only the first one
    if (appName.includes(',')) {
      appName = appName.split(',')[0].trim();
      console.log(`[DEBUG] Multiple applications detected, using the first one: ${appName}`);
    }
    
    // Remove any "item X of" expressions which can come from AppleScript lists
    if (appName.includes('item')) {
      appName = appName.replace(/item \d+ of /g, '').trim();
      console.log(`[DEBUG] "item X of" removed, using: ${appName}`);
    }
    
    // First check if the target application is still running
    // Create a script file instead of inline script
    const checkAppScriptPath = path.join(tmpDir, `SpeakNote_check_app_${Date.now()}.scpt`);
    
    // Create app check script
    const checkAppScript = `
try
  tell application "${appName}" to get name
  return true
on error
  return false
end try
`;
    
    await writeFileAsync(checkAppScriptPath, checkAppScript);
    
    const appRunningResult = await new Promise((resolve, reject) => {
      exec(`osascript "${checkAppScriptPath}"`, (error, stdout, stderr) => {
        try { 
          fs.unlinkSync(checkAppScriptPath); 
        } catch (e) {
          console.log('[DEBUG] Could not delete temp script:', e);
        }
        
        if (error || stderr) {
          console.error('[DEBUG] Error checking if app is running:', error || stderr);
          reject(false);
        } else {
          // AppleScript returns "true" or "false" as a string
          resolve(stdout.trim() === "true");
        }
      });
    });
    
    if (!appRunningResult) {
      console.error(`[DEBUG] Target application "${appName}" is no longer running`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { 
          message: `Target application "${appName}" is no longer available. Text could not be inserted.` 
        });
      }
      return;
    }
    
    // Safe variant: Write text to a temporary file and then read it
    const tempTextFilePath = path.join(tmpDir, `SpeakNote_text_${Date.now()}.txt`);
    
    // Save text directly as a file instead of trying to escape it
    await writeFileAsync(tempTextFilePath, text);
    
    // Create clipboard insertion script file
    const clipboardScriptPath = path.join(tmpDir, `SpeakNote_insert_${Date.now()}.scpt`);
    
    // Clipboard-based method for inserting text
    const clipboardScript = `
-- Read text from file
set theText to (do shell script "cat '${tempTextFilePath}'")
-- Put text on clipboard
set the clipboard to theText

-- Activate target app
tell application "${appName}"
  activate
  delay 0.3
end tell

-- Paste text
tell application "System Events"
  keystroke "v" using {command down}
end tell
`;
    
    await writeFileAsync(clipboardScriptPath, clipboardScript);
    
    try {
      await new Promise((resolve, reject) => {
        exec(`osascript "${clipboardScriptPath}"`, (error, stdout, stderr) => {
          try { 
            fs.unlinkSync(clipboardScriptPath); 
          } catch (e) {
            console.log('[DEBUG] Could not delete temp script:', e);
          }
          
          if (error || stderr) {
            console.error('[DEBUG] Error inserting text with clipboard:', error || stderr);
            reject(error || new Error(stderr));
          } else {
            console.log('[DEBUG] Text successfully inserted into', appName);
            resolve();
          }
        });
      });
      
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('text-inserted');
      }
    } catch (error) {
      console.error('[DEBUG] Text insertion failed:', error);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-error', { 
          message: 'Text could not be inserted: ' + error.message
        });
      }
    }
  } catch (error) {
    console.error('[DEBUG] Error in text insertion process:', error);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-error', { 
        message: 'Text could not be processed: ' + error.message 
      });
    }
  } finally {
    // Clean up temporary text file
    const tempTextFilePath = path.join(tmpDir, `SpeakNote_text_${Date.now()}.txt`);
    try {
      if (fs.existsSync(tempTextFilePath)) {
        fs.unlinkSync(tempTextFilePath);
      }
    } catch (e) {
      console.error('[DEBUG] Could not delete temporary text file:', e);
    }
  }
}

// Send audio to API and retrieve transcription
async function transcribeAudio(filePath) {
  console.log('[DEBUG] transcribeAudio called with file:', filePath);
  
  // Check if the file exists before proceeding
  if (!fs.existsSync(filePath)) {
    console.error(`[DEBUG] Error: Audio file does not exist: ${filePath}`);
    throw new Error('The recording file was not found. The recording might have been canceled.');
  }
  
  const apiType = store.get('apiType', 'openai');
  const apiKey = store.get('apiKey', '');
  
  if (!apiKey) {
    throw new Error('API key missing. Please configure it in settings.');
  }
  
  try {
    console.log('[DEBUG] Reading audio file:', filePath);
    const audioData = await readFileAsync(filePath);
    console.log(`[DEBUG] Audio file read, size: ${audioData.length} bytes`);
    
    if (audioData.length < 1000) {
      console.error('[DEBUG] Audio file is too small/empty');
      throw new Error('The recording is too short or empty. Please try again.');
    }
    
    // Process based on selected API type
    switch (apiType) {
      case 'openai':
        // OpenAI API
        return await transcribeWithOpenAI(audioData, apiKey);
      
      // To add a new API integration, add a new case here:
      // case 'new_api_id':
      //   return await transcribeWithNewAPI(audioData, apiKey);
        
      default:
        throw new Error(`Unsupported API type: ${apiType}`);
    }
  } catch (error) {
    console.error('[DEBUG] Error in transcribeAudio:', error);
    throw error; // Pass error on
  }
}

// OpenAI Whisper API implementation
async function transcribeWithOpenAI(audioData, apiKey) {
  console.log('[DEBUG] Sending request to OpenAI API');
  
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
    console.error(`[DEBUG] OpenAI API error: ${response.status} ${response.statusText}`);
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  console.log('[DEBUG] OpenAI API response received');
  return data.text || '';
}

// IPC handlers for communication with the renderer process
ipcMain.handle('get-audio-devices', async () => {
  try {
    const devices = await getAudioDevices();
    return devices;
  } catch (error) {
    console.error('Error retrieving audio devices:', error);
    return [];
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  const { apiKey, apiType, audioDevice } = settings;
  
  // Save settings
  store.set('apiKey', apiKey);
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

// New handler for canceling recording without transcription
ipcMain.handle('cancel-recording', async () => {
  return await cancelRecordingProcess();
});

// Handler for retrieving API options
ipcMain.handle('get-api-options', () => {
  return apiOptions;
});

// Handler for closing the overlay
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

// Handlers for onboarding process
ipcMain.handle('open-accessibility-settings', async () => {
  // macOS-specific code for accessibility settings
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', (error) => {
      if (error) {
        console.error('Error opening accessibility settings:', error);
      }
    });
  }
  return { success: true };
});

// Handler for microphone settings
ipcMain.handle('open-microphone-settings', async () => {
  // macOS-specific code for microphone settings
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"', (error) => {
      if (error) {
        console.error('Error opening microphone settings:', error);
      }
    });
  }
  return { success: true };
});

ipcMain.handle('check-accessibility-permission', async () => {
  // Checks if the app has accessibility permissions
  // This check is complex and not directly possible in Electron
  // We use a test attempt to see if AppleScript can be executed
  try {
    await new Promise((resolve, reject) => {
      const testScript = `
        tell application "System Events"
          display dialog "Test" buttons {"OK"} default button "OK" with hidden after 0.1
        end tell
      `;
      
      exec(`osascript -e '${testScript}'`, (error) => {
        if (error) {
          // If an error occurs, the app probably doesn't have accessibility permissions
          reject(new Error('No accessibility permission'));
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
  
  // Save API key
  store.set('apiKey', apiKey);
  store.set('apiType', apiType);
  
  return { success: true };
});

ipcMain.handle('finish-onboarding', () => {
  // Mark onboarding as completed
  store.set('onboardingCompleted', true);
  
  // Close onboarding window
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }
  
  return { success: true };
});

// App events
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();
  
  // Check if onboarding has already been completed
  const onboardingCompleted = store.get('onboardingCompleted', false); //To reset onboarding status: open ~/Library/Application\ Support/SpeakNote/config.json
  //const onboardingCompleted = false;
  
  // Show onboarding on first launch
  if (!onboardingCompleted) {
    createOnboardingWindow();
  }

  // Variable to monitor rapid repetitions of F5
  let lastF5Time = 0;
  let isProcessing = false;

  // Refactored F5 Shortcut Handler
  async function handleF5Shortcut() {
    // Debouncing mechanism: Filter calls that are too fast (within 800ms)
    const now = Date.now();
    if (now - lastF5Time < 800) {
      console.log('F5 was pressed too quickly in succession, ignoring...');
      return;
    }

    // Processing is already running - block
    if (isProcessing) {
      console.log('An F5 action is already in progress, ignoring...');
      return;
    }

    lastF5Time = now;
    isProcessing = true;
    console.log('[DEBUG] F5 key pressed, processing action...');

    try {
      // Status check and corresponding action
      if (recording) {
        console.log('[DEBUG] F5 pressed while recording, stopping recording...');
        await stopRecording();
      } else {
        console.log('[DEBUG] F5 pressed to start new recording, will capture active application...');
        await startRecording();
      }
    } catch (error) {
      console.error('Error during F5 processing:', error);
    } finally {
      // Reactivate after a short delay (prevents multiple triggers)
      setTimeout(() => {
        isProcessing = false;
      }, 500);
    }
  }
  
  // Register F5 as a global shortcut - this runs every time the app starts
  const success = globalShortcut.register('f5', handleF5Shortcut);
  
  if (!success) {
    console.error('Global shortcut F5 could not be registered');
    // Try alternative shortcut if F5 registration fails
    const altSuccess = globalShortcut.register('CommandOrControl+5', async () => {
      // Same debouncing mechanism as for F5
      const now = Date.now();
      if (now - lastF5Time < 800 || isProcessing) {
        return;
      }
      
      lastF5Time = now;
      isProcessing = true;
      console.log('[DEBUG] CommandOrControl+5 key pressed, processing action...');
      
      try {
        if (recording) {
          console.log('[DEBUG] CommandOrControl+5 pressed while recording, stopping recording...');
          await stopRecording();
        } else {
          console.log('[DEBUG] CommandOrControl+5 pressed to start new recording, will capture active application...');
          await startRecording();
        }
      } catch (error) {
        console.error('Error during CommandOrControl+5 processing:', error);
      } finally {
        setTimeout(() => {
          isProcessing = false;
        }, 500);
      }
    });
    
    if (altSuccess) {
      console.log('Alternative shortcut CommandOrControl+5 registered');
    } else {
      console.error('Both F5 and CommandOrControl+5 shortcuts could not be registered');
      
      // Show a notification to the user about shortcut registration failure
      const currentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
      dialog.showMessageBox(currentWindow, {
        type: 'warning',
        title: 'Shortcut Registration Issue',
        message: 'SpeakNote could not register keyboard shortcuts (F5 or CommandOrControl+5).',
        detail: 'This might be due to a conflict with another application. You may need to restart your computer or check system shortcut settings.',
        buttons: ['OK']
      }).catch(err => {
        console.error('Error displaying shortcut failure dialog:', err);
      });
    }
  } else {
    console.log('Global shortcut F5 successfully registered');
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
  // Disable shortcut on exit
  globalShortcut.unregisterAll();
  
  // Stop recording if active
  if (recording) {
    stopRecording();
  }
});