# TransBuddy

# macOS Productivity Voice App (Electron + 11Labs + OpenAI)

A minimalist voice capture utility for macOS that allows you to record speech globally using the F5 key, transcribe it via the 11Labs Speech-to-Text API, and insert the result directly into the current cursor position — regardless of the active application.

---

## Technology Stack

| Functionality      | Tool/Library                      |
|--------------------|-----------------------------------|
| Framework          | Electron                          |
| Global Hotkey      | iohook, electron-localshortcut    |
| Audio Capture      | node-record-lpcm16, mic           |
| STT Integration    | 11Labs Speech-to-Text API         |
| UI                 | HTML, CSS, JavaScript             |
| Text Insertion     | robotjs, nut.js                   |
| Config Management  | config.json                       |

---

## Project Structure

my-macOS-voice-app/
├── main.js             # Electron main process
├── preload.js          # Secure bridge to renderer
├── renderer/           # HTML/CSS/JS UI files
├── config.json         # Audio device & API key settings
├── package.json        # Project metadata and dependencies
├── assets/             # Icons, audio assets, etc.
└── README.md           # This documentation
