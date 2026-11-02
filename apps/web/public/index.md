# DeskPrompter: a free teleprompter that listens

DeskPrompter is a free, open-source teleprompter that runs in your browser. It scrolls when you speak and waits when you pause. Skip a line, ad-lib or go back for another take, and it finds your place again. It works offline, needs no account, and never uploads your script or your voice.

Open the studio: https://deskprompter.pages.dev/studio

## Three ways to scroll

- **Voice**: follows your words. Speech recognition runs on your device, using Chrome's on-device recognizer or the open-source Moonshine model in WebAssembly. A Rust engine matches what you say to the script, word by word.
- **Breath**: no transcription at all. A tiny voice detector scrolls while you talk and glides to a stop when you pause.
- **Steady**: a smooth glide at a pace you set in words per minute.

## Built for real recording setups

- **Phone remote**: scan a QR code and your phone becomes the clicker, connected directly to your laptop.
- **Ready for the glass**: mirror the text for beam-splitter rigs, put the reading line under the lens, and open a talent window on a second screen.
- **Captions**: every word you read in voice mode is timed; download SRT or VTT for your editor.
- **Phones and tablets**: touch scrolling, a screen that stays awake on stage, and full settings on small screens.

## Private by design

Scripts are stored in your browser. Your microphone audio is processed on your device. There are no accounts, cookies, ads or analytics. Read the details: https://deskprompter.pages.dev/privacy

## Links

- Studio: https://deskprompter.pages.dev/studio
- About: https://deskprompter.pages.dev/about
- Contact: https://deskprompter.pages.dev/contact
- Source code (MIT): https://github.com/KarthikSubramanian07/DeskPrompter
- For agents: https://deskprompter.pages.dev/llms.txt
