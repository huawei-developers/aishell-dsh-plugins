# Architecture

The design of `aishell-dsh-plugins`: what it is, what it guarantees, and why each
guarantee is built the way it is.

This document describes the design, not the code. The implementation is one
realization of it — another would satisfy the same constraints. Where a
statement is a fact about the world rather than a choice (how the cloud behaves,
what a tool does when interrupted) it is marked as an observation, because it is
what the design has to hold against.

---

## 1. Purpose and scope

A set of plugins that give an AI agent the ability to operate Huawei Cloud
infrastructure: understand what exists, design a network, price it, build it,
and tear it down.

The design problem is not "call the cloud API". It is: **an agent that can
create and destroy billable infrastructure must be unable to do so by accident,
and unable to do so on a figure nobody verified.** Everything below serves that
sentence.

### What is in scope

- The plugin set, its composition into an installable bundle, and its lifecycle
  inside the host.
- The credential model that lets the plugins act on an account without ever
  holding the secret in a place a model can read.
- The deployment workflow: design → price → plan → apply, and the approvals
  between them.

### What is out of scope

- The host harness itself. It is a dependency with its own published contract;
  this design conforms to it rather than extending it.
- The cloud provider's API semantics. Those are observed facts this design
  holds against, not decisions it makes.
- The user interface beyond the contracts this design requires of it.

---

## 2. Design principles

These are invariants. A change that violates one is a design change, not a
refactor, and needs to be argued as one.

**P1 — The host is the authority on what a plugin is.**
Every capability is delivered as a plugin the host can mount and unmount. No
private protocol, no parallel lifecycle, no capability that only works when
something else is absent. A package that cannot be installed on its own is
broken regardless of how well the set works together.

**P2 — The agent proposes; a person disposes.**
Operations with irreversible or billable effect require a human decision that
no tool call, argument, or prompt can supply. The agent's reach is bounded by the
host's configuration, not by its own restraint.

**P3 — A secret is never in a place the agent can read.**
Not in a tool argument, not in a tool result, not in the configuration, not in
a settings document. The agent acts on an account; it does not possess it.

**P4 — A number that was not verified is not a number.**
The design prefers a stated gap to a guessed value. An unpriced resource, an
undrawn node, an unresolved connection each say "nobody knows". A wrong figure
says "somebody checked", and is worse than silence.

**P5 — Every approval is bound to what it approved.**
Consent is a fact about a specific artifact. Editing the artifact after the
approval does not inherit it. This is enforced structurally, not by policy.

**P6 — Degrade, do not fail, where the failure is environmental.**
A missing keyring, an unreachable service, a locked session are conditions, not
bugs. They change what the system can do, not whether it runs.

**P7 — The design is read before it is executed.**
Every irreversible step has a preview that shows the same artifact the step will
execute, so "what the user saw" and "what ran" are one object rather than two
computations that happen to agree.

---

## 3. System context

```
      person ──consent / configuration──┐
                                        ▼
  agent (host) ──tool calls──▶ [this plugin set] ──signed API calls──▶ Huawei Cloud
       │                            │                                      │
       └── reads the prompt ────────┘                                      │
                           credentials, cost, plan records                 │
                                        └──────────── terraform ────────────┘
```

Four parties, and the design depends on what each can and cannot do:

| Party | Can | Cannot |
|---|---|---|
| The person | approve, deny, switch the mode, enter credentials | be replaced by the agent |
| The agent | call tools, read what they return | change the mode, read a secret, skip a gate |
| The plugin set | act on the account, call the cloud, run terraform | decide on its own that an approval is unnecessary |
| The cloud | accept or reject an action, price a product | be trusted to have rejected an action the design should have |

The last row is the important one. A cloud that refuses a bad request is not a
substitute for a design that does not send it: the refusal arrives after the
money is spent or the resource is gone.

---

## 4. Logical architecture

Three layers, by responsibility rather than by location. The dependency
direction is one-way and is the design's only structural constraint.

