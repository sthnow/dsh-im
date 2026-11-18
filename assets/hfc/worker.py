"""Offline, display-only JSONL bridge to the pinned HFC v5.0.25 checkout.

Run with the nominated Python: python -I -S -B worker.py
No config loader, network client, server, execution registry or dependencies.
The caller owns actual interaction authorization/execution. Card callback values
are protocol output (potentially sensitive), NOT diagnostics; never log them.

Requests: {id: string|integer|null, op: 'event', event: SidecarEvent dictionary}
          {id: ..., op: 'reset'}  # clear ALL display sessions/budgets
Replies: {id, ok, accepted, card, disposition, segments, summary} for events;
         {id, ok: true, reset: true} for reset; {id, ok: false, error} on error.
accepted is exactly CardSession.apply's return, not an execution acknowledgement.

Configuration differences: upstream DEFAULT_CONFIG.card.interaction_mode='auto'
(and streaming_mode=False for delivery); this offline bridge explicitly selects
interaction_mode='callback' and presentation='classic'. It renders each accepted
OR rejected event immediately, without delivery throttling/CardKit. All other
render_card_result defaults are unchanged: reasoning on/streamed to body, timeline
collapsed, tool_activity='full', native_tables=False, over_limit='native', etc.
No user's config, environment credentials or disk checkpoints are read.

Route key: platform + data.profile_id + data.bot_id + conversation_id + chat_id
+ thread_id + canonical_turn_id. Missing profile/bot values mean 'default'.
Message aliases inside one canonical turn are NOT normalized: upstream apply
rejects mismatching message_id. Bounds fail closed, never evict/revive old turns:
64 sessions, 256 KiB per line (excluding LF/CRLF), 2 MiB cumulative accepted event
input and 4096 accepted events per session. reset is the explicit test escape.
"""
from __future__ import annotations

import contextlib
import copy
import io
import hashlib
import json
import re
from pathlib import Path
import sys
from typing import Any, BinaryIO

sys.dont_write_bytecode = True
UPSTREAM = Path(__file__).resolve().parent / 'upstream'
sys.path.insert(0, str(UPSTREAM))
# These exact modules form the standard-library-only upstream presentation path.
with contextlib.redirect_stdout(io.StringIO()):
    from hermes_feishu_card.events import EventValidationError, SidecarEvent
    from hermes_feishu_card.session import CardSession
    from hermes_feishu_card.render import render_card_result, render_legacy_interaction_callback_card
    from hermes_feishu_card.status import StatusConfig, resolve_display_status

MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
MAX_SESSIONS = 64
MAX_SESSION_BYTES = 2 * 1024 * 1024
MAX_SESSION_EVENTS = 4096
MAX_ID_CHARS = 128
MAX_ROUTE_CHARS = 256


class ProtocolError(ValueError):
    """A static, non-sensitive protocol error code, never raw event content."""


def _reject_constant(_value: str) -> None:
    raise ProtocolError('invalid_json')


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError('invalid_json')
        result[key] = value
    return result


def decode_request(line: bytes) -> dict[str, Any]:
    try:
        request = json.loads(line.decode('utf-8'), parse_constant=_reject_constant,
                             object_pairs_hook=_object)
    except (UnicodeError, ValueError, RecursionError, OverflowError):
        raise ProtocolError('invalid_json') from None
    if type(request) is not dict:
        raise ProtocolError('invalid_request')
    return request


def _request_id(value: Any) -> str | int | None:
    if value is None or (type(value) is int and -(2**53 - 1) <= value <= 2**53 - 1):
        return value
    if type(value) is str and len(value) <= MAX_ID_CHARS:
        return value
    raise ProtocolError('invalid_id')


def _route_key(event: SidecarEvent) -> tuple[str, ...]:
    parts = [event.platform]
    for name in ('profile_id', 'bot_id'):
        value = event.data.get(name, 'default')
        if type(value) is not str or not value.strip():
            raise ProtocolError('invalid_route')
        parts.append(value)
    parts.extend((event.conversation_id, event.chat_id, event.thread_id,
                  event.canonical_turn_id))
    if any(len(part) > MAX_ROUTE_CHARS for part in parts):
        raise ProtocolError('invalid_route')
    return tuple(parts)


def _public_interaction(session: CardSession) -> dict[str, Any] | None:
    interaction = session.active_interaction
    if interaction is None:
        return None
    # Explicit public projection: no callback_token, admission token, routing
    # fingerprints, execution claim, requester identity or transport metadata.
    return {
        'interaction_id': interaction.interaction_id,
        'kind': interaction.kind,
        'status': interaction.status,
        'prompt': interaction.prompt,
        'options': [{'label': option.label, 'value': option.value,
                     'style': option.style} for option in interaction.options],
        'multi_select': interaction.multi_select,
        'allow_custom_input': interaction.allow_custom_input,
        'choice': interaction.choice,
        'choice_label': interaction.choice_label,
        'error': interaction.error,
    }


