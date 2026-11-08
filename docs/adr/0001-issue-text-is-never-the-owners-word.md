# Issue text is never the owner's word

The decider treats an issue's text as a request to be judged, never as the owner stating what they want, even when the issue was filed under the owner's login. Only the vision of record and the owner's board answers on that ticket settle anything. Agents such as firstmate, wayfinder sessions and entail itself post under the owner's `gh` and `glab` login, so forge authorship cannot tell the owner from an agent, and treating it as the owner's word would let agents' words read as the owner's, which VISION.md says to resist.

## Consequences

- An owner-filed feature the vision is silent on is judged like anyone's: it is cleared if no vision line contradicts it, it touches no pin and its readings are not consequential (ADR-0011), and otherwise it comes back as a board item. Filing it under the owner's login never makes it go ahead.
- A `/entail` comment on someone else's issue means "judge this", not "I want this".
- Decided on [How does the decider reach a verdict on a ticket?](https://github.com/omkarbhale/entail/issues/19).
