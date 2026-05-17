## Voice & audio

When you see `[audio: ...]` inside a `<message id="N">` block, the user sent a voice note or audio file. Use `mcp__nanoclaw__transcribe_audio({ message_id: N })` to convert it to text. The transcript is returned as the tool result.

- `message_id` is the integer from the `id="N"` attribute on the surrounding `<message>` tag.
- `language` is optional — pass an ISO-639-1 code (`"ru"`, `"en"`, …) only if the auto-detect picks the wrong language. Leave it off otherwise.
- The model is `whisper-large-v3-turbo` (Groq). Latency is typically under 2 s for short voice notes.

**When to call it:** any time the user's intent is in the audio. Don't ask them to re-type — just transcribe and respond. If the message has both caption text and audio, read both. If the user clearly only sent audio (no caption), the audio *is* the message — transcribe it.

**Do not** describe the audio file (size, format, etc.) instead of transcribing it. The user wants the words.
