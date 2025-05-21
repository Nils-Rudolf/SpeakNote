// DOM Elements
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const toggleRecordingButton = document.getElementById('toggleRecording');
const closeButton = document.getElementById('closeButton');
const closeWindowButton = document.getElementById('closeWindowButton');
const errorMessage = document.getElementById('errorMessage');
const audioVisualizer = document.getElementById('audioVisualizer');

// Set a fixed height for the visualizer
audioVisualizer.style.height = '23px';

// Visualization context
const ctx = audioVisualizer.getContext('2d');
let recording = false;
let recordingStartTime = 0;
let timerInterval = null;
let animationFrame = null;

// New flags for better state management
let isUIFrozen = false; // Detects if the UI is frozen
let isRecoveryMode = false; // Flag for recovery mode
let lastCancelTime = 0; // Timestamp of the last cancellation

// Audio analysis variables
let audioContext = null;
let analyser = null;
let microphone = null;
let dataArray = null;
let bufferLength = 0;
let audioStream = null; // New variable to store the media stream

// Visualization variables
const visualizationHistory = [];
const maxVisualBars = 60; // How many bars should be displayed at maximum
const visualizationRate = 100; // 10 bars per second (100ms interval)
let visualizationInterval = null;

// Initialize the visualizer
function initVisualizer() {
  // Set canvas size
  function resizeCanvas() {
    const container = audioVisualizer.parentElement;
    audioVisualizer.width = container.clientWidth;
    audioVisualizer.height = 53;
  }
  
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // Initial drawing (static pattern for the beginning)
  drawStaticWaveform();
}

// Draw static waveform (only shown when no recording is in progress)
function drawStaticWaveform() {
  const width = audioVisualizer.width;
  const height = audioVisualizer.height;
  
  // Clear background
  ctx.clearRect(0, 0, width, height);
  
  // Instead of a single line, we draw fine, faintly visible vertical lines
  // as placeholders for the active visualization
  const barCount = maxVisualBars;
  const barWidth = 1;
  const spacing = Math.floor((width - (barCount * barWidth)) / (barCount - 1));
  const totalBarWidth = barWidth + spacing;
  
  // Style for static lines
  ctx.fillStyle = '#cccccc'; // Light gray color for inactive lines
  
  // Draw vertical lines across the entire width
  for (let i = 0; i < barCount; i++) {
    const x = i * totalBarWidth;
    const barHeight = height * 0.2; // 20% of the height
    const y = (height - barHeight) / 2; // Centered
    
    ctx.fillRect(x, y, barWidth, barHeight);
  }
}

// Real audio visualization with Web Audio API
async function setupAudioVisualization() {
  try {
    // If already initialized, reset
    if (audioContext) {
      await stopAudioAnalysis();
    }
    
    // Create audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    
    // Set FFT size for frequency analysis
    analyser.fftSize = 256;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    // Request microphone stream
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStream = stream; // Store the stream for later stopping
    
    // Connect microphone to audio context
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    
    // Start animation
    drawVisualization();
    
    // Start regular updates of audio data
    startVisualizationTimer();
    
    return true;
  } catch (error) {
    console.error('Audio visualization could not be initialized:', error);
    showError('Microphone access denied or not available');
    return false;
  }
}

