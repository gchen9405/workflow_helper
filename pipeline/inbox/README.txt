DROP YOUR WORKFLOWS HERE
========================

Drag files into this folder, then double-click, in the folder above:

  macOS      Make improvement reports.command
  Windows    Make improvement reports.bat
  Linux      run "npm run inbox" in a terminal

What you can drop
-----------------
  Flowchart images    .png  .jpg  .jpeg  .webp  .gif
  Descriptions        .txt  .md

Anything else in this folder is ignored, including this file.

What happens
------------
  1. Each file runs through the whole pipeline: the workflow is extracted,
     improvement opportunities are found and ranked, and a report is written.
  2. If something is unclear, you are asked about it in the terminal window —
     first about the workflow itself (answer in your own words), then about
     each step (answer with the option number). Press Return to skip a
     question, or type "stop" to finish with what has been gathered.
  3. The report is written to  ../reports/<name>.report.md
     (open it in anything that shows Markdown; it is plain text.)
  4. The file you dropped is moved to  processed/  so this folder always
     shows only what is still waiting.

Skipped questions never block anything: the report still comes out whole,
opens with "This analysis is partial", and lists what is still unknown.

Nothing here is overwritten. Dropping the same filename twice keeps both.
