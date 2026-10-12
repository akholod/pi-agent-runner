"""Run one command over `pi --mode rpc` and log every notification with a
timestamp until a line matching the stop pattern arrives."""
import json
import os
import re
import subprocess
import sys
import time

cwd, message, stop, deadline_s, out_path = sys.argv[1:6]
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", *os.environ.get("PI_ARGS", "").split()],
    cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1,
)
t0 = time.time()
log = open(out_path, "w")


def rec(kind, data):
    log.write(json.dumps({"t": round(time.time() - t0), "kind": kind, "data": data}) + "\n")
    log.flush()


proc.stdin.write(json.dumps({"id": "p1", "type": "prompt", "message": message}) + "\n")
proc.stdin.flush()
deadline = t0 + float(deadline_s)
for line in proc.stdout:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("type") == "extension_ui_request" and msg.get("method") == "select":
        # Nobody is watching: refuse every permission question at once.
        options = msg.get("options") or []
        pick = next((o for o in options if str(o).startswith("No")), None)
        rec("dialog", {"title": (msg.get("title") or "")[:300], "answer": pick})
        response = {"type": "extension_ui_response", "id": msg["id"]}
        response.update({"value": pick} if pick else {"cancelled": True})
        proc.stdin.write(json.dumps(response) + "\n")
        proc.stdin.flush()
    elif msg.get("type") == "extension_ui_request" and msg.get("method") == "notify":
        text = msg.get("message", "")
        rec("notify", text[:2000])
        if re.search(stop, text):
            break
    if time.time() > deadline:
        rec("deadline", None)
        break
proc.terminate()
try:
    proc.wait(15)
except subprocess.TimeoutExpired:
    proc.kill()
