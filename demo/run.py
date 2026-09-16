"""Workflow helper demo, run locally with Flask.

  python run.py        then open http://127.0.0.1:8080/

The pipeline runs in the browser; this server serves the page and forwards its
LLM calls with the key added (app/routes/workflow_helper_routes.py). It listens
on 127.0.0.1 only, unless HOST says otherwise (HOST=0.0.0.0 on OpenShift).
Settings are environment variables, set in the window or kept in a `.env` file
(env_file.py); see README.md.
"""
import os

from env_file import load_env_files

# Before the blueprint import below: it reads KAIJU_LLM_* as it loads, and
# again on every request.
ENV_FILES, ENV_ALIASES = load_env_files()

from flask import Flask, redirect  # noqa: E402  (after load_env_files, on purpose)

from app.routes.workflow_helper_routes import bp  # noqa: E402

app = Flask(__name__)
app.register_blueprint(bp)


@app.route("/")
def home():
    return redirect("/api/workflow-helper/")


@app.route("/favicon.ico")
def favicon():
    return "", 204


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    for path, names in ENV_FILES:
        # Names only, never values: this line must not be able to print the key.
        taken = ", ".join(names) if names else "nothing new (the window already sets these)"
        print(f"Read {path}: {taken}")
    for alias in ENV_ALIASES:
        print(f"Using {alias}")
    missing = [name for name in ("KAIJU_LLM_ENDPOINT", "KAIJU_LLM_MODEL") if not os.environ.get(name, "").strip()]
    if missing:
        print(f"Not set: {', '.join(missing)}. The page answers {{\"error\": \"disabled\"}} until they are (see README.md).")
    print(f"Workflow helper demo: http://127.0.0.1:{port}/   (Ctrl+C to stop)")
    app.run(host=host, port=port, threaded=True)
