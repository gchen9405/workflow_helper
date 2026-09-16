"""Workflow helper demo, run locally with Flask.

  python run.py        then open http://127.0.0.1:8080/

The pipeline runs in the browser; this server serves the page and forwards its
LLM calls with the key added (app/routes/workflow_helper_routes.py). It listens
on 127.0.0.1 only. Settings are environment variables; see README.md.
"""
import os

from flask import Flask, redirect

from app.routes.workflow_helper_routes import bp

app = Flask(__name__)
app.register_blueprint(bp)


@app.route("/")
def home():
    return redirect("/api/workflow-helper/")


@app.route("/favicon.ico")
def favicon():
    return "", 204


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    missing = [name for name in ("KAIJU_LLM_ENDPOINT", "KAIJU_LLM_MODEL") if not os.environ.get(name, "").strip()]
    if missing:
        print(f"Not set: {', '.join(missing)}. The page answers {{\"error\": \"disabled\"}} until they are (see README.md).")
    print(f"Workflow helper demo: http://127.0.0.1:{port}/   (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=port, threaded=True)
