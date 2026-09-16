# Workflow helper: local demo

Runs the workflow helper in your browser, on this computer. `run.py` is a small Flask server. It serves the page and forwards the page's LLM calls to your LLM endpoint with the key added, so the key never reaches the browser. It listens on `127.0.0.1` only, so nobody else can open it. To give coworkers a URL, see [Share it on OpenShift](#share-it-on-openshift).

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

## Keep the settings in a file (so you don't paste them every time)

Instead of the `$env:` lines above, put the settings in `demo\.env`:

```
KAIJU_LLM_ENDPOINT=https://llm-host/v1
KAIJU_LLM_MODEL=<model name>
KAIJU_LLM_API_KEY=<the key>
KAIJU_LLM_VISION_MODEL=<model name, for images>
```

`python run.py` reads it at startup and prints which names it took, never their values. Notes:

- **Git ignores `.env`**, so the key stays on this machine. Anyone who can read the file can read the key, so keep it out of shared folders.
- **Everything after `=` is the value.** Don't put a trailing `# comment` on a line; it becomes part of the value.
- **A variable set in the window wins** over the file, which is handy for trying another model for one run.
- **A repo-root `.env` works too.** If you already have one for the TypeScript CLI, its `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY` fill in the `KAIJU_LLM_*` settings when those aren't set, so one file can drive both.
- **Ignore Flask's tip** that says "There are .env files present. Install python-dotenv to use them." The file has already been read by then; nothing to install.

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

## Share it on OpenShift

This gives the demo its own URL for coworkers. OpenShift builds it straight from this repo on GitHub, so you only need the web console, not `oc`. There's no login: anyone who can open the URL can use the tool, and through it your LLM key.

**Before you start:** commit and push this repo to GitHub. The cluster builds what's on GitHub, not what's on your laptop.

1. **Create a project**, or pick one you can deploy to.
2. **Store the key in a Secret.** Go to **Secrets → Create → Key/value secret**.
   - **Name:** `workflow-helper-llm`
   - **Key:** `KAIJU_LLM_API_KEY`
   - **Value:** the key
3. **Import the app.** Open **+Add → Import from Git**. In newer consoles, it's the **+** icon at the top.
   - **Git Repo URL:** `https://github.com/gchen9405/workflow_helper`
   - **Show advanced Git options → Context dir:** `/demo`
   - **Builder image:** Python (it's usually detected on its own). Any version 3.9 or newer works.
   - **Name:** `workflow-helper`
   - **Resource type:** Deployment
   - **Target port:** `8080`. Leave **Create a route** checked.
4. **Add the settings.** Before you click Create, open **Deployment** in the advanced options at the bottom of the form, and add these environment variables:

   | Name | Value |
   |---|---|
   | `APP_FILE` | `run.py` |
   | `HOST` | `0.0.0.0` |
   | `KAIJU_LLM_ENDPOINT` | the endpoint, as in your `.env` |
   | `KAIJU_LLM_MODEL` | the model name |
   | `KAIJU_LLM_VISION_MODEL` | the vision model name (optional, for images) |

   For the key, click **Add from ConfigMap or Secret**. Set the name to `KAIJU_LLM_API_KEY`, then pick the `workflow-helper-llm` secret and its key.

   Then click **Create**.
5. **Wait for the build.** It takes a few minutes. Watch **Builds → workflow-helper → Logs**. It's done when the pod shows **Running**.
6. **Raise the Route timeout.** LLM calls can take longer than the Route's default of 30 seconds. Go to **Networking → Routes → workflow-helper → Actions → Edit annotations**, and add:
   - **Key:** `haproxy.router.openshift.io/timeout`
   - **Value:** `300s`
7. **Open the Route's Location URL** and try the test inputs. That URL is the one to share.

**Update:** push to GitHub, then go to **Builds → workflow-helper → Actions → Start build**. The new pod replaces the old one when the build finishes.

**If something goes wrong:**
- **The build fails cloning the repo:** the cluster can't reach GitHub. Build from your laptop with `oc` instead.
- **The build fails at `pip install`:** the cluster can't reach PyPI. Ask the cluster admins for their Python package mirror URL, and add it as the build environment variable `PIP_INDEX_URL`. In the console, that's **BuildConfig → Environment**. Then start the build again.
- **The page loads, but a run fails with `HTTP 502 (llm_unreachable)`:** the pod can't reach the LLM. Read `detail` as described under [If something goes wrong](#if-something-goes-wrong).
- **A run fails after exactly 30 seconds:** step 6 is missing.
- **Changed a setting?** Edit it under **Deployment → Environment**. The pod restarts on its own.

## About the files

- `app/routes/workflow_helper_routes.py` is the server logic.
- `app/workflow_helper/` holds the page and the pipeline bundle. The bundle is generated from this repo (commit `2f1ce88`) with `cd pipeline && npm run setup && node scripts/build-browser.mjs --minify`. Don't edit it by hand; rebuild it.
