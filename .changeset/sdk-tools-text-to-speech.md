---
'@theokit/sdk-tools': minor
---

`createTextToSpeechTool` adds a `text_to_speech` tool. The speech provider is the consumer's: the
factory takes a `synthesize(text)` callback that returns the encoded clip and its mime type, and
the tool holds no key and opens no socket. The clip is written atomically to a file under the
project root (`audio/` by default, created when absent), with the same path confinement and
secret-segment refusal as `view_image` and `read_file`. The model receives the relative path, the
mime type and the byte count, never the audio. Text over 4096 characters and clips over 10 MiB are
refused by default (`maxTextChars`, `maxAudioBytes`), as are unlisted mime types and empty audio;
every failure is a typed result and leaves no file behind.
