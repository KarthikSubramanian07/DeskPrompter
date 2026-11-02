# Privacy at DeskPrompter

Effective November 2, 2026.

DeskPrompter is built so that your scripts and your voice stay on your device. There are no accounts, no cookies, no advertising and no analytics. This page lists everything the app stores and every network connection it makes, so you can check for yourself.

## What stays on your device

- **Scripts** are saved in your browser's IndexedDB storage. They are never uploaded.
- **Settings** (mode, type size, mirroring and similar) are saved in your browser's localStorage.
- **Microphone audio** is processed inside the page. In voice mode, speech recognition runs on your device. In Breath mode, a voice detector only measures loudness and never transcribes.
- **Camera video** from the optional camera check is shown in the page and never recorded or sent anywhere.
- **Offline copy**: the app installs a service worker that stores its own files so it works without a connection.

Clearing your browser's site data for deskprompter.pages.dev removes all of it.

## Network connections

- **Hosting**: the site is served by Cloudflare Pages. Like any website, Cloudflare receives your IP address and browser details when you load a page, under Cloudflare's privacy policy.
- **Speech model download**: the first time voice mode uses the Moonshine model, your browser downloads it from download.moonshine.ai. That server sees a normal download request (your IP address), never your audio. The model is then cached on your device.
- **Chrome's on-device recognizer**: if Chrome downloads its own language pack, that download is handled by Chrome and Google.
- **Cloud recognition, only if you turn it on**: the "Allow cloud recognition" setting is off by default. If you enable it, your browser's own speech service processes your audio (Google for Chrome, Apple for Safari) under their terms. The setting says so before you choose it.
- **Phone remote, only when you pair**: pairing uses a small relay on Cloudflare Workers. It sees a random room code, temporary device IDs and connection details such as IP addresses, and it helps your phone and laptop connect directly using STUN servers run by Cloudflare and Google. Script text is sent only over the direct connection. If a direct connection is impossible, the relay passes button presses and timing, never the words. Rooms are deleted after an hour of inactivity.

## Children

DeskPrompter does not collect personal information from anyone, including children.

## Changes and questions

If this page changes, the effective date above will change and the history is public in the source repository: https://github.com/KarthikSubramanian07/DeskPrompter. Questions: https://deskprompter.pages.dev/contact
