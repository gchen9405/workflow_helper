# Workflow helper: local demo

Runs the workflow helper in your browser, on this computer. `run.py` is a small Flask server. It serves the page and forwards the page's LLM calls to your LLM endpoint with the key added, so the key never reaches the browser. It listens on `127.0.0.1` only, so nobody else can open it.

## Setup (once)

You need Python 3.9 or newer, and Flask:

```powershell
python --version
python -c "import flask; print(flask.__version__)"     # if this prints a version, skip the next line
python -m pip install -r requirements.txt               # add --user if it says permission denied
```

## Run it

In PowerShell, in this folder (`workflow_helper\demo`):

```powershell
$env:KAIJU_LLM_ENDPOINT = "<LLM endpoint, e.g. https://llm-host/v1>"
$env:KAIJU_LLM_MODEL = "<model name>"
$env:KAIJU_LLM_API_KEY = Read-Host "Paste the LLM key"   # a prompt keeps the key out of PowerShell's history
python run.py
```

Open **http://127.0.0.1:8080/**.
- **To stop:** press Ctrl+C, then close the window, because the key stays in that window's environment until you do.
- **The "development server" warning** Flask prints is expected.

**Images:** before `python run.py`, also set `$env:KAIJU_LLM_VISION_MODEL`: to the model's own name if it accepts images, or to a separate vision model's name. Without it, the page accepts text only.

**Try it** with the files in `test-inputs\`:
- `order-fulfillment.txt`, pasted into the box: a full report
- `thin.txt`: questions in both stages; try Skip these, Continue, and Finish with what you have
- `not-a-workflow.txt`: a short notice
- a flowchart screenshot, dropped or pasted onto the page (needs a vision model set)

## Update

`git pull`, then start `python run.py` again.

## If something goes wrong

- **`{"error": "disabled"}` instead of the page:** `KAIJU_LLM_ENDPOINT` or `KAIJU_LLM_MODEL` isn't set in the window running `run.py`.
- **`address already in use` or `access a socket in a way forbidden`:** port 8080 is taken. Set `$env:PORT = "8090"`, run again, and open http://127.0.0.1:8090/.
- **A run fails:** the page shows "Failed while: <stage>" and "The proxy answered HTTP <status>", sometimes with a code. For details, press F12 → **Network** → click the failed `completions` request (red) → **Response**.
  - `HTTP 504 (llm_timeout)` after about 2 minutes: the LLM never answered. Check the VPN and the endpoint.
  - `HTTP 502 (llm_unreachable)`: read `detail` in the Response.
    - `getaddrinfo failed` or `did not properly respond`: wrong host, or not on the VPN
    - `refused`: wrong port
    - `CERTIFICATE_VERIFY_FAILED`: set `$env:KAIJU_LLM_CA_BUNDLE` to the path of your org's CA certificate (a `.pem` file), then restart
    - `Tunnel connection failed`: a web proxy is in the way. Set `$env:NO_PROXY = "<LLM host name>"`, then restart.
    - `unknown url type`: the endpoint is missing `https://`
  - `HTTP 401` or `HTTP 403`: the LLM rejected the key.
  - `HTTP 404` or `HTTP 400`: read the Response; usually a wrong endpoint path or model name.
  - "could not reach … Failed to fetch": the server isn't running. Check its window.

## About the files

- `app/routes/workflow_helper_routes.py` is the server logic.
- `app/workflow_helper/` holds the page and the pipeline bundle. The bundle is generated from this repo (commit `2f1ce88`) with `cd pipeline && npm run setup && node scripts/build-browser.mjs --minify`. Don't edit it by hand; rebuild it.
