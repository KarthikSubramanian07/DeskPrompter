# About DeskPrompter

DeskPrompter is a free, open-source teleprompter that runs in the browser and follows your voice. It was built by Karthik Subramanian and is published under the MIT license, so anyone can use it, read the code, or run their own copy.

## Why it exists

Good teleprompters usually keep their best feature, scrolling that follows your voice, behind a subscription, because the listening happens on someone else's server. DeskPrompter does the listening on your own device instead. That makes it free to run and private by default: your script and your voice never leave your computer, phone or tablet.

## How it works

- A speech recognizer on your device turns what you say into words: Chrome's on-device recognizer when it is available, otherwise the open-source Moonshine model compiled to WebAssembly.
- A matching engine written in Rust and compiled to WebAssembly compares those words with your script. It handles skipped lines, ad-libs, misheard words and repeated phrases without jumping around.
- A voice detector written in Zig runs on the audio thread. It powers Breath mode, which scrolls while you talk and stops when you pause, with no transcription at all.
- A small relay written in Rust on Cloudflare introduces your phone to your laptop for the phone remote. After that, they talk directly.

## Who it is for

Creators recording videos, teachers recording lessons, speakers rehearsing talks, people presenting on video calls, and anyone with a beam-splitter teleprompter rig who wants mirrored text and a separate talent screen.

## Project

- Website: https://deskprompter.pages.dev
- Source code: https://github.com/KarthikSubramanian07/DeskPrompter
- License: MIT
- Contact: https://deskprompter.pages.dev/contact
