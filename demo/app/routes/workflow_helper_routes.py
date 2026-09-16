"""Workflow helper demo: the page, its bundle, and the LLM forward.

The workflow_helper pipeline runs in the browser. This blueprint serves its
page and bundle from backend/app/workflow_helper/ behind the site's login,
and forwards the page's chat-completion calls to the LLM with the model and
the key set here. Standard library only. A bare demo: apart from `model`,
the request body is forwarded as received, with no allow-list, size caps,
rate limit or error mapping.

Settings are environment variables, read on every request:

  KAIJU_LLM_ENDPOINT         Base URL, e.g. https://<llm-host>/v1; "/chat/completions"
                             is appended unless already there. Unset: the feature is
                             off and every route except /config answers 404.
  KAIJU_LLM_MODEL            Model name. Unset: the feature is off.
  KAIJU_LLM_API_KEY          Bearer key, from a Secret. Omitted when unset.
  KAIJU_LLM_VISION_MODEL     Model for calls that carry an image. Setting it turns image
                             input on in the page; if the main model accepts images,
                             set it to the main model's name.
  KAIJU_LLM_VISION_ENDPOINT  Defaults to KAIJU_LLM_ENDPOINT.
  KAIJU_LLM_VISION_API_KEY   Defaults to KAIJU_LLM_API_KEY.
  KAIJU_LLM_TIMEOUT_SECONDS  Upstream timeout per socket wait, default 120. Keep it
                             below the Route timeout.
  KAIJU_LLM_CA_BUNDLE        CA PEM path, only if the LLM host's certificate isn't trusted.
"""
import http.client
import json
import logging
import os
import socket
import ssl
import urllib.error
import urllib.request
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_from_directory

from ..auth_decorators import login_required

bp = Blueprint("workflow_helper", __name__, url_prefix="/api/workflow-helper")
log = logging.getLogger(__name__)

# backend/app/workflow_helper/ holds index.html, workflow-helper.js and its map.
# Deliberately not under a folder named "static", which Flask serves without login.
PAGE_DIR = str(Path(__file__).resolve().parent.parent / "workflow_helper")


def _env(name):
    # Stripped, so a trailing newline in a Secret can't break the Authorization header.
    return os.environ.get(name, "").strip()


def _enabled():
    return bool(_env("KAIJU_LLM_ENDPOINT") and _env("KAIJU_LLM_MODEL"))


if _env("KAIJU_LLM_ENDPOINT") and not _env("KAIJU_LLM_MODEL"):
    log.warning("workflow helper is off: KAIJU_LLM_ENDPOINT is set but KAIJU_LLM_MODEL is not")


def _disabled():
    return jsonify(error="disabled"), 404


def _serve(name, mimetype):
    if not _enabled():
        return _disabled()
    # The type is explicit because Python's guess for .js can be text/plain on
    # Windows, and browsers refuse to run a module served that way.
    response = send_from_directory(PAGE_DIR, name, mimetype=mimetype)
    response.headers["Cache-Control"] = "no-cache"
    return response


def _has_image(body):
    messages = body.get("messages")
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(m, dict)
        and isinstance(m.get("content"), list)
        and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m["content"])
        for m in messages
    )


def _target(has_image):
    """(endpoint, model, key) for this call: the vision settings when it carries an image."""
    if has_image and _env("KAIJU_LLM_VISION_MODEL"):
        return (
            _env("KAIJU_LLM_VISION_ENDPOINT") or _env("KAIJU_LLM_ENDPOINT"),
            _env("KAIJU_LLM_VISION_MODEL"),
            _env("KAIJU_LLM_VISION_API_KEY") or _env("KAIJU_LLM_API_KEY"),
        )
    return _env("KAIJU_LLM_ENDPOINT"), _env("KAIJU_LLM_MODEL"), _env("KAIJU_LLM_API_KEY")


def _chat_url(endpoint):
    base = endpoint.rstrip("/")
    return base if base.endswith("/chat/completions") else base + "/chat/completions"


def _relay(status, headers, data):
    return Response(data, status=status, content_type=headers.get("Content-Type") or "application/json")


@bp.route("/", methods=["GET"])
@login_required
def page():
    return _serve("index.html", "text/html")


@bp.route("/workflow-helper.js", methods=["GET"])
@login_required
def bundle():
    return _serve("workflow-helper.js", "text/javascript")


@bp.route("/workflow-helper.js.map", methods=["GET"])
@login_required
def bundle_map():
    return _serve("workflow-helper.js.map", "application/json")


@bp.route("/config", methods=["GET"])
@login_required
def page_config():
    enabled = _enabled()
    return jsonify(enabled=enabled, imageInput=enabled and bool(_env("KAIJU_LLM_VISION_MODEL")))


@bp.route("/llm/chat/completions", methods=["POST"])
@login_required
def chat_completions():
    if not _enabled():
        return _disabled()
    # Never force=True: requiring the JSON content type is what stops a cross-site
    # form post, and a cross-site fetch with that type needs a preflight Flask won't grant.
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="invalid_request", detail="send a JSON object"), 400

    endpoint, model, key = _target(_has_image(body))
    body["model"] = model
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if key:
        # A key never contains whitespace; a pasted line break would make the header
        # invalid, and the error detail below would then echo the key.
        headers["Authorization"] = "Bearer " + "".join(key.split())
    try:
        upstream = urllib.request.Request(
            _chat_url(endpoint), data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
        )
        context = ssl.create_default_context(cafile=_env("KAIJU_LLM_CA_BUNDLE") or None)
        timeout = float(_env("KAIJU_LLM_TIMEOUT_SECONDS") or 120)
        try:
            response = urllib.request.urlopen(upstream, timeout=timeout, context=context)
        except urllib.error.HTTPError as e:
            response = e  # the LLM answered with an error status: relay it the same way
        # Reading the body stays inside the outer try, so a cut-short or stalled
        # error body maps to 502/504 like any other failure instead of a 500.
        with response:
            return _relay(response.status, response.headers, response.read())
    except (TimeoutError, socket.timeout):
        return jsonify(error="llm_timeout"), 504
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            return jsonify(error="llm_timeout"), 504
        return jsonify(error="llm_unreachable", detail=str(e.reason)), 502
    except (OSError, http.client.HTTPException, ValueError) as e:
        # Connection dropped, bad CA bundle path, malformed endpoint or timeout value, ...
        return jsonify(error="llm_unreachable", detail=f"{type(e).__name__}: {e}"), 502
