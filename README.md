# TransBuddy

TransBuddy is a macOS application that enables automatic speech-to-text transcription using a global hotkey. The app runs in the background, is accessible via the menu bar, and helps you quickly convert spoken language into text inserted at the current cursor position.

## Features

- **Global Hotkey:** F5 starts/stops recording
- **Floating Overlay:** Displays recording status with audio visualization
- **API Integration:** Supports ElevenLabs and OpenAI for speech recognition
- **Settings:** Configure API key and select audio input device
- **Direct Insertion:** Transcribed text is automatically inserted at the current cursor position

## Requirements

- Node.js and npm
- [Sox](http://sox.sourceforge.net/) for audio recording

## Installation

1. Clone or download the repository
2. Install dependencies:

npm install

3. Install Sox (if not already installed):

brew install sox

## Usage

1. Start the application:

npm start

2. Access settings via menu bar icon
3. Configure API key and audio input device
4. Press F5 to start recording
5. Press F5 again to stop and transcribe the recording

## Build App

To build a standalone app:

npm run build

The compiled app will be located in the `dist` folder.

## Get an API Key

- **ElevenLabs:** Sign up at [ElevenLabs](https://elevenlabs.io/) to get your API key
- **OpenAI:** Sign up at [OpenAI](https://platform.openai.com/signup) and generate an API key

## Notes

- The F5 shortcut is globally overridden, so the default macOS dictation function on F5 will be unavailable
- The app uses AppleScript to insert text at the cursor position, which may require Accessibility permissions