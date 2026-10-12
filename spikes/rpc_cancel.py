"""T14 live check: start a long command over `pi --mode rpc`, send a cancel
command after a delay, record notifications and pi's child processes."""
import json
import subprocess
import sys
import threading
import time

cwd, first, second, delay, out_path = sys.argv[1:6]
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1,
)
t0 = time.time()
log = open(out_path, "w")


def rec(kind, data):
    log.write(json.dumps({"t": round(time.time() - t0, 1), "kind": kind, "data": data}) + "\n")
    log.flush()


def children():
    out = subprocess.run(["ps", "--ppid", str(proc.pid), "-o", "pid=,comm="],
                         capture_output=True, text=True).stdout
    return [line.split(None, 1)[1] for line in out.strip().splitlines() if line.strip()]


def send(message, key):
    proc.stdin.write(json.dumps({"id": key, "type": "prompt", "message": message}) + "\n")
    proc.stdin.flush()
    rec("sent", {"message": message, "children": children()})


def later():
    time.sleep(float(delay))
    send(second, "p2")


send(first, "p1")
threading.Thread(target=later, daemon=True).start()
deadline = time.time() + 600
for line in proc.stdout:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("type") == "extension_ui_request" and msg.get("method") == "notify":
        text = msg.get("message", "")
        rec("notify", text[:300])
        if "aborted" in text or "cancelled" in text.lower() and "cancelling" not in text:
            time.sleep(2)
            rec("children_after", children())
            break
    elif msg.get("type") == "response":
        rec("response", {k: msg.get(k) for k in ("id", "command", "success", "error")})
    if time.time() > deadline:
        rec("deadline", None)
        break
time.sleep(1)
rec("children_final", children())
proc.terminate()
try:
    proc.wait(10)
except subprocess.TimeoutExpired:
    proc.kill()
