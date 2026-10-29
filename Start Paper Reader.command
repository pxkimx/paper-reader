#!/bin/bash
# Same as double-clicking "Paper Reader.app", but inside a Terminal window so you can see every message.
cd "$(dirname "$0")"
MODE=terminal exec /bin/bash "Paper Reader.app/Contents/Resources/app/launch.sh"