```
        ┌──────────────────────────────────────┐
        │  Capability          what the agent  │
        │                      can ask for     │
        └───────────────┬──────────────────────┘
                        │ depends on
        ┌───────────────▼──────────────────────┐
        │  Domain              what the cloud  │
        │                      means here      │
        └───────────────┬──────────────────────┘
                        │ depends on
        ┌───────────────▼──────────────────────┐
        │  Foundation     secrets, signing,    │
        │                 the store            │
        └──────────────────────────────────────┘
```

**Capability** is the model-facing surface: tools, prompt contributions, and the
browser-facing routes. It translates a request into a domain operation and a
domain result into something a model can act on. It owns no policy of its own —
policy lives below it, where it cannot be argued around.

**Domain** holds the meaning: what a deployment is, what a configuration
declares, what a resource costs, what a plan will change. It is deliberately
free of ambient state — the same inputs give the same answer with no filesystem,
no cloud, no session. That is what makes the interesting decisions testable
against a description rather than against an account.

**Foundation** is what more than one component needs and none should own twice:
the credential store, and the request signer. It knows nothing about any
capability, which is why any number of capabilities can be added above it
without touching it.

The rule this enforces: **policy is never in the capability layer.** A tool may
not decide whether the mode permits it, whether the cost was approved, or
whether the design was checked. Those answers live below, so a tool cannot be
written that forgets to ask.

---

## 5. Composition and deployment

The set ships as a bundle, and every member also installs alone. That is not
convenience: it is what keeps each package honest about its declared
dependencies. A plugin that only works inside the bundle has undeclared
requirements.

The bundle has three powers over its members and over the host's defaults:

- **Include** a member's contribution.
- **Configure** a host default, for a decision the deployment makes differently.
- **Disable** a host capability the deployment replaces or does not offer.

Composition is declarative and regenerated, never hand-edited. The generated
forms are derived from one manifest, so the installed bundle cannot drift from
what the manifest says — an installation whose parts disagree with its manifest
is the failure this prevents.

A bundle override replaces a unit's configuration wholesale rather than merging
into it. That is deliberate: a partial override silently keeps a field the
override author did not consider, and the resulting state is one nobody wrote.

### The two overrides, and why they are design decisions

**Model default.** A deployment has one chat route, its own gateway. The host's
default routes elsewhere. The default therefore has to name the gateway, and it
names a stable alias rather than a catalogued model id.

The reason is a constraint, not a preference: the selection is read where no
catalogue lookup is possible, so a literal model id would pin every new session
to one catalogue entry. The day that entry is withdrawn, every session fails on
its first message until a new bundle ships. An alias the gateway guarantees
decouples the two, and lets the gateway repoint it without the bundle knowing.

**Telemetry destination.** Session feedback goes to the deployment's own
collector. The consequence is stated in the design rather than hidden: what
leaves the machine is not "a feedback record" but the complete unhanded session
prefix — message text, tool arguments and results, the system prompt, the
working directory. That is disclosed to the person before submission, which is
the condition under which the design accepts it.

**P2 and P3 apply to the design's own choices, not only to the agent's.**

---

## 6. Credential design

Split along one line: **how a secret is kept** is a different question from
**who is allowed to put one there**. Two components, and neither can answer the
other's question.

### The store: a seam, not a participant

The store is a library, not a plugin. It has no lifecycle and makes no policy
decisions. It exists so that persistence and signing are solved once rather than
per capability.

It owns two things:

- **A backend chain**, ordered by durability and reach: the OS keyring
  (durable, visible to other processes), a machine-bound encrypted file
  (durable, this machine only), process memory (volatile, last resort). The
  chain is probed, and a backend that cannot serve is skipped rather than fatal
  — a headless server has no desktop secret service, and that is a condition to
  work around, not a reason to refuse to run.

- **One signer.** Every plugin that talks to the cloud signs through it. One
  implementation of a security-relevant algorithm is the point; eight would be
  eight chances to differ.

Two properties make it a seam rather than a component:

