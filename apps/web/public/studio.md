# DeskPrompter Studio

The studio is where you write a script and read it. It is a web app: open https://deskprompter.pages.dev/studio in Chrome, Edge, Safari or Firefox. Scripts are saved in your browser and never uploaded.

## Write a script

- Separate paragraphs with a blank line.
- Start a section with `# Heading`. Headings are shown on stage but not read.
- Put stage directions in square brackets, like `[pause]` or `[smile]`. Cues are shown but never tracked.
- Or drop a `.txt` or `.md` file onto the desk. Markdown headings become sections and formatting is removed.

## Read it

Press **Start** to open the reading screen, then press play (or Space).

- **Voice follow** keeps your place as you speak. It uses an on-device recognizer, downloading the Moonshine model (about 51 MB) the first time if needed.
- **Talk to scroll** moves while you talk and pauses when you stop.
- **Auto scroll** moves at a steady speed you choose.

## Keyboard shortcuts on stage

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Up / Down | Faster or slower (lines in voice mode) |
| Left / Right | Back or forward a line |
| Page Up / Page Down | Back or forward a paragraph (presentation clickers) |
| Home | Back to the top |
| 1, 2, 3 | Auto scroll, Voice follow or Talk to scroll |
| M | Flip text for teleprompter glass |
| F | Fullscreen |
| + / - | Bigger or smaller type |
| ? | Show all shortcuts |
| Esc | Back to editing |

## Open a script from a link

Agents and other tools can open a script directly. The script travels in the URL fragment, which browsers never send to a server:

`https://deskprompter.pages.dev/studio#title=<url-encoded title>&script=<url-encoded script>`

## More

- Phone remote: choose **Phone remote** and scan the code with your phone's camera.
- Second screen: choose **Second screen** to open the script in a window you can move to another display.
- Captions: after reading in Voice follow mode, pause and download SRT or VTT.
