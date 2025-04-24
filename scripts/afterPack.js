// This script is executed after packaging the app
// and sets the correct permissions for the Sox binary file
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

exports.default = function(context) {
  const appOutDir = context.appOutDir;
  const resourcesPath = path.join(appOutDir, 'SpeakNote.app/Contents/Resources/sox');
  
  console.log('Setting permissions for Sox...');
  
  try {
    // Make sure the Sox file exists
    if (fs.existsSync(resourcesPath)) {
      // Set execution rights on the Sox binary
      execSync(`chmod +x "${resourcesPath}"`);
      console.log('Sox permissions successfully set!');
    } else {
      console.error('Sox binary not found in:', resourcesPath);
    }
  } catch (error) {
    console.error('Error setting Sox permissions:', error);
  }
  
  return Promise.resolve();
};