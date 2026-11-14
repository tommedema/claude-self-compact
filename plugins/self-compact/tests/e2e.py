#!/usr/bin/env python3
"""End-to-end check of the plugin in a real headless session: two compactions, one after the other.

It needs the real config folder for the login, so the plugin's own files go to a temporary folder
through SELF_COMPACT_HOME: nothing is written to ~/.claude/self-compact, and this checks that too.
The session runs on a small model in a temporary folder; the whole check costs a few cents.

  python3 tests/e2e.py            (from plugins/self-compact; takes about two minutes)
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
REAL_LOG = os.path.join(CONFIG, 'self-compact', 'compactions.jsonl')
MODEL = os.environ.get('E2E_MODEL', 'claude-haiku-5-5')
ASK = ('This is a test of a plugin. First write a status report of about 120 words on any subject, as plain '
       'text, beginning with the word REPORT%d. Then call the tool mcp__self-compact__compact once with carry '
       '"TEST NOTE %d written about 23:59" and then "Reply with exactly: resumed". Then end your turn with the '
       'single word: scheduled.')


def lines(path):
    try:
        with open(path) as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def main():
    home, cwd = tempfile.mkdtemp(prefix='self-compact-home-'), tempfile.mkdtemp(prefix='self-compact-e2e-')
    before = lines(REAL_LOG)
    cmd = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--model', MODEL, '--plugin-dir', PLUGIN, '--allowedTools', 'mcp__self-compact__compact',
           # the installed copy, if any, would register the same tool
           '--settings', json.dumps({'enabledPlugins': {'self-compact@claude-self-compact': False}})]
    p = subprocess.Popen(cmd, cwd=cwd, env=dict(os.environ, SELF_COMPACT_HOME=home), text=True,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    results, sid, pending = [], [None], []

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

    def watcher():   # the request as another hook would see it while it waits for the turn to end
        while p.poll() is None:
            try:
                with open(os.path.join(home, 'sessions', '%s.json' % sid[0])) as f:
                    now = json.load(f).get('pending')
                if now and (not pending or pending[-1]['requestedAt'] != now['requestedAt']):
                    pending.append(now)
            except (OSError, ValueError):
                pass
            time.sleep(0.05)

    def wait(resumed, limit=150):
        end = time.time() + limit
        while time.time() < end and p.poll() is None and sum(r.startswith('resumed') for r in results) < resumed:
            time.sleep(0.5)

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=watcher, daemon=True).start()
    send(ASK % (1, 1))
    wait(1)
    time.sleep(61)   # so the second row has a whole minute to report
    send(ASK % (2, 2))
    wait(2)
    time.sleep(2)
    p.stdin.close()
    try:
        p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p.kill()

    rows, notes = [], []   # notes: the carry of each tool call, as the model passed it
    for path in glob.glob(os.path.join(CONFIG, 'projects', '*', '%s.jsonl' % sid[0])):
        for line in open(path):
            if '"mcp__self-compact__compact"' in line and '"tool_use"' in line:
                c = (json.loads(line).get('message') or {}).get('content')
                notes += [b['input'].get('carry', '') for b in c if isinstance(b, dict) and b.get('type') == 'tool_use'
                          and b.get('name') == 'mcp__self-compact__compact'] if isinstance(c, list) else []
            if '[self-compact] This conversation was compacted' not in line:
                continue
            c = (json.loads(line).get('message') or {}).get('content')
            text = c if isinstance(c, str) else ' '.join(b.get('text', '') for b in c if isinstance(b, dict))
            if text.startswith('[self-compact]'):
                rows.append(text)
    try:
        log = [json.loads(line) for line in open(os.path.join(home, 'compactions.jsonl'))]
    except OSError:
        log = []
    report = lambda row: row.split('<last-report>\n')[1].split('\n</last-report>')[0] if '<last-report>' in row else ''
    checks = [
        ('the session came back after both compactions', sum(r.startswith('resumed') for r in results) == 2),
        ('two rows bring the note back', len(rows) == 2),
        ('each note is word for word as it was passed', len(notes) == 2 and all(
            notes[i].startswith('TEST NOTE %d' % (i + 1)) and '<carry>\n%s\n</carry>' % notes[i] in row for i, row in enumerate(rows))),
        ('each row has the machine clock', all(time.strftime('%Y-%m-%d ') in row and 'local time' in row for row in rows)),
        ('the second says how long ago the first was', len(rows) == 2 and 'after the previous compaction' in rows[1] and 'after the previous compaction' not in rows[0]),
        ('each row carries the last report word for word', all(report(row).startswith('REPORT%d' % (i + 1)) and len(report(row)) >= 400 for i, row in enumerate(rows))),
        ('the request showed in the state file while it waited, with then', len(pending) == 2 and all(x.get('then') and x.get('requestedAt') for x in pending)),
        ('the log has one line for each, in the temporary folder', len(log) == 2 and all(e.get('ok') and e.get('reportChars', 0) >= 400 for e in log)),
        ('the real log was not written to', lines(REAL_LOG) == before),
    ]
    for name, ok in checks:
        print('%s  %s' % ('pass' if ok else 'FAIL', name))
    if not all(ok for _, ok in checks):
        print('\nsession %s\nresults %s\nrows %s\nlog %s\nstate folder %s' % (sid[0], results, [r[:400] for r in rows], log, home))
        sys.exit(1)


if __name__ == '__main__':
    main()
