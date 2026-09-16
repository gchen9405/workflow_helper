"""No login in the local demo.

The blueprint expects a `login_required` decorator, as it would find on a site
with accounts. Every request is let through: locally the demo server listens on
127.0.0.1 only, so only this computer can open it; on OpenShift anyone who can
reach the Route can use it.
"""


def login_required(view):
    return view
