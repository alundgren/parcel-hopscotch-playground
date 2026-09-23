# Guided help

The first experiment combines Notes on work with a Task trail. A stale review
offers to open the affected item. The person checks current evidence, performs
any available action, and returns to request a fresh review. An Audit guide
uses the same runtime to explain search and recorded results. Neither guide
prepares or accepts business changes.

The underlying stale-proposal checks are unchanged. In particular, an old
batch cannot apply its remaining entries after one order or stock reservation
changes. Guidance explains that rejection and helps the person continue.

## Ownership

`src/guidance` defines the serializable contract, bounded discovery, and pure
session transitions. It has no application imports. A module declares its
destinations, target IDs, instructions, availability, and expected result
names. Work and Audit export their declarations through their public
`index.ts` files. `src/modules/guidance.ts` composes them for this application.

The client registers the actual elements through React refs. Notes use those
refs to measure and outline a target. The model receives a small description
of visible targets and available destinations, with opaque references that
expire when the context changes. It does not receive customer evidence text,
DOM nodes, selectors, or screenshots as part of guidance context. Existing
read tools can retrieve business facts when the person asks for them.

The server validates identity, generation, module references, and problem
facts. It restricts guidance turns to read and guidance tools, including a
dispatcher check if a model requests a forbidden command anyway. Showing an
offer is distinct from accepting it. Show me is a local human action.

Proposal availability follows the review displayed in the initiating tab. The
server resolves that focused proposal under the current user's identity.
Registered disabled controls can reduce the advertised availability. Preparing
a different proposal in another tab must preserve agreement between the open
review and its guidance; a two-tab test covers this case.

## Adding a module

Use the Work and Audit public entries as examples, not as a second catalogue
to copy into prompts. Declare stable IDs once and use the exported values in
the real components. Compute relevant action availability once, then give
that result to the control and its registration.

Provide module-owned guide definitions and navigation handling through the
application composition. A new destination or result name must not require a
new business branch in the shared reducer. Declare whether a step waits for
a registered target, a new result, or the result previously bound to the
session. Bind the actual command response to the initiating guide before
reporting success. Broadcast workspace updates are not command completion.

Increment the guide version when a saved step would mean something different.
Invalid or incompatible saved data must stop safely. Reloaded continuations
start paused and require Resume; reset generations invalidate them. Store only
the current guide, correlation values, and return context in sessionStorage.

Add real component assertions for the target's entity, visibility, and
availability. Keep expected target names and behavior independent of the
declaration being tested. Also cover missing targets, manual navigation,
unrelated results, and return to an origin that has changed.

## Mechanical checks

`vp run check:guidance` resolves TypeScript imports, including aliases, type
imports, and dynamic imports with literal paths. The shared runtime cannot
import application code. The renderer receives application data and callbacks
instead of importing a command dispatcher. Other consumers must enter a
module through its public `index.ts`.

The unit tests deliberately attempt a forbidden import and deliver results
with the wrong entity, operation, context, session, or generation. Browser
tests check real registered controls and demonstrate the missing-target
fallback. End-to-end tests use a second tab to cause a stale review, then
exercise consent, local continuation, human actions, and fresh review.

As a negative control, removing the real Review change ref made the desktop
rendered journey fail at its Notes on work assertion. The exact source was
restored before the passing checks. That same assertion runs in CI.

Context serialization has a 3,072 UTF-8 byte ceiling, leaving room inside the
existing 4,096-byte tool-result limit for status and recovery information. Discovery returns at
most eight guides. The large-catalogue test uses 1,000 module definitions to
check that model-facing output remains bounded. These are byte and item
limits, not a model-specific token measurement. Positioning, step progress,
pause, resume, and return do not call a model.

The one-order context fixture measured 1,677 UTF-8 bytes for a stale stock
review and 1,502 bytes for Audit with its search target mounted. Real values
depend on the current targets and guide text; the ceiling is enforced for
both context and discovery output.

## Limits of the experiment

Modules run in one application today. The public values can cross a transport,
but this change does not implement remote module loading, cross-origin frames,
or compatibility negotiation between separately deployed modules. Context
assembly still runs in process. Profile it before introducing a global module
index or lazy remote discovery.

The client and server must be updated together because workspace summaries now
include a required resolved flag. Existing browser tabs should reload after
this version is deployed.

Continuation belongs to one browser tab and is not durable work history.
Closing the tab ends that continuation. The browser reports what it rendered;
the server still owns authorization and business facts. A reported visible
control does not grant permission to change data.

The test provider exercises tool selection and transport deterministically.
That proves the protocol and user flow, not the quality of every live-model
answer. The next small experiment is to ask a small live model to explain the
two stale-review cases and the Audit task, record completed-task time and
guidance-context bytes, and inspect whether it chooses the right registered
guide without inventing an action.
