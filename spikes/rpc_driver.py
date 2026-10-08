"""Drive `pi --mode rpc` for the T04 spike: send one prompt, answer dialogs after a delay."""
import json
import os
import subprocess
import sys
import threading
import time

ext, cwd, prompt, out_path = sys.argv[1:5]
answer_delay = float(os.environ.get("ANSWER_DELAY", "4"))
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "-e", ext],
    cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1,
)
t0 = time.time()
log = open(out_path, "w")


def rec(kind, data):
    log.write(json.dumps({"t": round(time.time() - t0, 2), "kind": kind, "data": data}) + "\n")
    log.flush()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def answer(req):
    time.sleep(answer_delay)
    method = req.get("method")
    if method == "select":
        opts = req.get("options") or []
        pick = next((o for o in opts if "allow" in str(o).lower() or "yes" in str(o).lower()), opts[0] if opts else None)
        resp = {"type": "extension_ui_response", "id": req["id"], "value": pick}
    elif method == "confirm":
        resp = {"type": "extension_ui_response", "id": req["id"], "confirmed": True}
    else:
        resp = {"type": "extension_ui_response", "id": req["id"], "cancelled": True}
    rec("answer", resp)
    send(resp)


send({"id": "p1", "type": "prompt", "message": prompt})
deadline = time.time() + float(os.environ.get("DEADLINE", "300"))
for line in proc.stdout:
    try:
        msg = json.loads(line)
    except ValueError:
        rec("raw", line.strip()[:300])
        continue
    typ = msg.get("type")
    if typ == "extension_ui_request":
        rec("ui_request", {k: msg.get(k) for k in ("id", "method", "title", "message", "options", "timeout", "notifyType")})
        if msg.get("method") in ("select", "confirm", "input", "editor"):
            threading.Thread(target=answer, args=(msg,), daemon=True).start()
    elif typ in ("agent_start", "agent_end", "response", "tool_execution_start", "tool_execution_end"):
        rec(typ, {k: msg.get(k) for k in ("toolName", "success", "error", "command")})
        if typ == "agent_end":
            break
    if time.time() > deadline:
        rec("deadline", None)
        break
proc.terminate()
try:
    proc.wait(10)
except subprocess.TimeoutExpired:
    proc.kill()
rec("stderr", proc.stderr.read()[-2000:])
