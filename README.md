![Parcel Hopscotch, an AI interface playground](docs/assets/readme-header.png)

# Parcel Hopscotch

A playground for fast AI as an alternative to the UI. Run the fulfilment desk at Bracken & Beam, a fictional homewares shop, by clicking or by asking the agent to find work, teach a task, and prepare changes for your approval.

The experiment compares Ministral conversation and tool use with Jev's constrained decisions through OpenRouter. Success means getting the work done quickly. Audit shows complete interaction timing, requests, responses, tokens, costs, and what happened in the app.

Implementation is in progress. The approved [interactive prototype](docs/design/approved-prototype.html), [build agreement](docs/build-agreement.md), [architecture](docs/architecture.md), and [visual guidance](ux.md) define the intended result.

Each user has their own seeded work and can reset it. Reset preserves audit history. Cloudflare Access controls access at the tunnel, and the app trusts its authenticated email header.

Licensed under [MIT](LICENSE).
