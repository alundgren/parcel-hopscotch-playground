# Benchmark limit correction

The historical `manifest.json` records `constrainedMaximumOutputTokens: 64`. That field applied only to the constrained Ministral requests. The Jev Decisions request has no output-token parameter, so no Jev token cap was sent during the measured run. The raw manifest, attempts, report JSON, and generated report remain unchanged as the historical output.

Each Jev request contained one choice question. Consent requests supplied three choices; exception requests supplied seven. The production Jev adapter enforced a 32,768-byte request limit, a 262,144-byte response limit, and the benchmark's 20-second timeout. Benchmark concurrency remained one. The fixture parser also limited each evidence note to 500 characters.

Across the 12 retained Jev attempts, request bodies were 799–1,416 bytes, response bodies were 314–364 bytes, and reported output usage was 39–70 tokens. The 68–70-token outcomes show why the historical 64 value cannot describe a Jev output cap.

The current benchmark manifest names the 64-token limit `ministralConstrainedMaximumOutputTokens` and records `jevConstrainedMaximumOutputTokens` as `null`, together with the Jev question, choice, request-byte, response-byte, and timeout bounds. This reporting correction does not change fixture labels, measured outcomes, costs, or the single live run, and it does not require paid requests.
