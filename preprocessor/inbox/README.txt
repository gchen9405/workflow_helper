DROP YOUR WORKFLOWS HERE
========================

Drag files into this folder, then double-click, in the folder above:

  macOS      Process workflows.command
  Windows    Process workflows.bat
  Linux      run "npm run inbox" in a terminal

What you can drop
-----------------
  Flowchart images    .png  .jpg  .jpeg  .webp  .gif
  Descriptions        .txt  .md

Anything else in this folder is ignored, including this file.

What happens
------------
  1. Each file is turned into a structured workflow schema.
  2. If something about the process is unclear, you are asked about it in the
     terminal window — type an answer, press Return to skip a question, or
     type "stop" to finish with what has been gathered.
  3. The schema is written to  ../results/<name>.json
  4. The file you dropped is moved to  processed/  so this folder always
     shows only what is still waiting.

Each result ends in one of three states, and says which:
  validated  — complete, nothing left unknown
  partial    — usable, with the open questions listed in the JSON
  rejected   — the input was not a workflow, and it says why

Nothing here is overwritten. Dropping the same filename twice keeps both.