def normalize_card_element_ids(card: dict[str, Any]) -> dict[str, Any]:
    """Normalize display identity only, after the pinned renderer has finished.

    Reserve already-valid IDs before generating short IDs so generated names
    cannot steal an existing element's identity. Equal source IDs get unique
    occurrence IDs; an ambiguous reference keeps its first-definition binding.
    Never recurse into value: callback/business payloads are opaque, even when
    they contain keys named element_id or tag. No upstream object is mutated.
    """
    result = copy.deepcopy(card)

    def structures(value: Any):
        if isinstance(value, dict):
            yield value
            for key, child in value.items():
                if key != 'value':
                    yield from structures(child)
        elif isinstance(value, list):
            for child in value:
                yield from structures(child)

    objects = list(structures(result))
    elements = [node for node in objects
                if isinstance(node.get('tag'), str) and 'element_id' in node]
    valid = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,19}', value) is not None
    reserved = {node['element_id'] for node in elements if valid(node['element_id'])}
    used: set[str] = set()
    bindings: dict[str, str] = {}
    for node in elements:
        original = node['element_id']
        if valid(original) and original not in used:
            replacement = original
        else:
            salt = 0
            while True:
                digest = hashlib.sha256(json.dumps([original, salt], ensure_ascii=True,
                                                   sort_keys=True).encode('ascii')).hexdigest()
                replacement = 'hfc_' + digest[:16]
                if replacement not in used and replacement not in reserved:
                    break
                salt += 1
        node['element_id'] = replacement
        used.add(replacement)
        if isinstance(original, str):
            bindings.setdefault(original, replacement)
    # Typed identity/reference fields only. Text, names, URLs and arbitrary
    # equal strings are not references and must remain byte-for-byte unchanged.
    for node in objects:
        for key, value in list(node.items()):
            if key in {'element_id', 'target_element_id', 'target_id'}:
                if key == 'element_id' and isinstance(node.get('tag'), str):
                    continue  # already assigned, including duplicate occurrences
                if isinstance(value, str) and value in bindings:
                    node[key] = bindings[value]
            elif key in {'element_ids', 'target_element_ids'} and isinstance(value, list):
                node[key] = [bindings.get(item, item) if isinstance(item, str) else item for item in value]
    return result


def postprocess_card(session: CardSession, card: dict[str, Any]) -> dict[str, Any]:
    """Display-only wrapper policy; never change native delivery or turn state.

    Remove only the outer success header, retaining the renderer's complete body
    (including nested panel headers, tools, reasoning and statistics footer).
    Both execution and display must be completed: pending/paused decisions and
    inferred progress handoffs still need their status/attention header.
    """
    result = normalize_card_element_ids(card)
    interaction = session.active_interaction
    if (session.status == 'completed'
            and not (interaction is not None and interaction.status in {'pending', 'paused'})
            and resolve_display_status(session, StatusConfig.defaults()).value == 'completed'):
        result.pop('header', None)
    return result


def interaction_display_session(session: CardSession) -> CardSession:
    """Localize only known machine errors on a rendering clone, never answers.

    Stored state, summary and wire errors remain authoritative and untranslated.
    An external resolution does not tell us who ended the interaction or why.
    """
    interaction = session.active_interaction
    labels = {
        'resolved-on-another-client': '此交互已结束',
        'interaction-expired': '交互已过期',
        'expired': '交互已过期',
        'cancelled': '交互已取消',
        'canceled': '交互已取消',
        'error': '交互处理失败',
    }
    if interaction is None or interaction.status in {'pending', 'completed'}:
        return session
    label = labels.get(interaction.error)
    if label is None:
        return session
    display = copy.deepcopy(session)
    display.active_interaction.error = label
    return display


