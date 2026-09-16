"""No login in the local demo.

The blueprint expects a `login_required` decorator, as it would find on a site
with accounts. The demo server listens on 127.0.0.1 only, so only this computer
can open it, and every request is let through.
"""


def login_required(view):
    return view
