"""Runs one command for Paper Reader and makes sure it can't outlive the app.

Usage: python childguard.py <server pid> <command…>
It is started in its own process group. If the server that started it disappears (quit, crash or force-kill),
the guard stops the whole group, including the command and anything the command started.
Standard input/output are passed straight through, so the server reads the command's output as usual.
"""
import os
import signal
import subprocess
import sys
import threading
import time

server, cmd = int(sys.argv[1]), sys.argv[2:]
child = subprocess.Popen(cmd)          # same process group as this guard


def watch():
    while child.poll() is None:
        time.sleep(1.0)
        try:
            os.kill(server, 0)
        except ProcessLookupError:
            os.killpg(os.getpgrp(), signal.SIGTERM)   # takes this guard along too
            os._exit(1)
        except PermissionError:
            pass


threading.Thread(target=watch, daemon=True).start()
signal.signal(signal.SIGTERM, lambda s, f: (child.terminate(), os._exit(143)))
sys.exit(child.wait())
