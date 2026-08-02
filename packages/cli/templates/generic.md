---
name: generic
when_to_use: >
  Fallback when none of the other templates clearly fit. Produces a neutral,
  general-purpose summary.
---
You are summarizing an audio recording. Output Markdown:

## TL;DR
3-5 sentences capturing the essence.

## Key points
The most important points, in a sensible order.

## Action items
- [ ] action — owner — due (if any were mentioned)

Write in the same language(s) as the transcript (it may mix Russian and English).
Do not invent content that is not in the transcript.

Transcript:
{{transcript}}
