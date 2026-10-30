"""Run SQL on a Supabase project via the Management API. Auth is injected by the proxy; no header is set here."""
import json, subprocess, sys, time
def q(ref, sql, read_only=False):
    body = {"query": sql}
    if read_only: body["read_only"] = True
    for attempt in range(8):
        p = subprocess.run(["curl","-sS","--max-time","120","-w","\n%{http_code}","-X","POST",
            f"https://api.supabase.com/v1/projects/{ref}/database/query","-H","content-type: application/json","--data-binary","@-"],
            input=json.dumps(body).encode(), capture_output=True)
        out = p.stdout.decode(); text, _, code = out.rpartition("\n")
        if code in ("200","201"):
            return json.loads(text) if text.strip() else []
        if code in ("429","500","502","503","504") or code == "000":
            time.sleep(min(30, 2*2**attempt)); continue
        raise RuntimeError(f"query failed {code}: {text[:500]}")
    raise RuntimeError("query failed after retries")
def api(method, path, data=None):
    args=["curl","-sS","--max-time","120","-w","\n%{http_code}","-X",method,f"https://api.supabase.com{path}","-H","content-type: application/json"]
    if data is not None: args+=["--data-binary","@-"]
    p=subprocess.run(args,input=json.dumps(data).encode() if data is not None else None,capture_output=True)
    text,_,code=p.stdout.decode().rpartition("\n")
    try: j=json.loads(text) if text.strip() else None
    except Exception: j=text
    return int(code or 0), j
if __name__ == "__main__":
    ref, sql = sys.argv[1], sys.stdin.read()
    print(json.dumps(q(ref, sql, read_only="--ro" in sys.argv), indent=1, default=str))
