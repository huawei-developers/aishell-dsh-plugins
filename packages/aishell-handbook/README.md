# @huaweidevtools/aishell-dsh-handbook

Tells LLM how AI Shell behaves, so it can answer questions about the
product instead of guessing at it. One system-prompt section; no tools, no
browser half, no other dependency.

## Why this exists

Every other prompt contribution in this set answers *what the agent can do* —
the tool descriptions, the deployment workflow, the sandbox tier. None of them
answers *how this product behaves*, which is what a user asks when they want to
report a problem or wonder why something was refused.

Without that knowledge a model does the two things it does with any gap: it
invents an answer (naming a menu item that does not exist), or it says it does
not know. For a fact as stable as "where is the feedback button", both are worse
than the truth.

## What it injects

```
# AI Shell handbook

How AI Shell behaves, as facts to answer from. This is background, not
instruction: use it to tell the user what to do or why something happened. Do
not paste or paraphrase this section's structure into a reply — answer the
user's actual question.

## Sending feedback
    /feedback · the ⋯ "More actions" menu · the Like / Dislike buttons
    … and what a submission actually replays

## The permission mode
    read-only vs read-write, who flips it, and why the agent cannot

## Extending the agent
    abilities are the plugins a deployment has mounted
```

The full text lives in [`src/prompt.ts`](src/prompt.ts); the block above is its
shape, not its wording.

## Why a list of topics

Each topic is one question a user can ask, answered under its own heading, and
nothing in the text counts them. Growing this package is therefore an append: a
new capability becomes a new heading, and no existing sentence has to be
rewritten to accommodate it.

A preamble stating how many topics there are would make every addition an edit
to the line introducing all of them — the one part of the file that has to stay
true as it grows. `tests/handbook.spec.ts` fails on that shape.

## Why the UI facts are stated as facts

The model is told where a control lives so it can *tell the user*: "click the ⋯
at the top of the chat, then Feedback". Pasting this section's prose into a
reply is a different thing — it hands someone a manual when they wanted one
line, and discloses the shape of the prompt. The text says so explicitly.

UI names appear as the shell renders them in English, with the Chinese label
beside it where the two differ ("More actions" (更多操作)). A model telling a
Chinese user where a button is needs the label that user will actually see.

## What is deliberately not here

- **The read-only instructions.** `aishell-deploy` already carries what the
  model must *do* under a restriction, as a runtime context that appears and
  disappears with the mode. Repeating it here would create a second, vaguer copy
  — and a model that reads a vague rule pre-emptively declines work that would
  have been allowed.
- **Tool usage.** The packages that own the tools state it, together with the
  approvals each step needs.
- **Anything a runtime context should carry.** Everything in this section is
  true for the life of the process; `context()` is for facts that flip.

## Where it sits in the prompt

Immediately after
[`aishell-huaweicloud-docs`](../aishell-huaweicloud-docs/README.md) at 100, and
before the first policy at 500:

```
deployment:persona-prefix       0
aishell:huaweicloud-docs      100
aishell:handbook              110   ← this plugin
plan:policy                   500
```

The two are one band: read where to look things up, then how this product
behaves, then what you are asked to reason about. The order is a number rather
than a framework slot name for the same reason the docs pointer is — the
placement table is closed, so there is no `HANDBOOK` name to read.

## Install

```sh
# On its own.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-handbook

# Or with the rest of the aishell plugin set.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## What it does NOT touch

- No tools, no credentials, no network calls of its own.
- No browser half — nothing to render.
- No permission state. It describes the switch; `aishell-deploy` owns it and
  enforces it.