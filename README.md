# SpeakNote

A alternative to macOS dictation with better speech-to-text transcription across multiple languages on F5 shortcut, as Apple's built-in dictation feature sucks.
The app runs in the background, is accessible via the menu bar, and helps you quickly convert spoken language into text inserted at the current cursor position.

## Features

- **Global Hotkey:** F5 starts/stops recording (replacing the default macOS dictation function)
- **Floating Overlay:** Displays recording status with audio visualization
- **API Integration:** Supports OpenAI Whisper for speech recognition
- **Settings:** Configure API key and select audio input device
- **Direct Insertion:** Transcribed text is automatically inserted at the current cursor position

## Installation

### Option 1: Download DMG

1. Go to the [Releases](https://github.com/Nils-Rudolf/SpeakNote/releases) page
2. Download the appropriate DMG for your Mac:
   - For Apple Silicon Macs (M1/M2/M3...): Download the arm64 version
   - For Intel Macs: Download the x64 version

### Option 2: Build from Source

#### Requirements

- Node.js and npm
- [Sox](http://sox.sourceforge.net/) for audio recording
- Xcode Command Line Tools (for building native dependencies)

#### Build Steps

1. Clone the repository:
   ```
   git clone https://github.com/Nils-Rudolf/SpeakNote.git
   cd SpeakNote
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Install Sox if not already installed:
   ```
   brew install sox
   ```

4. Build the application:
   ```
   npm run build
   ```
   
   For specific architectures:
   ```
   npm run build-arm64    # For Apple Silicon Macs
   npm run build-x64      # For Intel Macs
   ```

5. The compiled app will be located in the `dist` folder.

## Usage

1. Start the application from your Applications folder
2. Allow access to the microphone and accessibility in the settings
3. Configure API key and audio input device
4. Press F5 to start recording
5. Press F5 again to stop and transcribe the recording

## API Setup

### OpenAI Whisper
1. Sign up at [OpenAI](https://platform.openai.com/api-keys)
2. Generate an API key
3. Enter the API key in SpeakNote settings

## Notes

- The F5 shortcut is globally overridden, so the default macOS dictation function on F5 will be unavailable