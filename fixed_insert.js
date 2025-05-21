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