// Stop audio analysis - with additional force option for emergency reset
async function stopAudioAnalysis(force = false) {
  // If force is enabled, reset all flags
  if (force) {
    isUIFrozen = false;
    isRecoveryMode = false;
  }
  
  try {
    // Immediately stop the animation
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    
    // Immediately stop all timers
    stopVisualizationTimer();
    
    if (microphone) {
      try {
        microphone.disconnect();
      } catch (e) {
        console.log('Error disconnecting the microphone:', e);
      }
      microphone = null;
    }
    
    // Immediately stop all tracks in the MediaStream
    if (audioStream) {
      try {
        const tracks = audioStream.getTracks();
        for (const track of tracks) {
          track.stop();
        }
      } catch (e) {
        console.log('Error stopping the audio tracks:', e);
      }
      audioStream = null;
    }
    
    // Audio context with higher priority close
    if (audioContext) {
      try {
        // In force mode, close without waiting for promises
        if (force) {
          try {
            audioContext.close();
          } catch (e) {}
          audioContext = null;
        } else {
          // Normal method with promise
          await audioContext.close().catch(e => console.error('Audio context error:', e));
          audioContext = null;
        }
      } catch (error) {
        console.error('Error closing the audio context:', error);
        audioContext = null;
      }
    }
    
    analyser = null;
    dataArray = null;
    
    // Immediately reset the visualization
    visualizationHistory.length = 0;
    drawStaticWaveform();
  } catch (e) {
    console.error('Error stopping audio analysis:', e);
    // In case of error in force mode, hard reset all references
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

// Animation function for microphone visualization
function animateMicrophone() {
  if (!analyser || !recording) return;
  
  animationFrame = requestAnimationFrame(animateMicrophone);
  
  // Get frequency data
  analyser.getByteFrequencyData(dataArray);
  
  // Calculate average amplitude
  let sum = 0;
  const sampleSize = Math.min(bufferLength, 32); // We only use a part of the spectrum
  for (let i = 0; i < sampleSize; i++) {
    sum += dataArray[i];
  }
  const averageAmplitude = sum / sampleSize / 255; // Normalize to 0-1
  
  drawVisualization();
}

// Draw the visualization of audio amplitude
function drawVisualization() {
  const width = audioVisualizer.width;
  const height = audioVisualizer.height;
  
  // Clear background
  ctx.clearRect(0, 0, width, height);
  
  // Parameters for visual display
  const barWidth = 2;
  const spacing = 3;
  const totalBarWidth = barWidth + spacing;
  const startX = 0;
  
  // Draw vertical bars from right to left
  ctx.fillStyle = '#000000'; // Black bars
  
  for (let i = 0; i < visualizationHistory.length; i++) {
    // Each bar is a vertical line whose height corresponds to 
    // the recorded amplitude at that time
    const barHeight = visualizationHistory[i] * height * 0.8; // 80% of maximum height
    
    // X position: from right to left
    const x = startX + i * totalBarWidth;
    
    // Y position: vertically centered
    const y = (height - barHeight) / 2;
    
    // Draw the bar
    ctx.fillRect(x, y, barWidth, barHeight);
  }
  
  // Fill the remaining space with static lines
  if (visualizationHistory.length < maxVisualBars) {
    const remainingBars = maxVisualBars - visualizationHistory.length;
    const offsetX = visualizationHistory.length * totalBarWidth;
    
    ctx.fillStyle = '#cccccc'; // Light gray for static bars
    
    for (let i = 0; i < remainingBars; i++) {
      const x = offsetX + i * totalBarWidth;
      const barHeight = height * 0.2; // 20% height for static bars
      const y = (height - barHeight) / 2;
      
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }
  
  // Continue animation
  if (recording) {
    animationFrame = requestAnimationFrame(drawVisualization);
  }
}

// Start regular updates of audio data
function startVisualizationTimer() {
  // Reset history and stop previous timers
  visualizationHistory.length = 0;
  
  // Ensure no previous timer is still running
  stopVisualizationTimer();
  
  // Regularly capture audio amplitude (10 times per second)
  visualizationInterval = setInterval(() => {
    if (!analyser || !recording) return;
    
    // Get frequency data
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate average amplitude
    let sum = 0;
    const sampleSize = Math.min(bufferLength, 32);
    for (let i = 0; i < sampleSize; i++) {
      sum += dataArray[i];
    }
    const averageAmplitude = sum / sampleSize / 255;
    
    // Add new amplitude to history (from right)
    visualizationHistory.unshift(averageAmplitude);
    if (visualizationHistory.length > maxVisualBars) {
      visualizationHistory.pop();
    }
  }, visualizationRate); // 100ms = 10 updates per second
}

// Stop regular updates
function stopVisualizationTimer() {
  if (visualizationInterval) {
    clearInterval(visualizationInterval);
    visualizationInterval = null;
  }
}

// Update timer
function updateTimer() {
  if (!recording) return;
  
  const elapsedTime = Date.now() - recordingStartTime;
  const seconds = Math.floor(elapsedTime / 1000) % 60;
  const minutes = Math.floor(elapsedTime / 60000);
  
  timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Start recording
async function startRecording() {
  // Check if we are in recovery mode or if the time since the last cancellation is too short
  const timeSinceLastCancel = Date.now() - lastCancelTime;
  const needsCooldown = timeSinceLastCancel < 800;
  
  if (isRecoveryMode || needsCooldown) {
    console.log('Do not start immediately after cancellation - Cool-down active');
    // Add a short delay to allow audio resources to be released
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Before restarting, ensure all audio resources have been released
    await stopAudioAnalysis(true);
  }
  
  // Now set all status flags
  recording = true;
  isUIFrozen = false;
  recordingStartTime = Date.now();
  
  // Update UI
  statusText.textContent = 'Recording';
  toggleRecordingButton.classList.add('recording');
  
  try {
    // Start audio visualization - with error handling
    const visualizationSuccess = await setupAudioVisualization();
    if (!visualizationSuccess) {
      console.error('Audio visualization could not be initialized');
      // Still proceed, but set a flag that we might have issues
      isUIFrozen = true;
    }
    
    // Start timer
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer(); // Update immediately
    
    // Reset errors
    hideError();
  } catch (error) {
    console.error('Error starting recording (UI):', error);
    // For safety, transition to a "frozen" state so that the emergency reset works
    isUIFrozen = true;
  }
}

// Stop recording
async function stopRecording() {
  recording = false;
  
  // Update UI
  statusText.textContent = 'Transcribing';
  toggleRecordingButton.classList.remove('recording');
  
  // Stop timer
  clearInterval(timerInterval);
  
  // Stop audio analysis
  await stopAudioAnalysis();
}

// Reset all UI elements to their initial state
function resetUI() {
  // Reset timer
  timer.textContent = '0:00';
  
  // Reset status
  statusText.textContent = 'Start Recording';
  
  // Reset recording status
  recording = false;
  toggleRecordingButton.classList.remove('recording');
  
  // Hide error
  hideError();
  
  // Draw static waveform
  drawStaticWaveform();
}

// Close window
function closeWindow() {
  window.electronAPI.closeOverlay();
}

// Toggle recording
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

// Show error message
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('visible');
  statusText.style.opacity = '0'; // Hide status text when error is displayed
}

// Hide error message
function hideError() {
  errorMessage.classList.remove('visible');
  statusText.style.opacity = '1'; // Show status text again
}

// Event listeners
toggleRecordingButton.addEventListener('click', toggleRecording);

// Cancel button stops the recording but does NOT close the window
closeButton.addEventListener('click', async () => {
  console.log('[DEBUG] Cancel button clicked');
  
  try {
    // Immediately change status and update UI
    recording = false;
    statusText.textContent = 'Canceled';
    console.log('[DEBUG] Status set to "Canceled"');
    
    // Immediately stop timer and visualization
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      console.log('[DEBUG] Timer stopped');
    }
    
    // Stop all timers and animations
    stopVisualizationTimer();
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      console.log('[DEBUG] Animations stopped');
    }
    
    // Completely stop audio analysis
    if (audioStream) {
      try {
        const tracks = audioStream.getTracks();
        tracks.forEach(track => track.stop());
        console.log('[DEBUG] Audio tracks stopped: ' + tracks.length);
      } catch (e) {
        console.error('[DEBUG] Error stopping audio tracks:', e);
      }
      audioStream = null;
    }
    
    if (audioContext) {
      try {
        await audioContext.close();
        console.log('[DEBUG] AudioContext closed');
      } catch (e) {
        console.error('[DEBUG] Error closing AudioContext:', e);
      }
      audioContext = null;
    }
    
    microphone = null;
    analyser = null;
    
    // Reset UI
    drawStaticWaveform();
    toggleRecordingButton.classList.remove('recording');
    timer.textContent = '0:00';
    
    // Send cancellation to the main process
    console.log('[DEBUG] Sending cancelRecording to main process');
    const result = await window.electronAPI.cancelRecording();
    console.log('[DEBUG] Result from cancelRecording:', result);
    
    // Reset UI after a short time, but do NOT close the window
    setTimeout(() => {
      resetUI();
      console.log('[DEBUG] UI reset after cancellation');
    }, 1000);
  } catch (error) {
    console.error('[DEBUG] Error during cancellation:', error);
    // Reset UI despite error
    resetUI();
  }
});

// Apple-style X button closes the window
closeWindowButton.addEventListener('click', async () => {
  // Stop recording if active
  if (recording) {
    try {
      // Immediately update UI
      recording = false;
      statusText.textContent = 'Stopped';
      
      // Immediately release all audio resources
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      
      stopVisualizationTimer();
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      
      // Stop audio stream
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
      
      // Notify main process
      await window.electronAPI.cancelRecording();
      
      // Close directly
      window.electronAPI.closeOverlay();
    } catch (error) {
      console.error('Error closing with X:', error);
      // Close despite error
      window.electronAPI.closeOverlay();
    }
  } else {
    // If no recording is active, just close
    window.electronAPI.closeOverlay();
  }
});

// ESC key to close the window
document.addEventListener('keydown', (event) => {
  console.log('Key pressed:', event.key); // Added debug log
  if (event.key === 'Escape') {
    console.log('ESC was pressed! Attempting to close window...'); // Debug log
    // Stop recording if active
    if (recording) {
      window.electronAPI.cancelRecording().then(() => {
        closeWindow();
      }).catch(error => {
        console.error('Error stopping recording:', error);
        closeWindow();
      });
    } else {
      closeWindow();
    }
  }
});

// Event listeners for recording events
window.electronAPI.onRecordingStarted(() => {
  startRecording();
});

window.electronAPI.onRecordingStopped(() => {
  stopRecording();
});

window.electronAPI.onCancelRecordingDirect(() => {
  console.log('[DEBUG] cancel-recording-direct event received');
  
  // Immediate measures for error handling
  try {
    // Immediately reset status
    recording = false;
    
    // Hard stop timer
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      console.log('[DEBUG] Timer stopped in cancel-direct');
    }
    
    // Immediately stop animation
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      console.log('[DEBUG] Animation stopped in cancel-direct');
    }
    
    // Immediately stop visualization timer
    stopVisualizationTimer();
    console.log('[DEBUG] Visualization timer stopped in cancel-direct');
    
    // Directly stop audio stream
    if (audioStream) {
      const tracks = audioStream.getTracks();
      tracks.forEach(track => {
        try {
          track.stop();
          console.log('[DEBUG] Audio track stopped in cancel-direct');
        } catch (e) {
          console.error('[DEBUG] Error stopping audio track:', e);
        }
      });
      audioStream = null;
    }
    
    // Directly close audio context without waiting for promise
    if (audioContext) {
      try {
        audioContext.close();
        console.log('[DEBUG] AudioContext closed in cancel-direct');
      } catch (e) {
        console.error('[DEBUG] Error closing AudioContext:', e);
      }
      audioContext = null;
    }
    
    // Clear other audio references
    microphone = null;
    analyser = null;
    dataArray = null;
    
    // Clear visualization history
    visualizationHistory.length = 0;
    
    // Redraw static pattern
    drawStaticWaveform();
    
    // Update UI status
    statusText.textContent = 'Start Recording';
    toggleRecordingButton.classList.remove('recording');
    timer.textContent = '0:00';
    
    console.log('[DEBUG] UI fully reset in cancel-direct');
    
    // Fully reset UI after a short delay
    setTimeout(() => {
      resetUI();
      console.log('[DEBUG] resetUI called after cancel-direct');
    }, 500);
  } catch (error) {
    console.error('[DEBUG] Error in cancel-direct handler:', error);
    // Reset UI despite error
    resetUI();
  }
});

window.electronAPI.onTranscriptionStarted(() => {
  statusText.textContent = 'Transcribing';
});

window.electronAPI.onTranscriptionCompleted(() => {
  statusText.textContent = 'Complete';
  
  // Reset status after a short time
  setTimeout(() => {
    resetUI();
  }, 2000);
});

window.electronAPI.onRecordingError((data) => {
  stopRecording();
  showError(data.message || 'Recording error');
  
  // Return to initial state after a short time
  setTimeout(() => {
    resetUI();
  }, 3000);
});

window.electronAPI.onTranscriptionError((data) => {
  statusText.textContent = '';
  showError(data.message || 'Transcription error');
  
  // Return to initial state after a short time
  setTimeout(() => {
    resetUI();
  }, 3000);
});

// Text insertion
window.electronAPI.onTextInserted(() => {
  statusText.textContent = 'Text inserted';
  
  // Reset status after a short time
  setTimeout(() => {
    resetUI();
  }, 2000);
});

// Initialize visualization
initVisualizer();

// Set initial timer value and display status
resetUI();