*Callers never learn which backend answered.* A backend can be added to the
chain without a single caller changing.

*Nothing is cached above it.* A credential is resolved at the moment it is used,
so a rotation applies to the next operation and a revocation takes effect
immediately. There is no window in which a superseded secret still works — which
matters because the alternative is a security property that decays with time.

### The constraint the probe cannot see

**Observation.** A secret service can pass an availability probe and then reject
every real write — a keyring that is present but locked reads as absent and
refuses to store. The probe therefore answers "is it there", not "does it work".

This is the design's sharpest constraint, because it is invisible from the
outside: the system believes it has durable storage and every save fails.

The response is that the **write path has its own chain, and it is sticky.** A
per-call retry would surface the same refusal — or the same unlock prompt — once
per item a save writes, turning one environmental condition into a barrage. The
first refusal is the evidence; the chain commits to it for the rest of the
process.

Deletes use the same chain, because a save removes the old value before writing
the new one, and a locked store refuses both.

### Authority between copies

**Observation.** A locked store answers "absent" for entries that really are
there. So the durable copy's silence is not evidence of absence, and after it
unlocks its copy may be arbitrarily older than what was written elsewhere in the
meantime.

If recency decided, the design would be wrong in the worst direction: an
unlocked store would outrank the value the person saved while it was locked,
**resurrecting a credential its owner had already rotated or cleared**, and
every subsequent signature would use the superseded key.

Recency cannot decide, because neither copy records when it was written. So the
rule is authority by provenance:

> A copy that exists because a failover write put it there is newer than anything
> the primary holds, by construction. The primary answers only when the fallback
> has no opinion.

Deletion needs the same care. A clear whose primary delete failed leaves nothing
to shadow the stale primary, so it records an explicit tombstone — without one,
the old value reads back as present and the revocation is lost.

A successful primary write hands authority back. The fallback is a consequence of
a fault, not a permanent second source of truth.

### Ownership: the one place a secret is collected

A separate component owns the lifecycle. The store can persist; only this
component decides what may be persisted. The split is the design.

**The secret never enters configuration.** It is submitted over an authenticated
channel, verified, and only then stored. What crosses back into configuration is
non-secret: whether credentials exist, and the account name they belong to.

Two reasons, and the second is mechanical:

- A configuration document is readable by the agent and persisted in the
  profile; a secret there is a secret with a copy.
- Configuration edits run inside a transactional update. A write that fails
  inside one rolls back the whole document. Keeping secrets outside that
  transaction keeps the credential path outside a rollback it cannot survive.

**Verification gates storage, it does not audit it.** A pair is verified before
it is stored, so the store never holds something that will fail on first use.
The verification and the storage are one decision, not two.

**Observation.** The identity service is global: the region in its address only
selects a replica and does not scope the answer. A wrong region still verifies
successfully with the same account.

So verification does not validate the region, and must not appear to. Were the
two conflated, a mistyped region would be reported as "invalid credentials",
sending the person to re-enter a secret that was correct. The mismatch surfaces
where it means something — at the first region-scoped call.

**Status is derived, never pushed.** Whether the UI shows "configured" is a
function of what the store currently holds, reconciled rather than notified.
Nothing depends on an event arriving.

The two derived facts are independent by design: a process that starts with
credentials present must still reach the step that resolves and records the
account name, or the interface shows "unconfigured" until something unrelated
restarts it. Deriving both, every time, makes the recovery automatic.

---

## 7. Deployment design

The package that operates the cloud. One decision generates everything below:

> **What a deployment costs, and what it will do, are properties of the plan —
> not of the configuration text.**

A configuration text is a list of blocks. A plan is a list of resources. The two
differ wherever repetition, conditionality or composition appears, and only the
second is what will be built and billed.

### One definition of "the configuration"

Several parts of the design need to answer "what does this deployment declare":
the part that draws it, the part that checks it is a network, the part that
verifies its specifications exist, the part that detects change, and the part
that scans it for secrets.

