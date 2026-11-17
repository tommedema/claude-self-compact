#!/usr/bin/env python3
"""End-to-end check: a message that arrives while a compaction runs is answered with the carry note in view.

Such a message is queued and submitted the moment the compaction ends, before the plugin has put the
carry note back; without the wait in prompt.submit its first request went out without the note. This
sends a question 2 seconds after the turn that asked for the compaction ends, so it arrives while the
compaction runs, and checks the first request after the compaction carries the note.
Like e2e.py it uses the real config folder for the login and SELF_COMPACT_HOME for the plugin's files.

  python3 tests/e2e-queued.py     (from plugins/self-compact; under a minute, a cent or two)
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

PLUGIN = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CONFIG = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
MODEL = os.environ.get('E2E_MODEL', 'claude-haiku-5-5')
ASK = ('This is a test of a plugin. Write two sentences about rivers. Then call the tool mcp__self-compact__compact '
       'once with carry "The code word is HELIOTROPE-42." and no then. Then end your turn with the single word: scheduled.')
QUESTION = 'What is the code word in your carry note? Reply with only the code word, or NONE if you have none.'
MARK = '[self-compact] This conversation was compacted'


def main():
    home, cwd = tempfile.mkdtemp(prefix='self-compact-home-'), tempfile.mkdtemp(prefix='self-compact-queued-')
    env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE_CODE_')}
    env['SELF_COMPACT_HOME'] = home
    cmd = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--model', MODEL, '--plugin-dir', PLUGIN, '--allowedTools', 'mcp__self-compact__compact',
           '--settings', json.dumps({'enabledPlugins': {'self-compact@claude-self-compact': False}})]
    p = subprocess.Popen(cmd, cwd=cwd, env=env, text=True,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    results, sid = [], [None]

    def send(text):
        p.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}) + '\n')
        p.stdin.flush()

    def reader():
        for line in p.stdout:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            sid[0] = d.get('session_id') or sid[0]
            if d.get('type') == 'result':
                results.append(str(d.get('result')))

    def transcript():
        found = glob.glob(os.path.join(CONFIG, 'projects', '*', '%s.jsonl' % sid[0])) if sid[0] else []
        return found[0] if found else None

    threading.Thread(target=reader, daemon=True).start()
    send(ASK)
    end = time.time() + 120
    while time.time() < end and not results:
        time.sleep(0.2)
    # The compaction starts about 0.1 s after the turn ends and takes several seconds. (Its
    # /compact row is written only once it is done, so the transcript cannot say it has begun.)
    time.sleep(2)
    send(QUESTION)
    end = time.time() + 180
    while time.time() < end and len(results) < 2:
        time.sleep(0.5)
    time.sleep(3)
    p.stdin.close()
    try:
        p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p.kill()

    path = transcript()
    rows = [json.loads(l) for l in open(path) if l.strip()] if path else []
    blobs = {r['hash']: r['message'] for r in rows if r.get('type') == 'api-request-blob'}
    bounds = [i for i, r in enumerate(rows) if r.get('subtype') == 'compact_boundary']
    after = [r for r in rows[bounds[-1]:] if r.get('type') == 'api-request'] if bounds else []

    def carries_note(req):   # the request's messages, from the content-addressed blobs it names
        tail = req.get('tail')
        tail = json.loads(tail) if isinstance(tail, str) else (tail or [])
        return any(MARK in (blobs[h] if isinstance(blobs[h], str) else json.dumps(blobs[h])) for h in tail if h in blobs)

    began = [r['timestamp'] for r in rows
             if r.get('type') == 'user' and '<command-name>/compact</command-name>' in json.dumps(r.get('message'))]
    ended = rows[bounds[-1]]['timestamp'] if bounds else ''
    queued = bool(began) and any(r.get('type') == 'queue-operation' and r.get('operation') == 'enqueue'
                                 and began[-1] < r.get('timestamp', '') < ended for r in rows)
    checks = [
        ('the session compacted once', len(bounds) == 1),
        ('the question arrived while the compaction ran', queued),
        ('the question was answered after the compaction', len(results) >= 2 and len(after) >= 1),
        ('the first request after the compaction carries the carry note', bool(after) and carries_note(after[0])),
    ]
    for name, ok in checks:
        print('%s  %s' % ('PASS' if ok else 'FAIL', name))
    print('session %s, transcript %s' % (sid[0], path))
    sys.exit(0 if all(ok for _, ok in checks) else 1)


if __name__ == '__main__':
    main()