class Worker:
    def __init__(self) -> None:
        # Presentation state only; NOT an interaction/authorization registry.
        self.sessions: dict[tuple[str, ...], CardSession] = {}
        self.budgets: dict[tuple[str, ...], tuple[int, int]] = {}

    def handle(self, request: dict[str, Any], input_bytes: int | None = None) -> dict[str, Any]:
        request_id = None
        try:
            if type(request) is not dict or 'id' not in request:
                raise ProtocolError('invalid_request')
            request_id = _request_id(request['id'])
            op = request.get('op')
            if op == 'reset':
                if set(request) != {'id', 'op'}:
                    raise ProtocolError('invalid_request')
                self.sessions.clear()
                self.budgets.clear()
                return {'id': request_id, 'ok': True, 'reset': True}
            if op != 'event':
                raise ProtocolError('unknown_op')
            if set(request) != {'id', 'op', 'event'}:
                raise ProtocolError('invalid_request')
            event = SidecarEvent.from_dict(request['event'])
            key = _route_key(event)
            if key not in self.sessions and len(self.sessions) >= MAX_SESSIONS:
                raise ProtocolError('session_limit')
            size = input_bytes if input_bytes is not None else len(
                json.dumps(request, ensure_ascii=False, allow_nan=False).encode('utf-8'))
            if size > MAX_LINE_BYTES:
                raise ProtocolError('input_too_large')
            used_bytes, used_events = self.budgets.get(key, (0, 0))
            # Copy before applying: malformed data/render failures must not leave
            # partially mutated sessions behind. Upstream's own deepcopy contract
            # also handles immutable runtime-admission presentation metadata.
            candidate = copy.deepcopy(self.sessions[key]) if key in self.sessions else CardSession(
                conversation_id=event.conversation_id, message_id=event.message_id,
                chat_id=event.chat_id)
            accepted = candidate.apply(event)
            if accepted and (used_bytes + size > MAX_SESSION_BYTES or
                             used_events + 1 > MAX_SESSION_EVENTS):
                raise ProtocolError('session_budget')
            # Main and auxiliary are separate display projections, never delivery
            # evidence. This sentinel exists only on a clone used for rendering;
            # do NOT persist it or populate confirmed approval receipt metadata.
            display = interaction_display_session(candidate)
            main = display
            interaction_card = None
            if candidate.active_interaction is not None:
                interaction_card = normalize_card_element_ids(render_legacy_interaction_callback_card(
                    display, title='DeepSeek Harness', interaction_profile_id=key[1]))
                if candidate.active_interaction.status == 'pending':
                    main = copy.deepcopy(display)
                    main.active_interaction.feishu_message_id = 'dsh-display-only-standalone-rail'
            rendered = render_card_result(main, title='DeepSeek Harness', presentation='classic',
                                          footer_fields=('duration', 'model', 'input_tokens',
                                                         'output_tokens', 'context', 'output_rate'),
                                          interaction_mode='callback',
                                          interaction_profile_id=key[1])
            response = {
                'id': request_id, 'ok': True, 'accepted': accepted,
                'card': postprocess_card(candidate, rendered.card), 'disposition': rendered.disposition,
                'segments': list(rendered.segments),
                'interaction_card': interaction_card,
                'summary': {'status': candidate.status, 'answer': candidate.answer_text,
                            'thinking': candidate.thinking_text, 'toolCount': candidate.tool_count,
                            'interaction': _public_interaction(candidate)},
            }
            # Ensure response serializability BEFORE committing the display state.
            encoded = json.dumps(response, ensure_ascii=True, allow_nan=False)
            if len(encoded) > MAX_OUTPUT_BYTES:
                raise ProtocolError('output_too_large')
            if accepted:
                self.sessions[key] = candidate
                self.budgets[key] = (used_bytes + size, used_events + 1)
            return response
        except ProtocolError as exc:
            code = str(exc)  # All ProtocolError messages are static constants above.
        except EventValidationError:
            code = 'invalid_event'
        except Exception:
            # Upstream errors may contain prompt, command or tokens: never emit
            # exception messages/tracebacks, nor add raw input to diagnostics.
            code = 'event_processing_failed'
        return {'id': request_id, 'ok': False, 'error': {'code': code}}


def _lines(stream: BinaryIO):
    """Bound allocation and resynchronize on LF after oversized physical lines."""
    while True:
        line = stream.readline(MAX_LINE_BYTES + 3)
        if not line:
            return
        complete = line.endswith(b'\n')
        content = line[:-1] if complete else line
        if complete and content.endswith(b'\r'):
            content = content[:-1]
        if len(content) > MAX_LINE_BYTES:
            while not complete:
                chunk = stream.readline(MAX_LINE_BYTES + 3)
                if not chunk:
                    break
                complete = chunk.endswith(b'\n')
            yield None
        else:
            yield content


def serve(source: BinaryIO, destination: BinaryIO) -> None:
    worker = Worker()
    for line in _lines(source):
        if line is None:
            response = {'id': None, 'ok': False, 'error': {'code': 'input_too_large'}}
        else:
            try:
                request = decode_request(line)
                # Discard any accidental upstream print rather than corrupt JSONL
                # or move potentially sensitive event content into stderr logs.
                with contextlib.redirect_stdout(io.StringIO()):
                    response = worker.handle(request, len(line))
            except ProtocolError as exc:
                response = {'id': None, 'ok': False, 'error': {'code': str(exc)}}
        destination.write((json.dumps(response, ensure_ascii=True, allow_nan=False,
                                      separators=(',', ':')) + '\n').encode('ascii'))
        destination.flush()


if __name__ == '__main__':
    serve(sys.stdin.buffer, sys.stdout.buffer)
