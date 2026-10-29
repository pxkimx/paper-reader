# Paper Reader

A reading desk for scientific papers that runs on your Mac. Drop in a PDF and get a reading guide straight away:
abstract, the authors' main findings, an outline, every figure with its picture, panels, statistics and the
sentences that discuss it, the methods, and every abbreviation. Then mark the paper up in your own hand:
highlights with comments, sticky notes and a pen, in handwriting fonts. Export the marked-up PDF or your reading notes.

**Page:** https://paul-h-kim.com/software/paper-reader

- **AI breakdown (optional):** plain-language summary, each figure dissected panel by panel, a glossary, the methods
  explained, and answers to your questions. It runs through Claude Code signed in with your own Claude plan
  (no API key), or by copying a prompt into Claude.ai.
- **Reading tools:** hover a citation to see the reference, add open-access papers by DOI or arXiv ID,
  search the paper and your library, dictionary and Wikipedia look-ups, a figure viewer.
- **11 visual styles** and a **Light | Dark** switch.
- Your papers, notes and analyses stay on your Mac in `~/Library/Application Support/PaperReader/`.
  Closing the browser tab quits the app completely.

## Run it

Needs macOS and Python 3.10–3.13 (python.org recommended).

```bash
git clone https://github.com/pxkimx/paper-reader.git
cd paper-reader
source/build_mac.sh        # builds "Paper Reader.app" next to this README
open "Paper Reader.app"
```

The first start creates a private Python environment in `~/Library/Application Support/PaperReader/venv`
(about a minute, needs internet) and opens http://localhost:8769. `Start Paper Reader.command` runs the same thing in a Terminal window. See `README-FIRST.txt` for everyday use and `source/README.md`
for how it works.

## Tests

```bash
cd source
"$HOME/Library/Application Support/PaperReader/venv/bin/python" -m unittest discover tests -v
```

They use a throwaway library and a stand-in for Claude Code, so they never touch your papers or your Claude plan.

## Licence

MIT, Copyright (c) 2026 Paul H. Kim. Bundled third-party code and fonts keep their own licences:
see `THIRD_PARTY_LICENSES.md`.
