import pty, os, sys, select, struct, fcntl, termios, signal, json, base64, threading, time

def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass

# The reader and stdin cleanup can both observe exit; retain the one reaped status.
_child_status = {}
_reap_lock = threading.Lock()

def reap_status(pid, wait=True):
    while True:
        with _reap_lock:
            if pid in _child_status:
                return _child_status[pid]
            try:
                reaped, status = os.waitpid(pid, os.WNOHANG)
                if reaped:
                    if os.WIFEXITED(status):
                        code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        code = 128 + os.WTERMSIG(status)
                    else:
                        code = 1
                    _child_status[pid] = code
                    return code
            except ChildProcessError:
                return 0
            except Exception:
                return 1
        if not wait:
            return None
        time.sleep(0.01)

def signal_child_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except OSError:
        # A child that has not finished setsid() does not yet lead a group.
        if reap_status(pid, wait=False) is None:
            try:
                os.kill(pid, sig)
            except OSError:
                pass

def cleanup_child(pid):
    signal_child_group(pid, signal.SIGTERM)
    for _ in range(10):
        code = reap_status(pid, wait=False)
        if code is not None:
            # The leader can exit before another member of its group.
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                return code
            except PermissionError:
                pass
        time.sleep(0.02)
    signal_child_group(pid, signal.SIGKILL)
    return reap_status(pid)

def main():
    if len(sys.argv) < 2:
        sys.exit(1)
    cmd = sys.argv[1:]
    master, slave = pty.openpty()
    # The child waits until we have closed our copy of the slave: if a fast child exited first,
    # our close would be the last one, and macOS then drops the output nobody has read yet.
    ready_r, ready_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.close(ready_w)
        os.read(ready_r, 1)
        os.close(ready_r)
        os.setsid()
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        os.close(slave)
        try:
            os.execvp(cmd[0], cmd)
        except Exception:
            sys.exit(127)
    os.close(slave)
    os.close(ready_r)
    os.close(ready_w)

    closing = threading.Event()

    def pty_reader():
        try:
            while True:
                data = os.read(master, 4096)
                if not data:
                    break
                msg = json.dumps({"stream": "stdout", "delta": base64.b64encode(data).decode("ascii")})
                sys.stdout.write(msg + "\n")
                sys.stdout.flush()
        except Exception:
            pass
        code = reap_status(pid)
        try:
            os.close(master)
        except Exception:
            pass
        # During an explicit shutdown the main thread still owns group cleanup.
        if not closing.is_set():
            os._exit(code)

    t = threading.Thread(target=pty_reader, daemon=True)
    t.start()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd_obj = json.loads(line)
                action = cmd_obj.get("action")
                if action == "input":
                    raw = base64.b64decode(cmd_obj.get("data", ""))
                    os.write(master, raw)
                elif action == "resize":
                    cols = int(cmd_obj.get("cols", 80))
                    rows = int(cmd_obj.get("rows", 24))
                    set_winsize(master, rows, cols)
                elif action == "kill":
                    break
            except Exception:
                pass

    except Exception:
        pass

    finally:
        closing.set()
        code = cleanup_child(pid)
        # Drain remaining output, but never hang on a slave held outside the process group.
        t.join(timeout=1.0)
        os._exit(code)

if __name__ == "__main__":
    main()