If they answer differently, the disagreement is silent — and worse than silent,
because a gate that finds no network in a configuration that plainly has one
refuses a build on a technicality nobody can see.

So the answer is defined once and shared, and the definition is a design
statement rather than an implementation detail:

- **Both syntaxes the cloud's tooling accepts**, because it treats them as the
  same configuration. A design written in either is a design.
- **Local modules are part of it; downloaded ones are not.** A local module is
  what this deployment wrote, and editing it changes the plan. A downloaded
  module is a dependency, resolved from a third party.
- **A directory nothing references is not part of it**, even if it contains
  configuration. Nothing will be built from it.

### The approval chain

An irreversible operation is guarded by several independent questions, and each
exists because it can be answered "no" on its own:

| Question | Fails when |
|---|---|
| Does the configuration declare a network at all? | the design was never written, or only partially |
| Was that network checked? | the check never ran, or the design changed after it |
| Was a cost quoted for this configuration? | nothing was priced, or the configuration changed after pricing |
| Does the saved plan describe this configuration? | the plan is from a different configuration |
| Is there a plaintext secret in it? | a credential was written into the configuration |

The mechanism is **a digest of the configuration, not a timestamp and not a
flag.** A design edited after it was checked is not a checked design; a boolean
would have said it was. This is P5 expressed concretely.

The order matters: the cheapest and most fundamental question first, so a
failure names the earliest thing that is wrong rather than the last.

### Why the plan must be the executed artifact

**Observation.** The tooling will apply a saved plan whose configuration has
since changed, without complaint. Nothing in it checks that the plan still
describes the files on disk.

So the tie between "what was approved" and "what runs" can only be made by the
design. The decision is that the operation runs the **saved plan**, not a fresh
computation, and the digest is what establishes that the plan is current.

This is P7. A fresh computation at execution time would make the change set
computed twice, by two runs, from possibly two configurations — and the
difference would be invisible, because both succeed.

### A plan is spent once

**Observation.** The tooling refuses to apply the same plan twice, because the
state moved. But every digest-based approval still matches after a successful
operation, because applying does not change the configuration text.

Left alone, a second attempt passes every gate and then fails on the tooling's
own refusal — an error that names neither the gate nor the remedy, and arrives
after the user believed they were clear to proceed.

So a successful state-changing operation **consumes** what authorised it: the
plan and its record are spent, and the next attempt lands on "produce a new
plan", which is the action that actually needs to happen. Consumption applies to
every operation that changes state, not only the obvious one, because the
constraint is about state, not about which command ran.

### Preview and execution must be one artifact

**Observation.** A destroy computes its own plan if given the chance. A preview
and the destruction would then be two computations, and anything may change
between them.

So the preview saves an artifact that names the resources it covers, and the
destruction executes **that artifact** — refusing when the request covers a
different set or the configuration has moved. The approval is bound to a
specific list, not to the idea of destroying.

### Pricing: what it will and will not say

Pricing reads the plan, for the reason in §7's opening. Three rules follow:

**A price is per region.** A deployment may span several, so the region comes
from each resource's own provider configuration. A region the tooling has not
resolved — written as a value only known at run time — is reported, not filled
in. A default would be a guess that produces a figure indistinguishable from a
verified one.

**Classification is discovered, not tabulated.** The billing vocabulary is not
derivable from the infrastructure vocabulary. A small table covers the service
family; the product within a service is read from the provider's catalogue,
because a table of every product would be wrong within a release.

**Everything it cannot price is named.** A resource with no classification, a
specification that came from a variable, an image that does not identify a
platform — each is reported with the reason. This is P4.

The converse is also a design statement: a deployment that genuinely costs
nothing — a network, with nothing on it — must still be able to proceed. "No
charge" and "nothing priced" look identical and mean opposite things, so the
record states which one it is rather than leaving a reader to infer it from an
absence.

### The picture is a view, and says what it omits

The topology is derived from the configuration, so every drawn node is something
that will be created — the picture cannot drift from what runs.

