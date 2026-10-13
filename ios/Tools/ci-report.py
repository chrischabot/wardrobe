#!/usr/bin/env python3
"""Publishes a text file as GitHub Actions notice annotations, so a run's results can be read from
the check run without downloading logs or artifacts.

    python3 ios/Tools/ci-report.py <title> <file> [max_chunks]

A step may create at most 10 notices, so the text is packed into at most `max_chunks` (default 9)
annotations of about 3,600 characters (GitHub shortens longer ones); anything beyond that is counted and left in the artifact.
"""
import os
import sys

title, path = sys.argv[1], sys.argv[2]
max_chunks = int(sys.argv[3]) if len(sys.argv) > 3 else 9
CHUNK = 3600

if not os.path.exists(path):
    print(f"::notice title={title}::(no {os.path.basename(path)} was produced)")
    sys.exit(0)
lines = [line.rstrip() for line in open(path, encoding="utf-8", errors="replace") if line.strip()]
if not lines:
    print(f"::notice title={title}::(empty)")
    sys.exit(0)

chunks, current, size = [], [], 0
# A long line is wrapped into several rather than cut.
WRAP = 1400
lines = [line[i:i + WRAP] for line in lines for i in range(0, len(line), WRAP)]
for line in lines:
    if size + len(line) + 1 > CHUNK and current:
        chunks.append(current)
        current, size = [], 0
    current.append(line)
    size += len(line) + 1
if current:
    chunks.append(current)

shown = chunks[:max_chunks]
omitted = sum(len(c) for c in chunks[max_chunks:])
escape = lambda s: s.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
for index, chunk in enumerate(shown, 1):
    body = "\n".join(chunk)
    if index == len(shown) and omitted:
        body += f"\n... {omitted} more lines are in the artifact"
    print(f"::notice title={title} {index} of {len(shown)} - {len(lines)} lines::{escape(body)}")
