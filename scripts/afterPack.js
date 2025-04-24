// Dieses Skript wird nach dem Packen der App ausgeführt
// und setzt die richtigen Berechtigungen für die Sox-Binärdatei
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

exports.default = function(context) {
  const appOutDir = context.appOutDir;
  const resourcesPath = path.join(appOutDir, 'SpeakNote.app/Contents/Resources/sox');
  
  console.log('Setze Berechtigungen für Sox...');
  
  try {
    // Stelle sicher, dass die Sox-Datei existiert
    if (fs.existsSync(resourcesPath)) {
      // Setze Ausführungsrechte auf die Sox-Binärdatei
      execSync(`chmod +x "${resourcesPath}"`);
      console.log('Sox-Berechtigungen erfolgreich gesetzt!');
    } else {
      console.error('Sox-Binärdatei nicht gefunden in:', resourcesPath);
    }
  } catch (error) {
    console.error('Fehler beim Setzen der Sox-Berechtigungen:', error);
  }
  
  return Promise.resolve();
};