What it does not draw is reported, by type. A deployment legitimately declares
monitoring rules, backups and key material beside its network, and a diagram is
read by comparing boxes: a box that represents nothing the reader is comparing
against is noise exactly where the signal has to fit.

**A connection is a relationship, not a device.** A peering, an endpoint or a
route has no location of its own; drawing it as a box would assert the network
contains something it does not. It is drawn as a labelled edge between the two
networks, which is how a reader asks the question.

---

## 8. Security design

### The read-only switch

The mode is out-of-band state: a person sets it, no tool reads it, and no tool
argument changes it. It is not a setting the agent can reason about, and it is
not persisted — a restart returns to the safe default, so a session that needs
write access must be granted it again.

Enforcement is at **two independent points**, because the capability layer
reaches the cloud by two paths that share no entry:

- Every signed request funnels through one client. Checking there covers every
  request the agent can compose, including an arbitrary method and URL, without
  each tool remembering to ask. This is why the check sits below the tools: a
  tool cannot be written that bypasses it.
- Operations that never make an HTTP request — the ones that shell out — are
  refused by identity at the registry.

**Default deny.** A request the registry does not recognise is refused. An
operation added to the provider tomorrow cannot become a permitted mutation by
being unknown. The asymmetry is the point: a false deny costs a rejected query
the operator can see and fix; a false permit is an unasked-for change to
production.

The design accepts a known cost: the registry's source covers less than the full
catalogue, so some legitimate reads are refused in read-only mode. That direction
is chosen deliberately, and the gap is recorded where it can be measured rather
than discovered.

### Where a signed request may go

A signed request carries the account's access key identifier in a header. That
makes the destination a security boundary, not a convenience check: a typo, a
hallucinated endpoint, or an injected instruction would otherwise hand the
credential to a third party.

So the destination is decided at the funnel, by an allowlist rather than a
warning: a specific domain, matched so that only real subdomains pass, and only
over a transport that does not put the key on the wire in cleartext.

### Secrets in configuration

Three independent measures, because any one of them can be bypassed:

1. **A scan** of the configuration for literal credentials, before the provider
   is fetched and again before anything is created. It reads both syntaxes —
   a pattern that finds an assignment in one syntax finds nothing in the other,
   so each is read in the form it is written.
2. **The environment** as the only channel through which the tooling receives
   credentials.
3. **The store** as the only place the pair persists.

A scan that only understands one syntax is not a weaker scan; it is a scan that
reports the other syntax clean. That distinction is the reason both are read
separately rather than by one generalized pattern.

---

## 9. Quality attributes

Each is a design goal with a mechanism, not an aspiration.

### Reliability

**Failure is classified by what a person should do next, not by where it
happened.** A policy refusal is not a transport failure; a credential the cloud
rejected is not a credential the cloud never received. Folding these together
sends a reader to fix the wrong thing — re-enter a correct secret, retry a rule,
or debug a network that is fine. The design separates them at the point of
failure, because that is the only place the distinction is still available.

**A terminated operation is a failure, not a success.** Observation: a process
killed by a signal has no exit status. A design that reads "no status" as
"success" reports a completed deployment that was actually interrupted
mid-creation — the one message that must never be wrong. So interruption is a
failure, and the reason is carried into what the caller sees.

**Budgets are layered and ordered.** There is a budget for the agent's wait, one
for a subprocess, one for a request, one for a download. Each answers a different
question and each has a different owner. The ordering is deliberate: the outer
budget is shorter than the inner one, so a cancellation is reported truthfully
while the inner limit is what stops a stalled process from surviving.

**A budget shorter than the work it bounds does not make the work safe** — it
reports a timeout on work that was still progressing.

### Testability

The design puts the interesting decisions in pure transforms: what a
configuration declares, whether a network is sound, what a resource costs, what a
plan changes. These take a description and return an answer, with no ambient
state, which is what makes them testable against a string rather than an account.

Verification spans more than one axis, and passing one says nothing about the
next: a change may typecheck and not run; may run and not work. Both are checked,
and the design records the difference (see §10).

