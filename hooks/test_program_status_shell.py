import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("status_shell", Path(__file__).parents[1] / "scripts" / "program-status-shell.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_query_reply_precedes_the_forwarded_device_probe_at_every_boundary():
    for terminator in [b"\x07", b"\x1b\\"]:
        data = b"hello\x1b]7501;?" + terminator + b"\x1b[cworld"
        for split in range(len(data) + 1):
            events = []
            parser = module.StatusQueries(lambda reply: events.append(("reply", reply)))
            first = parser.feed(data[:split])
            events.append(("forward", first))
            second = parser.feed(data[split:])
            events.append(("forward", second))
            assert first + second == b"hello\x1b[cworld"
            assert [value for kind, value in events if kind == "reply"] == [b"\x1b]7501;?\x1b\\"]
            forwarded = b""
            probe_index = None
            for i, (kind, value) in enumerate(events):
                if kind == "forward":
                    forwarded += value
                    if b"[c" in forwarded and probe_index is None:
                        probe_index = i
            reply_index = next(i for i, (kind, _) in enumerate(events) if kind == "reply")
            assert reply_index < probe_index


def test_status_reports_and_opaque_strings_are_unchanged():
    data = b"\x1b]7501;state=working\x07\x1bPopaque\x1b]7501;?\x07\x1b\\normal"
    replies = []
    parser = module.StatusQueries(replies.append)
    assert parser.feed(data) == data
    assert replies == []


def test_incomplete_prefixes_recover_without_losing_output():
    replies = []
    parser = module.StatusQueries(replies.append)
    assert parser.feed(b"hello\x1b]750") == b"hello"
    assert parser.feed(b"2;title\x07") == b"\x1b]7502;title\x07"
    assert parser.feed(b"\x1b]7501;?\x1b\\\x1b]7501;?\x07") == b""
    assert len(replies) == 2
