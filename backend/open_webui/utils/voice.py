"""Voice handling in the pre-loop payload (PR8).

Two voice items touch the model's context, and both run in Python before the
loop (issue 2): the voice-mode system prompt rides `features.voice`, and the
spoken side of earlier replies is stored as `meta.voice` on the chat record
and merged into context by `process_messages_with_output`.

Under the pi engine pi's session owns history (ADR 0005), and the dispatch
hands the sidecar the prompt head plus the new turn only, so the
full-history merge never reaches pi's turn. The spoken-transcript merge
therefore rides the per-turn handoff as an injection item sourced from
OWUI's DB (docs/research/voice-inlet-outlet.md): for agent-loop turns the
historical transcripts the merge produced for the chain gather back together
and ride the turn the agent bridge prompts with.
"""

from open_webui.utils.misc import add_or_update_user_message

# The marker `process_messages_with_output` puts on every transcript it merged
# for the chain — the collection here reads items back by that marker, so both
# sides stay one implementation apart from a copy.
HISTORICAL_VOICE_TRANSCRIPT = '[Historical voice assistant transcript; not current task status]'


def historical_voice_transcripts(messages: list[dict]) -> list[str]:
    """The speech items `process_messages_with_output` merged into this chain,
    in message order: each is an assistant message with the marker and the
    transcript on its content."""
    transcripts = []
    for message in messages:
        if message.get('role') != 'assistant':
            continue
        content = message.get('content')
        marker = f'{HISTORICAL_VOICE_TRANSCRIPT}\n'
        if not isinstance(content, str) or not content.startswith(marker):
            continue
        transcript = content[len(marker) :].strip()
        if transcript:
            transcripts.append(transcript)
    return transcripts


def merge_voice_transcripts_into_turn(messages: list[dict]) -> list[dict]:
    """Ride the chain's historical spoken transcripts onto the turn the agent
    dispatch prompts with (the last user message), one context injection
    block, each transcript in the trunk merge's exact shape."""
    if not (messages and messages[-1].get('role') == 'user'):
        return messages
    transcripts = historical_voice_transcripts(messages)
    if not transcripts:
        return messages
    block = '\n\n'.join(f'{HISTORICAL_VOICE_TRANSCRIPT}\n{transcript}' for transcript in transcripts)
    header = '[Historical voice transcripts spoken in earlier turns; not current task status]'
    injection = f'{header}\n\n{block}'
    return add_or_update_user_message(injection, messages, append=True)
