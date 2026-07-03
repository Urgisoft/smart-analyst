"""
send_email.py — SMTP email delivery for SignalForge reports.

Sends plain-text reports (daily brief, swing screener, alerts) by email. Self-contained env
loader (no import cycle with ftec_daily_brief). Gracefully SKIPS with an explanatory string when
SMTP is not configured, so callers can always call it unconditionally.

Setup (one-time, operator action — ~2 minutes for Gmail):
  1. Google Account -> Security -> 2-Step Verification -> App passwords -> create one for "Mail".
  2. Add to .env:
       SMTP_HOST=smtp.gmail.com
       SMTP_PORT=587
       SMTP_USER=<your gmail address>
       SMTP_PASS=<the 16-char app password>
       EMAIL_TO=<destination address (can equal SMTP_USER)>
  Any provider works (Outlook: smtp office365.com:587) — same five keys.

Credentials live only in the operator's local .env (gitignored), same as the Telegram token.
Never printed, never committed.
"""
from __future__ import annotations

import smtplib
import sys
from email.mime.text import MIMEText
from email.utils import formatdate
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load_env() -> dict:
    env: dict = {}
    f = REPO / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def send_email(subject: str, body: str, env: dict | None = None) -> str:
    """Send a plain-text email. Returns a one-line status string (never raises)."""
    env = env or _load_env()
    host = env.get("SMTP_HOST")
    user = env.get("SMTP_USER")
    pw = env.get("SMTP_PASS")
    to = env.get("EMAIL_TO") or user
    if not (host and user and pw and to):
        return "email: skipped (SMTP_HOST/SMTP_USER/SMTP_PASS/EMAIL_TO not set in .env — see scripts/send_email.py header)"
    try:
        port = int(env.get("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(user, pw)
            s.sendmail(user, [to], msg.as_string())
        return f"email: sent to {to}"
    except Exception as e:
        return f"email: FAILED ({type(e).__name__}: {str(e)[:80]})"


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(send_email("SignalForge email test", "If you can read this, SMTP delivery works."))
