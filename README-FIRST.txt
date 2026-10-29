Paper Reader — how to start
===========================

1. Double-click "Paper Reader.app". (You can move it anywhere, e.g. Applications or the Dock.)

2. First open only — macOS may say the app "cannot be verified" because it is not signed with a
   paid Apple developer certificate. Fix it once: right-click the app -> Open -> Open.
   (Or in Terminal: type  xattr -cr  and a space, drag the app into the window, press Return.)

3. The first launch installs its packages into
   ~/Library/Application Support/PaperReader   (about a minute, needs internet).
   Later launches take a few seconds. Your browser opens http://localhost:8769 and the Paper Reader
   icon stays in the Dock while it is open. It uses its own port (8769), side by side with the Bench apps.

   Closing it: close its browser tab (or window) and Paper Reader quits completely a few seconds later,
   including any AI analysis still running (the page asks first). Reloading the page does not quit it.
   Quitting the Dock icon, or "Quit Paper Reader" on the library page, also stops it. If the browser
   crashes, it stops by itself after about four minutes. "Stop Paper Reader.command" is only a backup.

4. No API key needed. Every paper gets a built-in reading guide straight away (abstract,
   findings, outline, every figure with its picture, panels, statistics and the sentences that
   discuss it, methods, abbreviations). For the full plain-language AI breakdown, press
   "✨ Get AI breakdown with Claude.ai": copy the prompt, attach the PDF in Claude.ai, paste
   Claude's reply back. (Optional: an Anthropic API key in ⚙ Settings does this automatically.)

5. Handy: paste a DOI or arXiv ID in the library to download an open-access paper; hover [12] in a paper to see
   the reference; ⌘F to search; F for the figure viewer; Export ▾ for reading notes; ? for all shortcuts.

6. Pick a look: ⚙ Settings -> Style, or compare all 11 side by side at http://localhost:8769/styles

Works offline: the built-in guide, search, highlighting, comments, sticky notes, pen, PDF export,
and 📖 Dictionary look-ups. Needs internet: Claude.ai, Wikipedia look-ups, the optional API.
Your papers, analyses and notes are kept in ~/Library/Application Support/PaperReader/data,
so updating or moving the app never loses them.

If the app will not open at all: double-click "Start Paper Reader.command" instead —
it runs the same thing inside a Terminal window so you can see every message.
The log is at ~/Library/Application Support/PaperReader/paper-reader.log

Needs Python 3.10–3.13 (python.org recommended).