### Maintainability

Analysis is separated from the side effects it needs, so a component that must
touch the world is one import away from violating the rule rather than eight.
Shared invariants live in the foundation, where changing them changes every
consumer at once — which is the point.

### Performance and cost

The scarce resource is the agent's context, not compute. Three consequences:

- **Responses are bounded and truncation is reported.** A prefix presented as a
  whole document is worse than a short answer, because the reader cannot tell
  which they have.
- **Summaries are the default; detail is requested.** The design reports what an
  operation will change, not the document that describes it, because the bulk of
  a machine-readable response is defaults nobody chose.
- **Queries are batched and cached for one operation.** The API prices many
  products per call; catalogues that do not change within an operation are read
  once and keyed by what they depend on.

A heavy dependency is instantiated once and released, because holding it costs
more than rebuilding it and the cost is per-process, not per-use.

---

## 10. Correctness as an operating rule

The design assumes its own reasoning is insufficient, and states three claims
that must be established separately:

1. **It typechecks.** A type system validates what the author declared, and
   nothing else.
2. **It runs.** Reasoning that a program is correct is not evidence that it is:
   an interface returns an unexpected shape, a process reports its failure
   differently than assumed, a library's types are broader than its runtime.
3. **It does the job.** A program that runs without error can still be wrong:
   a query returns the wrong rows, a renderer draws nothing, a guard approves
   everything.

Claim 2 is not a substitute for claim 3. Where the third cannot be established —
no way to reach the real system, no observable output — the change is reported
with what it affects and how it should be checked, rather than presented as
finished.

**This is why the design prefers a stated gap to a guessed value** (P4). The two
habits are the same habit: an unverified claim, like an unpriced resource, reads
as knowledge and is not.

---

## 11. Boundaries

A design is incomplete without them, and stating them is part of the design.

- **Not every service can be priced.** One class of charge is consumed rather
  than ordered: its cost is a function of storage volume and request counts
  accrued over time, not of a specification chosen up front. The pricing API
  prices an order; this is read from the bill instead. The design reports it as
  unpriceable rather than quoting one dimension and presenting it as the cost.
- **The read-only registry covers less than the catalogue.** Some services have
  no per-operation metadata to classify, so their non-read requests are refused
  in read-only mode even when they would be safe. The gap is recorded with what
  is known and how to extend it.
- **A listed product may not be priceable.** A catalogue can offer
  specifications whose billing item does not exist. A non-empty list is
  therefore not a promise; only a pricing response is.
- **The design does not sandbox the agent.** It bounds the agent's reach through
  its own tools and the mode. A resource reachable another way is out of scope,
  and the design says so rather than implying coverage it does not have.

---

## 12. Extension points

Where the design expects to be extended, and what extending it requires:

- **A new capability.** A plugin that declares its host dependencies, ships its
  own composition entry, and installs alone. It must not implement policy; it
  consumes the foundation and defers to the gates.
- **A new pricing service.** A classification for the service family, and the
  product within it read from the catalogue. A new service is added, never
  guessed.
- **A new transport or backend.** Added to the foundation's chain without a
  caller changing. That is what the seam is for.
- **A new approval.** Bound to an artifact and a digest, enforced below the
  capability layer, and consumed when the operation it authorised completes.

---

## Appendix: observations

Facts about the world this design is built against. They are not decisions, and
a future version of the platform may invalidate them.

| Observation | Consequence |
|---|---|
| A saved plan is applied without checking the configuration still matches | the digest is the only tie between approval and execution |
| A plan cannot be applied twice after state changes | the authorization must be consumed |
| A locked secret service reads as absent and refuses writes | writes need their own fallback chain, and authority is by provenance |
| The identity service does not scope its answer by region | verification must not validate the region |
| A process killed by a signal reports no exit status | interruption must be mapped to failure explicitly |
| A catalogue can list products with no billing item | a listed specification is not a priceable one |
| Regions sell different specifications | a price is per region, and a default is a guess |